# Soundcast MLX ASR Sidecar

This service exposes a local transcription API for Soundcast using:
- `mlx-audio`
- `mlx-community/Qwen3-ASR-0.6B-8bit`

## Endpoints

- `GET /health` readiness (loads model on first access)
- `POST /api/v1/transcribe/stream` NDJSON stream:
  - emits `{"type":"partial","text":"..."}`
  - ends with `{"type":"final","text":"..."}`

## Run

```bash
cd asr-sidecar
./start.sh
```

By default it listens on `http://127.0.0.1:8765`.

## Env

- `ASR_MODEL_ID` (default `mlx-community/Qwen3-ASR-0.6B-8bit`)
- `HOST` (default `0.0.0.0`)
- `PORT` (default `8765`)
