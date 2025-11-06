# Local SFU Installation Guide

This guide explains how to set up a local Selective Forwarding Unit (SFU) for Soundcast on Windows and macOS. The SFU is responsible for routing WebRTC media streams between publishers and listeners.

## Table of Contents
- [Option 1: Using Soundcast Built-in SFU (Recommended for Testing)](#option-1-using-soundcast-built-in-sfu-recommended-for-testing)
- [Option 2: Standalone mediasoup SFU Server](#option-2-standalone-mediasoup-sfu-server)
- [Option 3: Using mediasoup-demo](#option-3-using-mediasoup-demo)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)

---

## Option 1: Using Soundcast Built-in SFU (Recommended for Testing)

The Soundcast server includes a built-in mediasoup SFU that can be used for local development and testing.

### Prerequisites
- Node.js 18+ installed
- Python 3.x (required for mediasoup compilation)
- Build tools:
  - **Windows**: Visual Studio Build Tools
  - **macOS**: Xcode Command Line Tools

### Windows Setup

1. **Install Node.js**
   - Download from [nodejs.org](https://nodejs.org/)
   - Choose the LTS version (18.x or higher)

2. **Install Visual Studio Build Tools**
   ```powershell
   # Using Chocolatey (install Chocolatey first from chocolatey.org)
   choco install visualstudio2022buildtools -y
   choco install visualstudio2022-workload-vctools -y
   ```

   OR download manually:
   - Visit [Visual Studio Downloads](https://visualstudio.microsoft.com/downloads/)
   - Download "Build Tools for Visual Studio 2022"
   - Install with "Desktop development with C++" workload

3. **Install Python**
   ```powershell
   choco install python -y
   ```

4. **Start Soundcast**
   ```powershell
   cd soundcast
   npm install
   npm start
   ```

5. **Configure Room to Use Local SFU**
   The built-in SFU will be available at:
   - Local: `ws://localhost:3000/ws`
   - Network: `ws://<YOUR_LOCAL_IP>:3000/ws`

   Find your local IP:
   ```powershell
   ipconfig
   # Look for IPv4 Address
   ```

### macOS Setup

1. **Install Xcode Command Line Tools**
   ```bash
   xcode-select --install
   ```

2. **Install Node.js**
   Using Homebrew:
   ```bash
   brew install node@18
   ```

   Or download from [nodejs.org](https://nodejs.org/)

3. **Install Python (if not already installed)**
   ```bash
   brew install python3
   ```

4. **Start Soundcast**
   ```bash
   cd soundcast
   npm install
   npm start
   ```

5. **Configure Room to Use Local SFU**
   The built-in SFU will be available at:
   - Local: `ws://localhost:3000/ws`
   - Network: `ws://<YOUR_LOCAL_IP>:3000/ws`

   Find your local IP:
   ```bash
   ipconfig getifaddr en0  # for WiFi
   # or
   ipconfig getifaddr en1  # for Ethernet
   ```

---

## Option 2: Standalone mediasoup SFU Server

For production or isolated SFU deployments, you can run a standalone mediasoup server.

### Create a Standalone SFU

1. **Create a new directory**
   ```bash
   mkdir soundcast-sfu
   cd soundcast-sfu
   npm init -y
   ```

2. **Install dependencies**
   ```bash
   npm install mediasoup ws dotenv
   ```

3. **Create `sfu-server.js`**
   ```javascript
   import mediasoup from 'mediasoup';
   import { WebSocketServer } from 'ws';
   import 'dotenv/config';

   const PORT = process.env.SFU_PORT || 8080;
   const RTC_MIN_PORT = process.env.RTC_MIN_PORT || 40000;
   const RTC_MAX_PORT = process.env.RTC_MAX_PORT || 49999;
   const ANNOUNCED_IP = process.env.ANNOUNCED_IP || '127.0.0.1';

   // Create mediasoup worker
   const worker = await mediasoup.createWorker({
     rtcMinPort: RTC_MIN_PORT,
     rtcMaxPort: RTC_MAX_PORT,
     logLevel: 'warn'
   });

   // Create router
   const router = await worker.createRouter({
     mediaCodecs: [
       {
         kind: 'audio',
         mimeType: 'audio/opus',
         clockRate: 48000,
         channels: 2
       }
     ]
   });

   // WebSocket server
   const wss = new WebSocketServer({ port: PORT });

   console.log(`SFU WebSocket server listening on ws://0.0.0.0:${PORT}`);
   console.log(`Announced IP: ${ANNOUNCED_IP}`);
   console.log(`RTC ports: ${RTC_MIN_PORT}-${RTC_MAX_PORT}`);

   // Handle connections
   wss.on('connection', (ws) => {
     console.log('Client connected');

     ws.on('message', async (message) => {
       // Handle WebRTC signaling here
       // This is a simplified example - implement full signaling protocol
     });

     ws.on('close', () => {
       console.log('Client disconnected');
     });
   });
   ```

4. **Create `.env` file**
   ```bash
   SFU_PORT=8080
   RTC_MIN_PORT=40000
   RTC_MAX_PORT=49999
   ANNOUNCED_IP=192.168.1.100  # Your local IP
   ```

5. **Add to `package.json`**
   ```json
   {
     "type": "module",
     "scripts": {
       "start": "node sfu-server.js"
     }
   }
   ```

6. **Start the SFU**
   ```bash
   npm start
   ```

7. **Configure Room**
   Use `ws://<YOUR_IP>:8080/ws` as the `sfu_url` when creating rooms.

---

## Option 3: Using mediasoup-demo

The official mediasoup demo includes a full-featured SFU server.

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/versatica/mediasoup-demo.git
   cd mediasoup-demo
   ```

2. **Install server dependencies**
   ```bash
   cd server
   npm install
   ```

3. **Configure the server**
   Edit `server/config.js`:
   ```javascript
   module.exports = {
     // Listen on all interfaces
     https: {
       listenIp: '0.0.0.0',
       listenPort: 4443
     },
     // Your local IP for WebRTC
     mediasoup: {
       webRtcTransport: {
         listenIps: [
           {
             ip: '0.0.0.0',
             announcedIp: '192.168.1.100' // YOUR LOCAL IP
           }
         ]
       }
     }
   };
   ```

4. **Run the server**
   ```bash
   npm start
   ```

5. **Configure Room**
   Use `wss://<YOUR_IP>:4443/?roomId=test&peerId=test` as the `sfu_url`.

---

## Configuration

### Environment Variables for Soundcast SFU

Create or update `.env` in your Soundcast directory:

```bash
# Server
PORT=3000
HOST=0.0.0.0

# Database
DB_PATH=./soundcast.db

# mediasoup SFU Configuration
MEDIASOUP_MIN_PORT=20000
MEDIASOUP_MAX_PORT=30000
LISTEN_IP=0.0.0.0
ANNOUNCED_IP=192.168.1.100  # YOUR LOCAL IP

# For production, use your public IP or domain
# ANNOUNCED_IP=203.0.113.10
```

### Room Configuration Examples

**Local Network (Testing)**
```json
{
  "name": "Local Dev Room",
  "is_local_only": true,
  "sfu_url": "ws://192.168.1.100:3000/ws",
  "coturn_config_json": "[{\"urls\": \"stun:stun.l.google.com:19302\"}]"
}
```

**Public SFU (Production)**
```json
{
  "name": "Production Room",
  "is_local_only": false,
  "sfu_url": "wss://sfu.example.com/ws",
  "coturn_config_json": "[
    {\"urls\": \"stun:stun.l.google.com:19302\"},
    {\"urls\": \"turn:turn.example.com:3478\", \"username\": \"user\", \"credential\": \"pass\"}
  ]"
}
```

---

## Troubleshooting

### Windows Issues

**Python not found:**
```powershell
# Install Python
choco install python -y

# Verify installation
python --version
```

**Build tools error:**
```powershell
# Install Visual Studio Build Tools
npm install --global windows-build-tools
```

**Firewall blocking connections:**
1. Open Windows Defender Firewall
2. Click "Allow an app through firewall"
3. Add Node.js and allow both Private and Public networks

### macOS Issues

**Xcode tools not installed:**
```bash
xcode-select --install
```

**Permission denied:**
```bash
sudo chown -R $(whoami) /usr/local/lib/node_modules
```

**Port already in use:**
```bash
# Find process using port 3000
lsof -ti:3000

# Kill the process
kill -9 <PID>
```

### Network Configuration

**Finding your local IP:**

Windows:
```powershell
ipconfig | findstr IPv4
```

macOS/Linux:
```bash
ifconfig | grep "inet "
# or
ip addr show
```

**Port forwarding for remote access:**

If you need to access the SFU from outside your local network:

1. Open your router's admin panel (usually http://192.168.1.1)
2. Find "Port Forwarding" or "Virtual Server"
3. Forward these ports to your computer's local IP:
   - TCP 3000 (Soundcast HTTP/WebSocket)
   - UDP 20000-30000 (mediasoup RTC)

**Testing connectivity:**

```bash
# Test WebSocket connection
wscat -c ws://localhost:3000/ws

# Test from another device
wscat -c ws://192.168.1.100:3000/ws
```

Install wscat:
```bash
npm install -g wscat
```

---

## Security Notes

1. **For production**: Always use WSS (WebSocket Secure) with SSL/TLS certificates
2. **Firewall**: Only open required ports
3. **TURN server**: Use authenticated TURN servers in production
4. **IP restrictions**: Consider IP whitelisting for admin endpoints

---

## Performance Tips

### Windows
- Disable Windows Defender real-time scanning for the project folder during development
- Use Windows Terminal for better performance than CMD

### macOS
- Increase file descriptor limit:
  ```bash
  ulimit -n 65536
  ```

### Both Platforms
- Use SSD storage for better I/O performance
- Allocate sufficient RAM (4GB minimum recommended)
- Close unnecessary applications during testing

---

## Next Steps

1. Start Soundcast: `npm start`
2. Create a tenant: `node src/cli/manage.js create-tenant "My Org" "api-key-123"`
3. Create a room with your local SFU URL
4. Access the admin panel: http://localhost:3000/admin.html
5. Test publisher/listener connections

For more information, see [MULTITENANT.md](MULTITENANT.md).
