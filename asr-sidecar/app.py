#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from threading import Lock
from typing import Iterable

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from mlx_audio.stt import load as load_stt

APP_TITLE = "Soundcast MLX ASR Sidecar"
MODEL_ID = os.getenv("ASR_MODEL_ID", "mlx-community/Qwen3-ASR-0.6B-8bit")
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8765"))

app = FastAPI(title=APP_TITLE)

_model = None
_model_error: str | None = None
_model_lock = Lock()


def get_model():
    global _model, _model_error
    if _model is not None:
        return _model

    with _model_lock:
        if _model is not None:
            return _model
        try:
            _model = load_stt(MODEL_ID)
            _model_error = None
            return _model
        except Exception as exc:  # noqa: BLE001
            _model_error = str(exc)
            raise


@app.get("/health")
async def health():
    try:
        get_model()
        return {"ready": True, "model": MODEL_ID}
    except Exception:  # noqa: BLE001
        return JSONResponse(
            {"ready": False, "model": MODEL_ID, "reason": _model_error or "model load failed"},
            status_code=503,
        )


def stream_transcription_lines(file_path: Path, language: str) -> Iterable[str]:
    model = get_model()
    partial_tokens: list[str] = []
    final_text: str = ""

    for chunk in model.stream_transcribe(str(file_path), language=language):
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
            final_text = token_text.strip() or "".join(partial_tokens).strip()
        elif token_text:
            partial_tokens.append(token_text)

    if not final_text:
        final_text = "".join(partial_tokens).strip()
    yield json.dumps({"type": "final", "text": final_text}) + "\n"


@app.post("/api/v1/transcribe/stream")
async def transcribe_stream(
    audio: UploadFile = File(...),
    language: str = Form("English"),
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
            for line in stream_transcription_lines(tmp_path, language):
                yield line
        finally:
            try:
                tmp_path.unlink(missing_ok=True)
            except Exception:
                pass

    return StreamingResponse(_generator(), media_type="application/x-ndjson")


@app.get("/")
async def root():
    return {"name": APP_TITLE, "model": MODEL_ID, "health": "/health"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT)
