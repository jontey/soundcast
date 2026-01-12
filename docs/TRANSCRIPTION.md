# Transcription System Documentation

## Overview

SoundCast provides real-time audio transcription and semantic search capabilities using Whisper.cpp (via native N-API addon) and SQLite vector embeddings (sqlite-vec). This system enables automatic transcription of audio streams with intelligent search across transcribed content.

## Architecture

### Key Components

```
┌──────────────┐
│ Audio Stream │ (RTP/WebRTC from broadcaster)
└──────┬───────┘
       │
       v
┌──────────────┐
│   FFmpeg     │ (Convert Opus → PCM @ 16kHz)
└──────┬───────┘
       │
       v
┌──────────────────┐
│ Whisper Addon    │ (Native C++ N-API integration)
│ (whisper.cpp)    │ - In-process execution
└──────┬───────────┘ - Multi-threaded inference
       │
       v
┌─────────────────────┐
│ Database (SQLite)   │
│ - transcripts       │
│ - embeddings (vec0) │
└─────────────────────┘
```

### Performance Benefits

- **5x faster startup**: No HTTP subprocess overhead
- **2x lower memory**: Shared process space
- **No port exhaustion**: Direct function calls
- **Simplified deployment**: Single binary with extensions

## Installation

### Prerequisites

- Node.js 22+
- Python 3 (for native addon build)
- CMake 3.20+ (for whisper.cpp compilation)
- FFmpeg (runtime dependency)
- Build tools (gcc/clang, make)

### macOS

```bash
# Install build dependencies
brew install cmake python@3 ffmpeg

# Build native addon
cd src/native
npm install
npm run build

# Setup sqlite-vec extension
cd ../..
chmod +x scripts/setup-sqlite-vec.sh
./scripts/setup-sqlite-vec.sh
```

### Linux (Debian/Ubuntu)

```bash
# Install build dependencies
sudo apt-get update
sudo apt-get install -y build-essential cmake git curl python3 ffmpeg

# Build native addon
cd src/native
npm install
npm run build

# Setup sqlite-vec extension
cd ../..
chmod +x scripts/setup-sqlite-vec.sh
./scripts/setup-sqlite-vec.sh
```

### Docker

```bash
# Build image (includes all dependencies)
docker build -t soundcast:latest .

# Run with docker-compose
docker-compose up -d
```

## Configuration

### Environment Variables

```bash
# Transcription
TRANSCRIPTION_ENABLED=true              # Enable transcription system
TRANSCRIPTION_USE_NATIVE=true          # Use native addon (vs HTTP subprocess)
WHISPER_MODEL_DIR=/app/models          # Model storage directory
WHISPER_MODEL_SIZE=base                # Default model (tiny/base/small/medium/large-v3)

# Transcription RTP ports
TRANSCRIPTION_RTP_PORT_MIN=51000
TRANSCRIPTION_RTP_PORT_MAX=51999

# Embeddings
EMBEDDING_ENABLED=true                  # Enable semantic search
SQLITE_VEC_PATH=/app/lib/vec0.so       # SQLite-vec extension path

# Recording (optional)
RECORDING_DIR=/app/recordings
RECORDING_RTP_PORT_MIN=50000
RECORDING_RTP_PORT_MAX=50100
```

## Model Management

### Available Models

| Model        | Size  | Languages    | Use Case                    |
|--------------|-------|--------------|------------------------------|
| tiny.en      | 75MB  | English only | Fast, low-resource           |
| tiny         | 75MB  | Multilingual | Fast, low-resource           |
| base.en      | 142MB | English only | Balanced                     |
| base         | 142MB | Multilingual | Balanced (recommended)       |
| small.en     | 466MB | English only | Higher accuracy              |
| small        | 466MB | Multilingual | Higher accuracy              |
| medium.en    | 1.5GB | English only | Very high accuracy           |
| medium       | 1.5GB | Multilingual | Very high accuracy           |
| large-v3     | 3.1GB | Multilingual | Best accuracy, resource-heavy|

### Downloading Models

#### Via Admin UI

1. Navigate to tenant admin page: `https://your-domain.com/admin?key=your-admin-key`
2. Click "Model Manager" button
3. Select model from "Available Models" table
4. Click "Download" button
5. Monitor progress bar until complete

#### Via API

```bash
# List available models
curl -H "X-Admin-Key: your-admin-key" \
  https://your-domain.com/api/models

# Start download
curl -X POST \
  -H "X-Admin-Key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{"modelName": "base.en"}' \
  https://your-domain.com/api/models/download

# Check progress
curl -H "X-Admin-Key: your-admin-key" \
  https://your-domain.com/api/models/download/download-1

# List installed models
curl -H "X-Admin-Key: your-admin-key" \
  https://your-domain.com/api/models | jq '.installed'
```

#### Manual Download

```bash
# Download from Hugging Face
wget https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin \
  -O models/ggml-base.en.bin

# Verify file size
ls -lh models/ggml-base.en.bin
```

### Deleting Models

```bash
# Via API
curl -X DELETE \
  -H "X-Admin-Key: your-admin-key" \
  https://your-domain.com/api/models/ggml-base.en.bin

# Via filesystem
rm models/ggml-base.en.bin
```

## Transcription Control

### Starting Transcription

#### Via Admin UI

1. Navigate to tenant admin page
2. Find the room card
3. Click "Transcription" button to expand controls
4. Click "Start Default Channel" (or specify channel)
5. View active sessions in the table

#### Via API

```bash
# Start transcription for all producers in room
curl -X POST \
  -H "X-Admin-Key: your-admin-key" \
  https://your-domain.com/api/rooms/room-slug/transcription/start

# Start for specific channel
curl -X POST \
  -H "X-Admin-Key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{"channelName": "spanish"}' \
  https://your-domain.com/api/rooms/room-slug/transcription/start
```

### Stopping Transcription

```bash
# Stop specific session
curl -X POST \
  -H "X-Admin-Key: your-admin-key" \
  https://your-domain.com/api/rooms/room-slug/transcription/stop/session-id

# Stop all sessions in room
curl -X POST \
  -H "X-Admin-Key: your-admin-key" \
  https://your-domain.com/api/rooms/room-slug/transcription/stop
```

### Monitoring Status

```bash
# Get all active sessions
curl -H "X-Admin-Key: your-admin-key" \
  https://your-domain.com/api/rooms/room-slug/transcription/status

# Response:
# {
#   "sessions": [
#     {
#       "producerId": "abc123",
#       "producerName": "John Doe",
#       "channelName": "default",
#       "language": "en",
#       "uptime": 3600,
#       "queueSize": 0,
#       "errors": 0
#     }
#   ]
# }
```

## Semantic Search

### Query API

```bash
# Search transcripts
curl -X POST \
  -H "X-Admin-Key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "machine learning artificial intelligence",
    "roomId": 1,
    "limit": 10,
    "minScore": 0.1
  }' \
  https://your-domain.com/api/search

# Response:
# {
#   "results": [
#     {
#       "id": 123,
#       "text_content": "Today we discuss machine learning...",
#       "producer_name": "John Doe",
#       "channel_name": "default",
#       "distance": 0.234,
#       "timestamp_start": 123.45,
#       "timestamp_end": 126.78
#     }
#   ]
# }
```

### Distance Metrics

- **L2 (Euclidean) distance**: Lower is better
- **Typical range**: 0.0 (identical) to 2.0+ (very different)
- **Recommended threshold**: < 1.0 for relevant results

## Database Schema

### Transcripts Table

```sql
CREATE TABLE transcripts (
    id INTEGER PRIMARY KEY,
    room_id INTEGER NOT NULL,
    channel_name TEXT NOT NULL,
    producer_id TEXT NOT NULL,
    producer_name TEXT,
    text_content TEXT NOT NULL,
    timestamp_start REAL NOT NULL,   -- Unix timestamp (seconds)
    timestamp_end REAL NOT NULL,
    confidence_score REAL,           -- 0.0 to 1.0
    language TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (room_id) REFERENCES rooms(id)
);
```

### Vector Embeddings

```sql
-- Metadata mapping (transcript_id → vector_rowid)
CREATE TABLE embedding_metadata (
    id INTEGER PRIMARY KEY,
    transcript_id INTEGER NOT NULL UNIQUE,
    room_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (transcript_id) REFERENCES transcripts(id)
);

-- Vec0 virtual table (384-dimensional embeddings)
CREATE VIRTUAL TABLE transcript_embeddings USING vec0(
  embedding float[384]
);
```

## Troubleshooting

### Common Issues

#### 1. Model Not Found

**Error**: `Model not found at models/ggml-base.en.bin`

**Solution**:
```bash
# Download model via UI or:
curl -L https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin \
  -o models/ggml-base.en.bin
```

#### 2. SQLite-vec Extension Failed

**Error**: `FATAL: sqlite-vec extension not found or failed to load`

**Solution**:
```bash
# Rebuild extension
chmod +x scripts/setup-sqlite-vec.sh
./scripts/setup-sqlite-vec.sh

# Verify installation
ls -lh lib/vec0.* # Should show .so (Linux) or .dylib (macOS)
```

#### 3. Native Addon Build Failed

**Error**: `whisper.h: No such file or directory`

**Solution**:
```bash
# Initialize whisper.cpp submodule
cd src/native
git submodule update --init --recursive

# Build whisper.cpp first
cd deps/whisper.cpp
cmake -B build
cmake --build build --config Release

# Build addon
cd ../..
npm run build
```

#### 4. FFmpeg Not Found

**Error**: `FFmpeg not found in PATH`

**Solution**:
```bash
# macOS
brew install ffmpeg

# Linux
sudo apt-get install ffmpeg

# Verify
ffmpeg -version
```

#### 5. Port Already in Use

**Error**: `EADDRINUSE: address already in use`

**Solution**:
```bash
# Change transcription RTP port range
export TRANSCRIPTION_RTP_PORT_MIN=52000
export TRANSCRIPTION_RTP_PORT_MAX=52999
```

### Debug Logging

Enable verbose logging:

```bash
# Set environment variable
export DEBUG=soundcast:*

# Or in code
console.log('[Transcription] Debug info:', data);
```

### Performance Tuning

```bash
# Reduce threads for lower CPU usage
export WHISPER_THREADS=2  # Default: 4

# Use smaller model for faster inference
export WHISPER_MODEL_SIZE=tiny.en

# Disable embeddings if not using search
export EMBEDDING_ENABLED=false
```

## API Reference

### Model Management

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/models` | GET | List available and installed models |
| `/api/models/download` | POST | Start model download |
| `/api/models/download/:id` | GET | Get download progress |
| `/api/models/downloads` | GET | List active downloads |
| `/api/models/:filename` | DELETE | Delete installed model |

### Transcription Control

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/rooms/:slug/transcription/start` | POST | Start transcription |
| `/api/rooms/:slug/transcription/stop` | POST | Stop all sessions |
| `/api/rooms/:slug/transcription/stop/:sessionId` | POST | Stop specific session |
| `/api/rooms/:slug/transcription/status` | GET | Get active sessions |

### Search

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/search` | POST | Semantic search transcripts |

## Best Practices

1. **Model Selection**: Start with `base.en` for English-only content, `base` for multilingual
2. **Resource Planning**:
   - tiny: ~80MB memory per session
   - base: ~150MB memory per session
   - medium: ~500MB memory per session
3. **Concurrent Sessions**: Limit to 5-10 sessions per CPU core
4. **Storage**: Plan for ~1KB per minute of transcribed audio (text + embeddings)
5. **Network**: Use `network_mode: host` in Docker for local deployments
6. **Security**: Always use admin authentication for transcription control endpoints
7. **Monitoring**: Track queue sizes and error rates via status endpoint

## License

Whisper.cpp is licensed under MIT. SQLite-vec is licensed under Apache 2.0.
