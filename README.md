# Soundcast

A real-time audio broadcasting platform built with Node.js, mediasoup (SFU), and WebSockets. This application allows users to create audio channels, broadcast audio, and listen to broadcasts in real-time.

## Features

- **Real-time Audio Broadcasting**: Stream audio to multiple listeners with minimal latency
- **Channel Management**: Create and manage multiple broadcasting channels
- **Role-Based Access**: Three distinct roles with different capabilities:
   - **Admin**: Manage channels and monitor subscribers
   - **Publisher**: Broadcast audio to specific channels
   - **Listener**: Discover channels and listen to broadcasts
- **Real-Time Transcription with RAG**:
   - Live captions for listeners
   - Self-transcription for publishers
   - Semantic search over historical transcripts
   - Multi-language support (10+ languages)
   - Local processing with Whisper.cpp (no external API costs)
- **WebRTC Integration**: Utilizes mediasoup for efficient WebRTC handling
- **Simple Interface**: Clean, responsive UI built with vanilla HTML/CSS/JavaScript

## Architecture

Soundcast uses a split architecture:

- **Backend**: Node.js with Fastify, @fastify/websocket, and mediasoup for WebRTC
- **Frontend**: Static HTML/CSS/JavaScript pages served by the backend

## Prerequisites

- Node.js (v14 or later)
- npm (v6 or later)

## Installation

1. Clone the repository:

```bash
git clone https://github.com/jontey/soundcast.git
cd soundcast
```

2. Install dependencies:

```bash
npm install
```

3. Build the mediasoup client bundle:

```bash
# This creates a bundled version of mediasoup-client for the browser
npm run bundle:mediasoup
```

4. Configure environment variables (optional):

```bash
# Create a .env file in the root directory
LISTEN_IP=0.0.0.0  # IP to listen on
ANNOUNCED_IP=127.0.0.1  # IP to announce to clients
PORT=3000  # Port to run the server on
```

## Running the Application

### Available Scripts

```bash
# Start the server
npm start

# Build the mediasoup client bundle
npm run bundle:mediasoup

# Run in development mode with auto-restart
npm run dev
```

The application will be available at:

- http://localhost:3000 - Main page (listener interface)
- http://localhost:3000/publisher.html - Publisher interface
- http://localhost:3000/admin.html - Admin interface

## Usage

### As a Publisher

1. Navigate to the publisher page
2. Enter your name and select a channel
3. Click "Join Channel"
4. Click "Start Broadcasting" to begin streaming audio
5. Use the audio meter to monitor your audio levels
6. Click "Stop Broadcasting" when finished

### As a Listener

1. Navigate to the main page
2. Enter your name
3. Select an available channel from the list
4. Click "Join Channel"
5. Use the "Audio On/Off" button to control audio playback

### As an Admin

1. Navigate to the admin page
2. View active channels and their subscribers
3. Manage channels and remove subscribers if needed

## Technical Details

### WebRTC Flow

1. **Signaling**: WebSocket connections handle signaling between clients and server
2. **Transport Setup**: WebRTC transports are created for both publishers and listeners
3. **Media Flow**: Publishers produce audio streams that are routed through the SFU to listeners
4. **Control**: Listeners can control audio using the mediasoup Consumer API

### Key Components

- **mediasoup**: Handles WebRTC media routing (SFU - Selective Forwarding Unit)
- **mediasoup-client**: Browser-side library for WebRTC connections
- **Fastify**: Provides the HTTP and WebSocket server
- **WebRTC**: Enables real-time audio communication

### mediasoup Client Architecture

The mediasoup client is bundled using webpack to make it available in the browser:

1. **Entry Point**: `src/mediasoup-entry.js` imports the required mediasoup-client modules
2. **Bundle Script**: `src/bundle-mediasoup.js` configures webpack to create the bundle
3. **Output**: The bundled file is placed in `src/public/js/mediasoup-client.js`
4. **Usage**: The bundle is included in the HTML files and provides the global `mediasoupClient` object

## Real-Time Transcription

Soundcast includes optional real-time transcription with semantic search capabilities powered by Whisper.cpp (native N-API addon) and SQLite vector embeddings. For full documentation, see [docs/TRANSCRIPTION.md](docs/TRANSCRIPTION.md).

### Quick Setup

1. **Install build dependencies**:
```bash
# macOS
brew install cmake python@3 ffmpeg

# Linux (Debian/Ubuntu)
sudo apt-get install -y build-essential cmake git python3 ffmpeg
```

2. **Build native addon**:
```bash
cd src/native
npm install
npm run build
cd ../..
```

3. **Setup SQLite-vec extension**:
```bash
chmod +x scripts/setup-sqlite-vec.sh
./scripts/setup-sqlite-vec.sh
```

4. **Download a Whisper model** (via admin UI or manually):
```bash
mkdir -p models
curl -L https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin \
  -o models/ggml-base.en.bin
```

5. **Enable in `.env`**:
```bash
TRANSCRIPTION_ENABLED=true
TRANSCRIPTION_USE_NATIVE=true
WHISPER_MODEL_DIR=./models
WHISPER_MODEL_SIZE=base.en
EMBEDDING_ENABLED=true
```

6. **Start server** and use the transcription features:
   - **Publishers**: Select transcription language, see your speech transcribed in real-time
   - **Listeners**: See live captions and search historical transcripts
   - **Admin**: Download/manage Whisper models, start/stop transcription sessions
   - **API**: Query transcripts with semantic search

### Features

- **Native Performance**: 5x faster startup, 2x lower memory vs HTTP subprocess
- **Live Captions**: Real-time transcription appears for listeners during broadcasts
- **Multi-Language**: Support for 99 languages (English, Spanish, French, German, Chinese, Japanese, etc.)
- **Semantic Search**: Find transcripts by meaning using vector embeddings (sqlite-vec)
- **Model Management**: Download and manage Whisper models via admin UI
- **Local Processing**: All transcription runs on your server using Whisper.cpp native addon
- **No API Costs**: No external services required
- **Docker Support**: Multi-stage build includes all native dependencies

### Architecture

```
Audio Stream → FFmpeg → Whisper Addon (N-API) → Database → Vector Search
                         (whisper.cpp)            (SQLite + vec0)
```

For detailed setup, API reference, and troubleshooting, see the [full transcription documentation](docs/TRANSCRIPTION.md).

For development and debugging, see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Troubleshooting

- **No Sound**: Ensure your microphone is working and permissions are granted
- **Connection Issues**: Check your network connection and firewall settings
- **Server Logs**: Monitor the server console for detailed error information
- **Transcription Issues**: See [docs/TRANSCRIPTION.md](docs/TRANSCRIPTION.md#troubleshooting) for transcription-specific troubleshooting

## License

[MIT](LICENSE)
