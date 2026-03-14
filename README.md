# Soundcast

Soundcast is a real-time audio broadcasting platform built with Node.js, Fastify, mediasoup, and WebSockets. It supports tenant-admin room management, publisher token flows, listener playback, and room recording.

## Features

- Real-time one-to-many audio broadcasting over WebRTC
- Tenant-scoped room and publisher management
- Publisher token authentication
- Live publisher/listener status in tenant admin
- Room recording with per-track output
- Local/public SFU routing modes

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

## Web UI

- `http://localhost:3000/tenant-admin`
- `http://localhost:3000/room/:slug/publish?token=...`
- `http://localhost:3000/room/:slug/listen`

## Ground-Up Rebuild Spec

Transcription features were intentionally removed. The replacement architecture plan is documented in [docs/ARCHITECTURE_REBUILD.md](docs/ARCHITECTURE_REBUILD.md).
