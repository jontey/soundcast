# Air-Gapped Single-Tenant Deployment

This guide covers deploying SoundCast in an air-gapped (offline) environment with single-tenant mode.

## Overview

In single-tenant mode:
- A default tenant is auto-created on first startup
- Admin UI auto-logs in with the default API key
- No internet connection required
- Uses the embedded mediasoup SFU (no separate SFU server needed)

## Quick Start with Docker

### 1. Build the Docker Image

```bash
docker build -t soundcast-local .
```

### 2. Set Your Network IP

Find your server's LAN IP address:

```bash
# Linux/macOS
ip addr show | grep "inet " | grep -v 127.0.0.1

# or
hostname -I
```

Export it:

```bash
export HOST_IP=192.168.1.100  # Replace with your actual IP
```

### 3. Run the Container

```bash
docker run -d \
  --name soundcast \
  -p 3000:3000 \
  -p 40000-40100:40000-40100/udp \
  -e SINGLE_TENANT=true \
  -e ADMIN_KEY=admin \
  -e ANNOUNCED_IP=$HOST_IP \
  -v soundcast-data:/app/data \
  soundcast-local
```

Or using docker-compose:

```bash
HOST_IP=192.168.1.100 docker-compose up -d
```

### 4. Access the Admin UI

Open in browser:
```
http://192.168.1.100:3000/tenant-admin
```

The admin UI will auto-login in single-tenant mode.

## Creating a Room

1. Click "Create Room"
2. Fill in:
   - **Name**: e.g., "Conference Room"
   - **Use Local SFU Only**: Leave unchecked (uses embedded SFU)
   - **SFU URL**: Auto-filled to `ws://<your-ip>:3000/ws`
   - **TURN/STUN Config**: For same-subnet LAN, use `[]` (empty array)

3. Click "Create Room"

## Adding a Publisher

1. Find your room in the list
2. Click "Add Publisher"
3. Enter a channel name (e.g., "main")
4. Copy the generated publisher URL

## Accessing Audio

- **Publisher URL**: `http://<ip>:3000/room/<slug>/publish?token=<token>`
- **Listener URL**: `http://<ip>:3000/room/<slug>/listen`

## ICE Configuration for Air-Gapped Networks

For fully air-gapped networks on the same LAN subnet:

```json
[]
```

No STUN/TURN servers are needed when all clients are on the same subnet.

For clients across different subnets (but still local network), you may need a local TURN server.

## Transferring to Air-Gapped System

If your target environment has no internet:

### Option 1: Docker Image Transfer (Recommended)

```bash
# On internet-connected machine
docker build -t soundcast-local .
docker save soundcast-local -o soundcast-local.tar

# Transfer soundcast-local.tar to air-gapped system (USB, etc.)

# On air-gapped system
docker load -i soundcast-local.tar
docker run -d \
  --name soundcast \
  -p 3000:3000 \
  -p 40000-40100:40000-40100/udp \
  -e SINGLE_TENANT=true \
  -e ANNOUNCED_IP=192.168.1.100 \
  -v soundcast-data:/app/data \
  soundcast-local
```

### Option 2: Node.js Direct

If you have Node.js available on the target:

1. Copy the entire project directory
2. Ensure Node.js 22+ is installed
3. Run:

```bash
npm install
SINGLE_TENANT=true ANNOUNCED_IP=192.168.1.100 node src/server.js
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SINGLE_TENANT` | `false` | Enable single-tenant auto-bootstrap |
| `ADMIN_KEY` | `admin` | API key for the default tenant |
| `ANNOUNCED_IP` | `127.0.0.1` | Your server's LAN IP (for WebRTC) |
| `PORT` | `3000` | HTTP server port |
| `DB_PATH` | `./soundcast.db` | SQLite database path |
| `RTC_MIN_PORT` | `40000` | WebRTC UDP port range start |
| `RTC_MAX_PORT` | `40100` | WebRTC UDP port range end |

## Troubleshooting

### No audio between publisher and listener

1. Verify `ANNOUNCED_IP` is set to the correct LAN IP
2. Ensure UDP ports 40000-40100 are not blocked by firewall
3. Check that both clients can reach the server IP

### Cannot connect to WebSocket

1. Use `http://` not `https://` for local deployments
2. Verify the server is running: `curl http://<ip>:3000/api/config`

### Database errors

Ensure the data directory is writable:
```bash
docker exec soundcast ls -la /app/data
```

## Security Note

Single-tenant mode exposes the API key via `/api/config`. This is intentional for ease of use in air-gapped environments. For production deployments with security requirements, use multi-tenant mode with proper API key management.
