# Soundcast

Soundcast is a real-time audio broadcasting platform built with Node.js, Fastify, mediasoup, and WebSockets. It supports tenant-admin room management, publisher token flows, listener playback, and room recording.

## Features

- Real-time one-to-many audio broadcasting over WebRTC
- Tenant-scoped room and publisher management
- Publisher token authentication
- Live publisher/listener status in tenant admin
- Room recording with per-track output
- Live room transcription (MLX sidecar on macOS Apple Silicon)
- Embedded SFU signaling at `/ws` (client-derived `ws(s)://<host>/ws`)

## Architecture

- Backend: Fastify + mediasoup + SQLite (`better-sqlite3`)
- Frontend: static HTML/CSS/JavaScript served by the backend
- Signaling: WebSocket endpoints for publisher/listener/admin

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Configure `.env` (minimal example):

```bash
LISTEN_IP=0.0.0.0
ANNOUNCED_IP=127.0.0.1
PORT=3000
HTTPS_PORT=3001
SINGLE_TENANT=true
ADMIN_KEY=admin
```

3. Start the server:

```bash
npm run dev
# or
npm start
```

## Primary Endpoints

- `GET /api/config`
- `GET|POST|PUT|DELETE /api/rooms...`
- `GET|POST|PUT|DELETE /api/rooms/:room_slug/publishers...`
- `POST /api/rooms/:room_slug/recordings/start`
- `POST /api/rooms/:room_slug/recordings/stop`
- `GET /api/rooms/:room_slug/recordings/status`
- `GET /api/rooms/:room_slug/recordings`
- `GET /api/rooms/:room_slug/transcriptions/current`
- `GET /api/rooms/:room_slug/transcriptions/channels/:channel_name`

## Web UI

- `http://localhost:3000/tenant-admin`
- `http://localhost:3000/room/:slug/publish?token=...`
- `http://localhost:3000/room/:slug/listen`

## MLX Transcription Sidecar (Local)

For live transcription, start the sidecar:

```bash
cd asr-sidecar
./start.sh
```

Auto-restart on crash (macOS `launchd`):

```bash
./scripts/manage-transcription-sidecar-launchd.sh install
./scripts/manage-transcription-sidecar-launchd.sh status
./scripts/manage-transcription-sidecar-launchd.sh logs
```

Backend defaults:
- `TRANSCRIPTION_SIDECAR_URL=http://127.0.0.1:8765`
- `TRANSCRIPTION_MODEL=mlx-community/Qwen3-ASR-0.6B-8bit`

Current scope:
- transcription is enabled only on macOS Apple Silicon when sidecar health is ready
- recording works cross-platform

## Ground-Up Rebuild Spec

Transcription features were intentionally removed. The replacement architecture plan is documented in [docs/ARCHITECTURE_REBUILD.md](docs/ARCHITECTURE_REBUILD.md).
