# Soundcast

A real-time audio broadcasting platform built with Node.js, mediasoup (SFU), and WebSockets. This application allows users to create audio channels, broadcast audio, and listen to broadcasts in real-time.

## Features

- **Real-time Audio Broadcasting**: Stream audio to multiple listeners with minimal latency
- **Channel Management**: Create and manage multiple broadcasting channels
- **Role-Based Access**: Three distinct roles with different capabilities:
  - **Admin**: Manage channels and monitor subscribers
  - **Publisher**: Broadcast audio to specific channels
  - **Listener**: Discover channels and listen to broadcasts
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
   npm run build:mediasoup
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
npm run build:mediasoup

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

## Troubleshooting

- **No Sound**: Ensure your microphone is working and permissions are granted
- **Connection Issues**: Check your network connection and firewall settings
- **Server Logs**: Monitor the server console for detailed error information

## License

[MIT](LICENSE)
