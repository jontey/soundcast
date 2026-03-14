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

## Auto-Restart On Crash (macOS)

From repo root:

```bash
./scripts/manage-transcription-sidecar-launchd.sh install
```

Useful commands:

```bash
./scripts/manage-transcription-sidecar-launchd.sh status
./scripts/manage-transcription-sidecar-launchd.sh logs
./scripts/manage-transcription-sidecar-launchd.sh restart
./scripts/manage-transcription-sidecar-launchd.sh uninstall
```

## Env

- `ASR_MODEL_ID` (default `mlx-community/Qwen3-ASR-0.6B-8bit`)
- `HOST` (default `0.0.0.0`)
- `PORT` (default `8765`)
