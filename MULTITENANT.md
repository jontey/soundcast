# Soundcast Multi-Tenant API Documentation

This document describes the multi-tenant features of Soundcast, including the REST API for managing rooms and the WebSocket protocol for client connections.

## Table of Contents

- [Overview](#overview)
- [Database Schema](#database-schema)
- [Authentication](#authentication)
- [REST API](#rest-api)
- [WebSocket Protocol](#websocket-protocol)
- [Getting Started](#getting-started)

## Overview

Soundcast now supports multi-tenant architecture, allowing multiple organizations (tenants) to manage their own rooms with dynamic media routing. Key features include:

- **Tenant Management**: Each tenant has their own API key for authentication
- **Room Management**: Create and manage rooms with custom SFU and TURN/STUN configurations
- **Interpreter Support**: Add interpreters to rooms with secure, single-use join tokens
- **Dynamic Routing**: Route media to local or public SFU instances based on room configuration

## Database Schema

### Tenants
```sql
CREATE TABLE tenants (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    api_key_hash TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### Rooms
```sql
CREATE TABLE rooms (
    id INTEGER PRIMARY KEY,
    tenant_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    is_local_only BOOLEAN NOT NULL DEFAULT 0,
    sfu_url TEXT NOT NULL,
    coturn_config_json TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
```

### Interpreters
```sql
CREATE TABLE interpreters (
    id INTEGER PRIMARY KEY,
    room_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    target_language TEXT NOT NULL,
    join_token_hash TEXT NOT NULL UNIQUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (room_id) REFERENCES rooms(id)
);
```

## Authentication

All REST API endpoints require Bearer token authentication using the tenant's API key:

```
Authorization: Bearer <your-api-key>
```

## REST API

### Base URL
```
http://localhost:3000/api
```

### Create Room

**POST** `/api/rooms`

Creates a new room for the authenticated tenant.

**Request Body:**
```json
{
  "name": "Annual Shareholder Meeting",
  "is_local_only": true,
  "sfu_url": "ws://192.168.1.5:8080/ws",
  "coturn_config_json": "[{\"urls\": \"stun:stun.l.google.com:19302\"}]"
}
```

**Response (201 Created):**
```json
{
  "id": 101,
  "name": "Annual Shareholder Meeting",
  "slug": "annual-shareholder-meeting-101",
  "is_local_only": true
}
```

**Error Responses:**
- `400 Bad Request`: Missing required fields or invalid JSON
- `401 Unauthorized`: Invalid or missing API key
- `409 Conflict`: Room name already exists for this tenant

---

### Update Room

**PUT** `/api/rooms/:room_slug`

Updates an existing room's configuration.

**Request Body:**
```json
{
  "name": "Annual Shareholder Meeting (Updated)",
  "is_local_only": false,
  "sfu_url": "wss://sfu.public.com/ws",
  "coturn_config_json": "[{\"urls\": \"turn:turn.public.com:3478\", \"username\": \"user\", \"credential\": \"pass\"}]"
}
```

**Response (200 OK):**
```json
{
  "id": 101,
  "name": "Annual Shareholder Meeting (Updated)",
  "slug": "annual-shareholder-meeting-updated-101",
  "is_local_only": false,
  "sfu_url": "wss://sfu.public.com/ws",
  "coturn_config_json": "[{\"urls\": \"turn:turn.public.com:3478\", \"username\": \"user\", \"credential\": \"pass\"}]"
}
```

**Error Responses:**
- `400 Bad Request`: Invalid request body
- `401 Unauthorized`: Invalid or missing API key
- `403 Forbidden`: Room belongs to another tenant
- `404 Not Found`: Room not found

---

### Get Room

**GET** `/api/rooms/:room_slug`

Retrieves details for a specific room.

**Response (200 OK):**
```json
{
  "id": 101,
  "name": "Annual Shareholder Meeting",
  "slug": "annual-shareholder-meeting-101",
  "is_local_only": true,
  "sfu_url": "ws://192.168.1.5:8080/ws",
  "coturn_config_json": "[{\"urls\": \"stun:stun.l.google.com:19302\"}]",
  "created_at": "2025-01-15T10:30:00.000Z"
}
```

---

### List Rooms

**GET** `/api/rooms`

Lists all rooms for the authenticated tenant.

**Response (200 OK):**
```json
{
  "rooms": [
    {
      "id": 101,
      "name": "Annual Shareholder Meeting",
      "slug": "annual-shareholder-meeting-101",
      "is_local_only": true,
      "created_at": "2025-01-15T10:30:00.000Z"
    }
  ]
}
```

---

### Add Interpreter

**POST** `/api/rooms/:room_slug/interpreters`

Creates a new interpreter for a room and returns a single-use join token.

**Request Body:**
```json
{
  "name": "Maria Rodriguez",
  "target_language": "es"
}
```

**Response (201 Created):**
```json
{
  "id": 55,
  "room_slug": "annual-shareholder-meeting-101",
  "name": "Maria Rodriguez",
  "target_language": "es",
  "join_token": "a1b2c3d4e5f6g7h8"
}
```

**Important:** The `join_token` is only returned in this response and cannot be retrieved later. Save it securely.

**Error Responses:**
- `400 Bad Request`: Missing required fields
- `401 Unauthorized`: Invalid or missing API key
- `403 Forbidden`: Room belongs to another tenant
- `404 Not Found`: Room not found

---

### List Interpreters

**GET** `/api/rooms/:room_slug/interpreters`

Lists all interpreters for a room (tokens are not included).

**Response (200 OK):**
```json
{
  "interpreters": [
    {
      "id": 55,
      "name": "Maria Rodriguez",
      "target_language": "es",
      "created_at": "2025-01-15T11:00:00.000Z"
    }
  ]
}
```

## WebSocket Protocol

### Listener Connection

**Endpoint:** `wss://soundcast.com/ws/room/:slug/listen`

**Initial Config Message:**
```json
{
  "type": "config",
  "data": {
    "sfuUrl": "ws://192.168.1.5:8080/ws",
    "iceServers": [
      { "urls": "stun:stun.l.google.com:19302" }
    ],
    "isLocalOnly": true
  }
}
```

### Interpreter Connection

**Endpoint:** `wss://soundcast.com/ws/room/:slug/interpret?token=<join_token>`

**Initial Config Message:**
```json
{
  "type": "config",
  "data": {
    "sfuUrl": "ws://192.168.1.5:8080/ws",
    "iceServers": [
      { "urls": "stun:stun.l.google.com:19302" }
    ],
    "isLocalOnly": true,
    "targetLanguage": "es"
  }
}
```

### WebRTC Signaling

After receiving the config message, clients can send WebRTC signaling messages:

```json
{
  "type": "webrtc_signal",
  "data": {
    "room": "annual-shareholder-meeting-101",
    "sender_id": "client_uuid",
    "payload": {
      "type": "offer|answer|candidate",
      // ... SDP or ICE candidate data
    }
  }
}
```

## Getting Started

### 1. Create a Tenant

Use the CLI utility to create a tenant:

```bash
node src/cli/manage.js create-tenant "Acme Corp" "my-secret-api-key-123"
```

**Output:**
```json
{
  "id": 1,
  "name": "Acme Corp",
  "created_at": "2025-01-15T10:00:00.000Z"
}

🔑 API Key (save this!): my-secret-api-key-123
```

### 2. Create a Room

```bash
curl -X POST http://localhost:3000/api/rooms \
  -H "Authorization: Bearer my-secret-api-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test Room",
    "is_local_only": false,
    "sfu_url": "ws://localhost:3000/ws",
    "coturn_config_json": "[{\"urls\": \"stun:stun.l.google.com:19302\"}]"
  }'
```

### 3. Add an Interpreter

```bash
curl -X POST http://localhost:3000/api/rooms/test-room-1/interpreters \
  -H "Authorization: Bearer my-secret-api-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "John Doe",
    "target_language": "fr"
  }'
```

Save the returned `join_token` for the interpreter to use.

### 4. Connect as Listener

```javascript
const ws = new WebSocket('ws://localhost:3000/ws/room/test-room-1/listen');

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);

  if (message.type === 'config') {
    console.log('SFU URL:', message.data.sfuUrl);
    console.log('ICE Servers:', message.data.iceServers);
    // Connect to the SFU using the provided configuration
  }
};
```

### 5. Connect as Interpreter

```javascript
const token = 'a1b2c3d4e5f6g7h8'; // From step 3
const ws = new WebSocket(`ws://localhost:3000/ws/room/test-room-1/interpret?token=${token}`);

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);

  if (message.type === 'config') {
    console.log('Target Language:', message.data.targetLanguage);
    // Connect to the SFU and start interpreting
  }
};
```

## CLI Management Tool

The CLI tool provides quick access to tenant and room management:

```bash
# List all tenants
node src/cli/manage.js list-tenants

# List rooms for a tenant
node src/cli/manage.js list-rooms 1

# List interpreters for a room
node src/cli/manage.js list-interpreters 1
```

## Environment Variables

- `DB_PATH`: Path to SQLite database file (default: `./soundcast.db`)
- `PORT`: HTTP server port (default: `3000`)
- `HOST`: HTTP server host (default: `0.0.0.0`)

## Security Notes

1. **API Keys**: Store API keys securely and never commit them to version control
2. **Join Tokens**: Single-use tokens are hashed in the database and cannot be retrieved
3. **HTTPS**: Always use HTTPS/WSS in production environments
4. **Token Rotation**: Consider implementing token expiration for interpreters

## Legacy Compatibility

The original WebSocket endpoint (`/ws`) remains available for backward compatibility with existing admin, publisher, and listener clients.
