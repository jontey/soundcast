#!/usr/bin/env python3
from __future__ import annotations

import asyncio
import json
import os
import queue
import re
import select
import tempfile
import threading
import time
from pathlib import Path
from threading import Lock, Thread
from typing import Iterable

import numpy as np
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from mlx_audio.stt import load as load_stt

APP_TITLE = "Soundcast MLX ASR Sidecar"
MODEL_ID = os.getenv("ASR_MODEL_ID", "mlx-community/Qwen3-ASR-0.6B-8bit")
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8765"))
FIFO_PATH = os.getenv("FIFO_PATH", "").strip() or None

# Audio format expected on the FIFO: 16-bit signed PCM, 16 kHz, mono.
FIFO_SAMPLE_RATE = int(os.getenv("FIFO_SAMPLE_RATE", "16000"))
FIFO_CHANNELS = int(os.getenv("FIFO_CHANNELS", "1"))
FIFO_BYTES_PER_SAMPLE = int(os.getenv("FIFO_BYTES_PER_SAMPLE", "2"))
FIFO_READ_SIZE = int(os.getenv("FIFO_READ_SIZE", "6400"))  # 200ms at 16kHz/16bit/mono

# How often (in seconds) to run inference on accumulated FIFO audio.
FIFO_TRANSCRIBE_INTERVAL = float(os.getenv("FIFO_TRANSCRIBE_INTERVAL", "1.0"))
# Minimum accumulated audio (seconds) before first transcription.
FIFO_MIN_AUDIO_SECONDS = float(os.getenv("FIFO_MIN_AUDIO_SECONDS", "1.0"))
# Sliding window: keep at most this many seconds of audio to bound reprocessing cost.
FIFO_MAX_AUDIO_SECONDS = float(os.getenv("FIFO_MAX_AUDIO_SECONDS", "60.0"))
# How long to wait for the FIFO writer to appear before giving up.
FIFO_OPEN_TIMEOUT = float(os.getenv("FIFO_OPEN_TIMEOUT", "30.0"))

app = FastAPI(title=APP_TITLE)

_model_error: str | None = None
_model_lock = Lock()
_inference_lock = Lock()
_thread_local_model = threading.local()


def get_model():
    """Return an MLX model bound to the current thread."""
    global _model_error
    if getattr(_thread_local_model, "model", None) is not None:
        return _thread_local_model.model
    with _model_lock:
        if getattr(_thread_local_model, "model", None) is not None:
            return _thread_local_model.model
        try:
            _thread_local_model.model = load_stt(MODEL_ID)
            _model_error = None
            return _thread_local_model.model
        except Exception as exc:  # noqa: BLE001
            _model_error = str(exc)
            raise


class FifoSession:
    """State for one FIFO-based streaming transcription session."""

    def __init__(self, fifo_path: str, language: str | None):
        self.fifo_path = fifo_path
        self.language = language
        self.audio_buffer = bytearray()
        self.lock = Lock()
        self.running = True
        self.fd: int | None = None
        self.last_activity_at = time.monotonic()
        self.last_text = ""
        self.final_text_sent = ""
        self.first_transcription_done = False
        self.error: str | None = None
        self.queue: queue.Queue[dict | None] = queue.Queue()

    def close(self):
        self.running = False
        if self.fd is not None:
            try:
                os.close(self.fd)
            except Exception:
                pass
            self.fd = None


def sanitize_asr_text(text: str | None) -> str:
    if not text:
        return ""
    cleaned = str(text)
    cleaned = re.sub(r"<asr_text>", "", cleaned, flags=re.IGNORECASE)
    cleaned = cleaned.replace("\ufffd", "")
    cleaned = cleaned.replace("\r", "")
    cleaned = re.sub(r"[ \t]+\n", "\n", cleaned)
    return cleaned.strip()


def pcm_bytes_to_float32(data: bytes, sample_rate: int, channels: int) -> np.ndarray:
    """Convert raw PCM bytes to a mono float32 numpy array normalized to [-1, 1]."""
    if not data:
        return np.array([], dtype=np.float32)
    samples = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        # De-interleave and average to mono.
        samples = samples.reshape(-1, channels).mean(axis=1)
    return samples


def run_transcription(audio_bytes: bytes, language: str | None) -> list[dict]:
    """Run mlx-audio inference on a PCM buffer and return emitted token events."""
    if not audio_bytes:
        return []

    model = get_model()
    samples = pcm_bytes_to_float32(audio_bytes, FIFO_SAMPLE_RATE, FIFO_CHANNELS)
    if len(samples) < 160:  # ~10ms minimum
        return []

    kwargs = {"language": language} if language else {}
    events = []
    with _inference_lock:
        # chunk_duration controls internal chunking; min_chunk_duration prevents
        # tiny trailing chunks. Both are in seconds.
        for chunk in model.stream_transcribe(
            samples,
            chunk_duration=FIFO_TRANSCRIBE_INTERVAL * 2,
            min_chunk_duration=FIFO_TRANSCRIBE_INTERVAL,
            **kwargs,
        ):
            text = sanitize_asr_text(getattr(chunk, "text", None))
            is_final = bool(getattr(chunk, "is_final", False))
            if text or is_final:
                events.append(
                    {
                        "type": "final" if is_final else "partial",
                        "text": text,
                        "start_time": float(getattr(chunk, "start_time", 0.0)),
                        "end_time": float(getattr(chunk, "end_time", 0.0)),
                        "language": getattr(chunk, "language", None) or language,
                    }
                )
    return events


def _fifo_reader_thread(session: FifoSession):
    """Background thread that reads PCM from the FIFO and enqueues transcription events."""
    try:
        deadline = time.monotonic() + FIFO_OPEN_TIMEOUT
        while session.running and time.monotonic() < deadline:
            try:
                # Open read end. O_NONBLOCK lets us poll; a FIFO open for reading
                # returns immediately only once a writer has also opened it, but
                # with O_NONBLOCK an open-without-writer may succeed depending on
                # platform. We then use select() to wait for data.
                session.fd = os.open(session.fifo_path, os.O_RDONLY | os.O_NONBLOCK)
                break
            except FileNotFoundError:
                time.sleep(0.1)
            except OSError:
                time.sleep(0.1)

        if session.fd is None:
            session.error = f"FIFO not found or writer did not connect: {session.fifo_path}"
            session.queue.put_nowait(None)
            return

        audio_buffer = bytearray()
        last_transcribe_at = time.monotonic()
        writer_connected = False

        while session.running:
            ready, _, _ = select.select([session.fd], [], [], 0.2)
            if ready:
                try:
                    chunk = os.read(session.fd, FIFO_READ_SIZE)
                except OSError:
                    # FIFO may have been closed or removed underneath us.
                    break
                if not chunk:
                    # Writer closed the FIFO.
                    break
                if chunk:
                    writer_connected = True
                    audio_buffer.extend(chunk)
                    session.last_activity_at = time.monotonic()

            audio_seconds = len(audio_buffer) / (
                FIFO_SAMPLE_RATE * FIFO_CHANNELS * FIFO_BYTES_PER_SAMPLE
            )
            now = time.monotonic()
            # Only run inference after we have seen at least one writer chunk;
            # this prevents repeatedly transcribing silence before ffmpeg connects.
            should_transcribe = (
                writer_connected
                and session.running
                and audio_seconds >= FIFO_MIN_AUDIO_SECONDS
                and (now - last_transcribe_at) >= FIFO_TRANSCRIBE_INTERVAL
            )

            if should_transcribe:
                # Sliding window: drop old audio to bound reprocessing cost.
                max_bytes = int(
                    FIFO_MAX_AUDIO_SECONDS
                    * FIFO_SAMPLE_RATE
                    * FIFO_CHANNELS
                    * FIFO_BYTES_PER_SAMPLE
                )
                if len(audio_buffer) > max_bytes:
                    audio_buffer = audio_buffer[-max_bytes:]

                events = run_transcription(bytes(audio_buffer), session.language)
                for event in events:
                    session.queue.put_nowait(event)
                last_transcribe_at = now

        # Flush final transcription.
        if audio_buffer:
            events = run_transcription(bytes(audio_buffer), session.language)
            for event in events:
                session.queue.put_nowait(event)

    except Exception as exc:  # noqa: BLE001
        session.error = str(exc)
    finally:
        session.close()
        session.queue.put_nowait(None)


@app.get("/health")
async def health():
    try:
        get_model()
        payload = {"ready": True, "model": MODEL_ID}
        if FIFO_PATH:
            payload["fifo_path"] = FIFO_PATH
            payload["fifo_mode"] = True
        return payload
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(
            {"ready": False, "model": MODEL_ID, "reason": _model_error or f"model load failed: {exc}"},
            status_code=503,
        )


def stream_transcription_lines(file_path: Path, language: str | None) -> Iterable[str]:
    model = get_model()
    partial_tokens: list[str] = []
    final_text: str = ""

    kwargs = {"language": language} if language else {}
    stream_fn = getattr(model, "stream_transcribe", None)
    transcribe_fn = getattr(model, "transcribe", None)
    generate_fn = getattr(model, "generate", None)

    if not callable(stream_fn) and not callable(transcribe_fn) and not callable(generate_fn):
        raise RuntimeError("Model does not expose stream_transcribe(), transcribe(), or generate()")

    # NOTE: mlx-audio inference can segfault under concurrent stream_transcribe calls
    # on the same model instance. Serialize inference requests for stability.
    with _inference_lock:
        if callable(stream_fn):
            for chunk in stream_fn(str(file_path), **kwargs):
                # mlx-audio returns StreamingResult objects; keep only text payloads.
                token_text = getattr(chunk, "text", None)
                is_final = bool(getattr(chunk, "is_final", False))

                if token_text is None and isinstance(chunk, dict):
                    token_text = chunk.get("text", "")
                    is_final = bool(chunk.get("is_final", is_final))

                if token_text is None:
                    token_text = str(chunk)

                token_text = str(token_text)
                if token_text:
                    yield json.dumps({"type": "partial", "text": token_text}) + "\n"

                if is_final:
                    final_text = sanitize_asr_text(token_text) or sanitize_asr_text("".join(partial_tokens))
                elif token_text:
                    partial_tokens.append(token_text)
        else:
            # Some models only expose non-streaming transcribe()/generate().
            output = None
            errors: list[str] = []
            call_variants = [
                lambda: transcribe_fn(str(file_path), **kwargs),
                lambda: transcribe_fn(audio=str(file_path), **kwargs),
                lambda: transcribe_fn(path=str(file_path), **kwargs),
                lambda: transcribe_fn(file=str(file_path), **kwargs),
                lambda: transcribe_fn(str(file_path)),
                lambda: transcribe_fn(audio=str(file_path)),
                lambda: transcribe_fn(path=str(file_path)),
                lambda: transcribe_fn(file=str(file_path)),
                lambda: generate_fn(str(file_path), stream=False, **kwargs),
                lambda: generate_fn(audio=str(file_path), stream=False, **kwargs),
                lambda: generate_fn(path=str(file_path), stream=False, **kwargs),
                lambda: generate_fn(file=str(file_path), stream=False, **kwargs),
                lambda: generate_fn(str(file_path), stream=False),
                lambda: generate_fn(audio=str(file_path), stream=False),
                lambda: generate_fn(path=str(file_path), stream=False),
                lambda: generate_fn(file=str(file_path), stream=False),
            ]
            for call in call_variants:
                try:
                    output = call()
                    break
                except Exception as exc:  # noqa: BLE001
                    errors.append(str(exc))
            if output is None:
                raise RuntimeError(f"Failed transcribe() invocation variants: {' | '.join(errors[:3])}")
            text = ""
            # Some models return list[STTOutput] for batch size 1.
            if isinstance(output, list) and output:
                output = output[0]
            if isinstance(output, dict):
                text = (
                    output.get("text")
                    or output.get("transcript")
                    or output.get("output_text")
                    or output.get("generated_text")
                    or ""
                )
            else:
                text = (
                    getattr(output, "text", None)
                    or getattr(output, "transcript", None)
                    or getattr(output, "output_text", None)
                    or getattr(output, "generated_text", None)
                    or str(output)
                )
            final_text = sanitize_asr_text(text)
            if final_text:
                yield json.dumps({"type": "partial", "text": final_text}) + "\n"

    if not final_text:
        final_text = sanitize_asr_text("".join(partial_tokens))
    yield json.dumps({"type": "final", "text": final_text}) + "\n"


@app.post("/api/v1/transcribe/stream")
async def transcribe_stream(
    audio: UploadFile = File(...),
    language: str | None = Form(None),
    model: str = Form(MODEL_ID),
):
    if model != MODEL_ID:
        return JSONResponse(
            {"error": f"Unsupported model '{model}'. This sidecar is pinned to '{MODEL_ID}'."},
            status_code=400,
        )

    payload = await audio.read()
    if not payload:
        return JSONResponse({"error": "Empty audio payload"}, status_code=400)

    suffix = Path(audio.filename or "audio.ogg").suffix or ".ogg"
    with tempfile.NamedTemporaryFile(prefix="soundcast-segment-", suffix=suffix, delete=False) as tmp:
        tmp_path = Path(tmp.name)
        tmp.write(payload)

    def _generator():
        try:
            selected_language = language.strip() if isinstance(language, str) else None
            for line in stream_transcription_lines(tmp_path, selected_language or None):
                yield line
        except Exception as exc:  # noqa: BLE001
            # Keep wire contract stable even on provider/model failures.
            err = sanitize_asr_text(str(exc))
            if err:
                yield json.dumps({"type": "error", "error": err}) + "\n"
            yield json.dumps({"type": "final", "text": ""}) + "\n"
        finally:
            try:
                tmp_path.unlink(missing_ok=True)
            except Exception:
                pass

    return StreamingResponse(_generator(), media_type="application/x-ndjson")


@app.get("/api/v1/transcribe/sse")
async def transcribe_sse(fifo_path: str | None = None, language: str | None = None):
    """
    Server-Sent Events endpoint for real-time transcription from a named pipe.

    Node creates a FIFO, starts an ffmpeg PCM writer, then connects here.
    The sidecar reads PCM from the FIFO, runs inference periodically, and
    pushes partial/final tokens as SSE events.
    """
    target_fifo = fifo_path or FIFO_PATH
    if not target_fifo:
        return JSONResponse(
            {"error": "No FIFO path provided. Pass ?fifo_path=... or set FIFO_PATH env var."},
            status_code=400,
        )

    if not os.path.exists(target_fifo):
        return JSONResponse(
            {"error": f"FIFO does not exist: {target_fifo}"},
            status_code=404,
        )

    session = FifoSession(target_fifo, language)

    async def _event_generator():
        reader = Thread(target=_fifo_reader_thread, args=(session,), daemon=True)
        reader.start()

        try:
            while True:
                # Pull events from the thread-safe queue without blocking the
                # event loop. A short timeout lets us periodically check whether
                # the reader has stopped.
                try:
                    event = await asyncio.get_event_loop().run_in_executor(
                        None, lambda: session.queue.get(timeout=1.0)
                    )
                except queue.Empty:
                    if not session.running:
                        break
                    continue
                if event is None:
                    break
                data = json.dumps(event)
                yield f"data: {data}\n\n"
        finally:
            session.running = False
            session.close()
            reader.join(timeout=2.0)

    return StreamingResponse(
        _event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/")
async def root():
    return {"name": APP_TITLE, "model": MODEL_ID, "health": "/health"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT)
