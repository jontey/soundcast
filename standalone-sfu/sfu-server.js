#!/usr/bin/env node

/**
 * Soundcast Standalone SFU Server
 *
 * This is a standalone Selective Forwarding Unit (SFU) server that can be
 * packaged as an executable and deployed on local networks.
 *
 * Usage:
 *   sfu-server --url https://soundcast.example.com --key YOUR_SECRET_KEY --port 8080
 *
 * Features:
 * - Auto-registers with the main Soundcast instance
 * - Provides WebRTC media routing for local networks
 * - Heartbeat mechanism to maintain connection
 */

import mediasoup from 'mediasoup';
import { WebSocketServer } from 'ws';
import fetch from 'node-fetch';
import os from 'os';

// Parse command-line arguments
const args = process.argv.slice(2);
const config = {
  masterUrl: getArg('--url') || process.env.SOUNDCAST_URL,
  secretKey: getArg('--key') || process.env.SOUNDCAST_KEY,
  port: parseInt(getArg('--port') || process.env.SFU_PORT || '8080'),
  rtcMinPort: parseInt(getArg('--rtc-min') || process.env.RTC_MIN_PORT || '40000'),
  rtcMaxPort: parseInt(getArg('--rtc-max') || process.env.RTC_MAX_PORT || '49999'),
  announcedIp: getArg('--ip') || process.env.ANNOUNCED_IP || getLocalIp(),
  name: getArg('--name') || process.env.SFU_NAME || `SFU-${os.hostname()}`
};

function getArg(name) {
  const index = args.indexOf(name);
  return index !== -1 && args[index + 1] ? args[index + 1] : null;
}

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

// Validate configuration
if (!config.masterUrl) {
  console.error('❌ Error: Master Soundcast URL is required');
  console.error('Usage: sfu-server --url https://soundcast.example.com --key YOUR_SECRET_KEY');
  process.exit(1);
}

if (!config.secretKey) {
  console.error('❌ Error: Secret key is required for authentication');
  console.error('Usage: sfu-server --url https://soundcast.example.com --key YOUR_SECRET_KEY');
  process.exit(1);
}

console.log('🚀 Soundcast Standalone SFU Server');
console.log('====================================');
console.log(`Name: ${config.name}`);
console.log(`Master URL: ${config.masterUrl}`);
console.log(`WebSocket Port: ${config.port}`);
console.log(`RTC Ports: ${config.rtcMinPort}-${config.rtcMaxPort}`);
console.log(`Announced IP: ${config.announcedIp}`);
console.log('====================================\n');

// SFU state
let worker;
let router;
const transports = new Map();
const producers = new Map();
const consumers = new Map();

// Initialize mediasoup
async function initMediasoup() {
  console.log('🔧 Initializing mediasoup worker...');

  worker = await mediasoup.createWorker({
    rtcMinPort: config.rtcMinPort,
    rtcMaxPort: config.rtcMaxPort,
    logLevel: 'warn',
    logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp']
  });

  worker.on('died', () => {
    console.error('❌ mediasoup worker died, exiting...');
    process.exit(1);
  });

  // Create router for audio
  router = await worker.createRouter({
    mediaCodecs: [
      {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2
      }
    ]
  });

  console.log('✅ mediasoup initialized');
}

// WebSocket server
let wss;

function startWebSocketServer() {
  wss = new WebSocketServer({ port: config.port });

  wss.on('connection', (ws, req) => {
    const clientId = Math.random().toString(36).substring(7);
    console.log(`📱 Client connected: ${clientId}`);

    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message.toString());
        await handleMessage(ws, clientId, data);
      } catch (error) {
        console.error('Error handling message:', error);
        ws.send(JSON.stringify({
          type: 'error',
          error: error.message
        }));
      }
    });

    ws.on('close', () => {
      console.log(`📱 Client disconnected: ${clientId}`);
      cleanup(clientId);
    });

    // Send router RTP capabilities
    ws.send(JSON.stringify({
      type: 'routerRtpCapabilities',
      rtpCapabilities: router.rtpCapabilities
    }));
  });

  console.log(`✅ WebSocket server listening on ws://0.0.0.0:${config.port}`);
}

// Handle WebSocket messages
async function handleMessage(ws, clientId, data) {
  const { type, ...params } = data;

  switch (type) {
    case 'createTransport':
      await createTransport(ws, clientId, params);
      break;

    case 'connectTransport':
      await connectTransport(ws, clientId, params);
      break;

    case 'produce':
      await produce(ws, clientId, params);
      break;

    case 'consume':
      await consume(ws, clientId, params);
      break;

    default:
      console.log(`Unknown message type: ${type}`);
  }
}

// Create WebRTC transport
async function createTransport(ws, clientId, { direction }) {
  const transport = await router.createWebRtcTransport({
    listenIps: [
      {
        ip: '0.0.0.0',
        announcedIp: config.announcedIp
      }
    ],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true
  });

  transports.set(transport.id, { transport, clientId, direction });

  ws.send(JSON.stringify({
    type: 'transportCreated',
    transportId: transport.id,
    iceParameters: transport.iceParameters,
    iceCandidates: transport.iceCandidates,
    dtlsParameters: transport.dtlsParameters
  }));
}

// Connect transport
async function connectTransport(ws, clientId, { transportId, dtlsParameters }) {
  const item = transports.get(transportId);
  if (!item) {
    throw new Error('Transport not found');
  }

  await item.transport.connect({ dtlsParameters });

  ws.send(JSON.stringify({
    type: 'transportConnected',
    transportId
  }));
}

// Produce media
async function produce(ws, clientId, { transportId, kind, rtpParameters }) {
  const item = transports.get(transportId);
  if (!item) {
    throw new Error('Transport not found');
  }

  const producer = await item.transport.produce({
    kind,
    rtpParameters
  });

  producers.set(producer.id, { producer, clientId });

  ws.send(JSON.stringify({
    type: 'produced',
    producerId: producer.id
  }));

  console.log(`🎤 Producer created: ${producer.id}`);
}

// Consume media
async function consume(ws, clientId, { transportId, producerId, rtpCapabilities }) {
  const item = transports.get(transportId);
  if (!item) {
    throw new Error('Transport not found');
  }

  if (!router.canConsume({ producerId, rtpCapabilities })) {
    throw new Error('Cannot consume');
  }

  const consumer = await item.transport.consume({
    producerId,
    rtpCapabilities,
    paused: false
  });

  consumers.set(consumer.id, { consumer, clientId });

  ws.send(JSON.stringify({
    type: 'consumed',
    consumerId: consumer.id,
    producerId,
    kind: consumer.kind,
    rtpParameters: consumer.rtpParameters
  }));

  console.log(`🎧 Consumer created: ${consumer.id}`);
}

// Cleanup on disconnect
function cleanup(clientId) {
  // Close transports
  for (const [id, item] of transports.entries()) {
    if (item.clientId === clientId) {
      item.transport.close();
      transports.delete(id);
    }
  }

  // Close producers
  for (const [id, item] of producers.entries()) {
    if (item.clientId === clientId) {
      item.producer.close();
      producers.delete(id);
    }
  }

  // Close consumers
  for (const [id, item] of consumers.entries()) {
    if (item.clientId === clientId) {
      item.consumer.close();
      consumers.delete(id);
    }
  }
}

// Register with master Soundcast instance
async function registerWithMaster() {
  const sfuUrl = `ws://${config.announcedIp}:${config.port}`;

  console.log(`📡 Registering with master: ${config.masterUrl}`);

  try {
    const response = await fetch(`${config.masterUrl}/api/sfu/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.secretKey}`
      },
      body: JSON.stringify({
        name: config.name,
        url: sfuUrl,
        announced_ip: config.announcedIp,
        port: config.port,
        status: 'online'
      })
    });

    if (response.ok) {
      const data = await response.json();
      console.log('✅ Successfully registered with master');
      console.log(`   SFU ID: ${data.id}`);
      return data.id;
    } else {
      const error = await response.text();
      console.error('❌ Failed to register with master:', error);
      return null;
    }
  } catch (error) {
    console.error('❌ Error registering with master:', error.message);
    return null;
  }
}

// Send heartbeat to master
async function sendHeartbeat(sfuId) {
  try {
    await fetch(`${config.masterUrl}/api/sfu/${sfuId}/heartbeat`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.secretKey}`
      }
    });
  } catch (error) {
    console.error('⚠️  Heartbeat failed:', error.message);
  }
}

// Main initialization
async function main() {
  try {
    // Initialize mediasoup
    await initMediasoup();

    // Start WebSocket server
    startWebSocketServer();

    // Register with master (optional, will continue even if it fails)
    const sfuId = await registerWithMaster();

    // Start heartbeat if registered
    if (sfuId) {
      setInterval(() => sendHeartbeat(sfuId), 30000); // Every 30 seconds
    }

    console.log('\n✅ SFU Server is ready!');
    console.log(`   Access URL: ws://${config.announcedIp}:${config.port}`);
    console.log(`   Status: ${sfuId ? 'Registered' : 'Standalone'}\n`);

  } catch (error) {
    console.error('❌ Failed to start SFU server:', error);
    process.exit(1);
  }
}

// Handle shutdown gracefully
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down SFU server...');
  if (worker) worker.close();
  if (wss) wss.close();
  process.exit(0);
});

// Start the server
main();
