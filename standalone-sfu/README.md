# Soundcast Standalone SFU

This is a standalone Selective Forwarding Unit (SFU) server that can be deployed on local networks and automatically register with the main Soundcast instance.

## Features

- **Self-contained executable** - No installation required
- **Auto-registration** - Automatically registers with the main Soundcast instance
- **Heartbeat monitoring** - Maintains connection status
- **Cross-platform** - Available for Windows, macOS, and Linux
- **WebRTC media routing** - Provides efficient audio streaming for local networks

## Quick Start

### Download Pre-built Executables

Download the appropriate executable for your platform from the releases page:

- **Windows**: `soundcast-sfu-windows.exe`
- **macOS**: `soundcast-sfu-macos`
- **Linux**: `soundcast-sfu-linux`

### Running the SFU

**Windows (PowerShell or CMD):**
```powershell
.\soundcast-sfu-windows.exe --url https://soundcast.example.com --key YOUR_SECRET_KEY --port 8080
```

**macOS/Linux:**
```bash
chmod +x soundcast-sfu-macos  # Make executable (first time only)
./soundcast-sfu-macos --url https://soundcast.example.com --key YOUR_SECRET_KEY --port 8080
```

### Command-Line Options

| Option | Environment Variable | Default | Description |
|--------|---------------------|---------|-------------|
| `--url` | `SOUNDCAST_URL` | *(required)* | Main Soundcast instance URL |
| `--key` | `SOUNDCAST_KEY` | *(required)* | Secret key for authentication |
| `--port` | `SFU_PORT` | `8080` | WebSocket server port |
| `--rtc-min` | `RTC_MIN_PORT` | `40000` | Minimum RTC port |
| `--rtc-max` | `RTC_MAX_PORT` | `49999` | Maximum RTC port |
| `--ip` | `ANNOUNCED_IP` | *(auto-detect)* | Announced IP address |
| `--name` | `SFU_NAME` | `SFU-<hostname>` | SFU instance name |

### Example Usage

**Basic setup with auto-detected IP:**
```bash
./soundcast-sfu --url https://soundcast.example.com --key my-secret-key-123
```

**Specify custom port and name:**
```bash
./soundcast-sfu \
  --url https://soundcast.example.com \
  --key my-secret-key-123 \
  --port 9000 \
  --name "Office-SFU-Main"
```

**Specify announced IP (for NAT/port forwarding):**
```bash
./soundcast-sfu \
  --url https://soundcast.example.com \
  --key my-secret-key-123 \
  --ip 203.0.113.50
```

**Using environment variables:**
```bash
export SOUNDCAST_URL="https://soundcast.example.com"
export SOUNDCAST_KEY="my-secret-key-123"
export SFU_PORT="8080"
export ANNOUNCED_IP="192.168.1.100"

./soundcast-sfu
```

## Network Configuration

### Port Forwarding

If the SFU needs to be accessible from outside your local network, configure port forwarding on your router:

1. **WebSocket Port** (default 8080): TCP
2. **RTC Ports** (default 40000-49999): UDP

### Firewall Rules

**Windows Firewall:**
```powershell
# Allow inbound for WebSocket
New-NetFirewallRule -DisplayName "Soundcast SFU WebSocket" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow

# Allow inbound for RTC
New-NetFirewallRule -DisplayName "Soundcast SFU RTC" -Direction Inbound -Protocol UDP -LocalPort 40000-49999 -Action Allow
```

**macOS/Linux (iptables):**
```bash
# Allow WebSocket port
sudo iptables -A INPUT -p tcp --dport 8080 -j ACCEPT

# Allow RTC ports
sudo iptables -A INPUT -p udp --dport 40000:49999 -j ACCEPT
```

## Getting a Secret Key

To obtain a secret key for your SFU:

1. Contact your Soundcast administrator
2. They will generate a secret key for your organization
3. Use this key with the `--key` parameter

**Important:** Keep your secret key secure and never share it publicly.

## Registration with Main Instance

When the SFU starts, it will:

1. Connect to the main Soundcast instance at the specified URL
2. Register itself using the secret key
3. Send heartbeat signals every 30 seconds
4. Appear in the admin panel as an available SFU option

If registration fails, the SFU will continue to run in standalone mode but won't be selectable in the admin panel.

## Monitoring

The SFU provides console output for monitoring:

```
🚀 Soundcast Standalone SFU Server
====================================
Name: Office-SFU-Main
Master URL: https://soundcast.example.com
WebSocket Port: 8080
RTC Ports: 40000-49999
Announced IP: 192.168.1.100
====================================

🔧 Initializing mediasoup worker...
✅ mediasoup initialized
✅ WebSocket server listening on ws://0.0.0.0:8080
📡 Registering with master: https://soundcast.example.com
✅ Successfully registered with master
   SFU ID: 1

✅ SFU Server is ready!
   Access URL: ws://192.168.1.100:8080
   Status: Registered

📱 Client connected: abc123
🎤 Producer created: xyz789
```

## Troubleshooting

### Connection Issues

**Problem**: SFU can't connect to the main instance
```
❌ Failed to register with master: Error: connect ECONNREFUSED
```

**Solution**:
- Check that the main Soundcast URL is correct and accessible
- Verify your internet/network connection
- Check if the main instance is running

---

**Problem**: Invalid secret key
```
❌ Failed to register with master: Unauthorized
```

**Solution**:
- Verify your secret key is correct
- Contact your administrator to get a new key

### Port Conflicts

**Problem**: WebSocket port already in use
```
Error: listen EADDRINUSE: address already in use :::8080
```

**Solution**:
- Use a different port: `--port 9000`
- Or stop the other service using that port

### Firewall Blocking

**Problem**: Clients can't connect to the SFU

**Solution**:
- Check firewall rules (see Network Configuration above)
- Verify the announced IP is correct
- Test connectivity: `telnet 192.168.1.100 8080`

## Running as a Service

### Windows Service

Create a batch file `start-sfu.bat`:
```batch
@echo off
soundcast-sfu-windows.exe ^
  --url https://soundcast.example.com ^
  --key YOUR_SECRET_KEY ^
  --port 8080
```

Use [NSSM](https://nssm.cc/) to install as a service:
```powershell
nssm install SoundcastSFU "C:\path\to\start-sfu.bat"
nssm start SoundcastSFU
```

### macOS (launchd)

Create `/Library/LaunchDaemons/com.soundcast.sfu.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.soundcast.sfu</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/soundcast-sfu</string>
        <string>--url</string>
        <string>https://soundcast.example.com</string>
        <string>--key</string>
        <string>YOUR_SECRET_KEY</string>
        <string>--port</string>
        <string>8080</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
```

Load the service:
```bash
sudo launchctl load /Library/LaunchDaemons/com.soundcast.sfu.plist
```

### Linux (systemd)

Create `/etc/systemd/system/soundcast-sfu.service`:
```ini
[Unit]
Description=Soundcast SFU Server
After=network.target

[Service]
Type=simple
User=soundcast
WorkingDirectory=/opt/soundcast
ExecStart=/opt/soundcast/soundcast-sfu-linux \
  --url https://soundcast.example.com \
  --key YOUR_SECRET_KEY \
  --port 8080
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl enable soundcast-sfu
sudo systemctl start soundcast-sfu
sudo systemctl status soundcast-sfu
```

## Building from Source

If you need to build the executable yourself:

### Prerequisites
- Node.js 18+
- Python 3+
- Build tools (see main documentation)

### Build Steps

1. **Install dependencies:**
   ```bash
   cd standalone-sfu
   npm install
   ```

2. **Build for all platforms:**
   ```bash
   npm run build
   ```

3. **Or build for specific platform:**
   ```bash
   npm run build:win    # Windows
   npm run build:mac    # macOS
   npm run build:linux  # Linux
   ```

4. **Executables will be in `dist/` folder**

## Security Considerations

1. **Secret Key**: Never commit your secret key to version control
2. **Network Access**: Restrict SFU access to trusted networks
3. **Updates**: Keep the SFU updated with the latest version
4. **Monitoring**: Regularly check SFU logs for suspicious activity

## Support

For issues or questions:
1. Check the main [Soundcast documentation](../MULTITENANT.md)
2. Review the [troubleshooting](#troubleshooting) section
3. Contact your Soundcast administrator

## License

MIT License - See LICENSE file for details
