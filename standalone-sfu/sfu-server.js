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
const clients = new Map();

function startWebSocketServer() {
  wss = new WebSocketServer({ port: config.port });

  wss.on('connection', (ws, req) => {
    const clientId = Math.random().toString(36).substring(7);
    console.log(`📱 Client connected: ${clientId}`);

    // Store client info
    clients.set(clientId, {
      socket: ws,
      transport: null,
      producer: null,
      consumers: [],
      isPublisher: false,
      isListener: false,
      channelId: null,
      rtpCapabilities: null
    });

    ws.on('message', async (message) => {
      try {
        const payload = JSON.parse(message.toString());
        await handleMessage(ws, clientId, payload);
      } catch (error) {
        console.error('Error handling message:', error);
        ws.send(JSON.stringify({
          action: 'error',
          data: { message: error.message }
        }));
      }
    });

    ws.on('close', () => {
      console.log(`📱 Client disconnected: ${clientId}`);
      cleanup(clientId);
    });
  });

  console.log(`✅ WebSocket server listening on ws://0.0.0.0:${config.port}`);
}

// Channels for this SFU (channelId -> { producers, consumers })
const channels = new Map();

// Handle WebSocket messages
async function handleMessage(ws, clientId, payload) {
  const { action, data } = payload;
  const clientInfo = clients.get(clientId);

  console.log(`Received action: ${action} from ${clientId}`);

  switch (action) {
    case 'get-rtpCapabilities':
      ws.send(JSON.stringify({
        action: 'rtpCapabilities',
        data: router.rtpCapabilities
      }));
      break;

    case 'create-publisher-transport': {
      if (!data || !data.channelId) {
        ws.send(JSON.stringify({
          action: 'error',
          data: { message: 'Channel ID required' }
        }));
        break;
      }

      // Auto-create channel if it doesn't exist
      if (!channels.has(data.channelId)) {
        channels.set(data.channelId, {
          producers: new Map(),
          consumers: new Map()
        });
        console.log(`Auto-created channel: ${data.channelId}`);
      }

      const transport = await router.createWebRtcTransport({
        listenIps: [{ ip: '0.0.0.0', announcedIp: config.announcedIp }],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true
      });

      clientInfo.transport = transport;
      clientInfo.isPublisher = true;
      clientInfo.channelId = data.channelId;

      ws.send(JSON.stringify({
        action: 'publisher-transport-created',
        data: {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters
        }
      }));
      break;
    }

    case 'connect-publisher-transport': {
      if (!clientInfo.transport || !clientInfo.isPublisher) {
        ws.send(JSON.stringify({
          action: 'error',
          data: { message: 'No publisher transport created' }
        }));
        break;
      }

      await clientInfo.transport.connect({ dtlsParameters: data.dtlsParameters });

      ws.send(JSON.stringify({
        action: 'publisher-transport-connected',
        data: { connected: true, transportId: clientInfo.transport.id }
      }));
      break;
    }

    case 'produce-audio': {
      if (!clientInfo.transport || !clientInfo.isPublisher || !clientInfo.channelId) {
        ws.send(JSON.stringify({
          action: 'error',
          data: { message: 'No publisher transport connected' }
        }));
        break;
      }

      const producer = await clientInfo.transport.produce({
        kind: 'audio',
        rtpParameters: data.rtpParameters
      });

      const channel = channels.get(clientInfo.channelId);
      const producerId = Math.random().toString(36).substring(7);
      clientInfo.producer = { id: producerId, producer };
      channel.producers.set(producerId, {
        transport: clientInfo.transport,
        producer,
        clientId
      });

      ws.send(JSON.stringify({
        action: 'produced',
        data: { id: producerId }
      }));

      console.log(`🎤 Producer created: ${producerId}`);

      // Create consumers for existing listeners
      for (const [otherId, otherClient] of clients) {
        if (otherClient.isListener &&
            otherClient.channelId === clientInfo.channelId &&
            otherClient.transport &&
            otherClient.rtpCapabilities) {
          await createConsumerForListener(otherClient, producer, producerId, clientInfo.channelId);
        }
      }
      break;
    }

    case 'create-listener-transport': {
      if (!data || !data.channelId) {
        ws.send(JSON.stringify({
          action: 'error',
          data: { message: 'Channel ID required' }
        }));
        break;
      }

      // Auto-create channel if it doesn't exist
      if (!channels.has(data.channelId)) {
        channels.set(data.channelId, {
          producers: new Map(),
          consumers: new Map()
        });
      }

      const transport = await router.createWebRtcTransport({
        listenIps: [{ ip: '0.0.0.0', announcedIp: config.announcedIp }],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true
      });

      clientInfo.transport = transport;
      clientInfo.isListener = true;
      clientInfo.channelId = data.channelId;
      clientInfo.rtpCapabilities = data.rtpCapabilities;
      clientInfo.displayName = data.displayName || 'Anonymous';

      ws.send(JSON.stringify({
        action: 'listener-transport-created',
        data: {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters
        }
      }));
      break;
    }

    case 'connect-listener-transport': {
      if (!clientInfo.transport || !clientInfo.isListener) {
        ws.send(JSON.stringify({
          action: 'error',
          data: { message: 'No listener transport created' }
        }));
        break;
      }

      await clientInfo.transport.connect({ dtlsParameters: data.dtlsParameters });

      ws.send(JSON.stringify({
        action: 'listener-transport-connected',
        data: { connected: true }
      }));
      // Consumer creation happens when client sends 'consume-audio'
      break;
    }

    case 'consume-audio': {
      if (!clientInfo.transport || !clientInfo.isListener || !clientInfo.channelId) {
        ws.send(JSON.stringify({
          action: 'error',
          data: { message: 'No listener transport connected' }
        }));
        break;
      }

      const consumerChannel = channels.get(clientInfo.channelId);
      if (!consumerChannel) {
        ws.send(JSON.stringify({
          action: 'error',
          data: { message: 'Channel no longer exists' }
        }));
        break;
      }

      // Store rtpCapabilities for later use (when new producers join)
      clientInfo.rtpCapabilities = data.rtpCapabilities;

      if (consumerChannel.producers.size === 0) {
        console.log(`Listener ${clientId} waiting for publisher in channel ${clientInfo.channelId}`);
        ws.send(JSON.stringify({ action: 'waiting-for-publisher' }));
        break;
      }

      try {
        const consumersData = [];

        for (const [prodId, prodInfo] of consumerChannel.producers) {
          if (prodInfo.producer.closed) continue;

          if (!router.canConsume({ producerId: prodInfo.producer.id, rtpCapabilities: data.rtpCapabilities })) {
            console.log(`Client ${clientId} cannot consume producer ${prodId}`);
            continue;
          }

          const consumerObj = await clientInfo.transport.consume({
            producerId: prodInfo.producer.id,
            rtpCapabilities: data.rtpCapabilities,
            paused: false
          });

          // Use the actual mediasoup consumer ID
          clientInfo.consumers.push({ id: consumerObj.id, consumer: consumerObj, producerId: prodId });
          consumerChannel.consumers.set(consumerObj.id, {
            transport: clientInfo.transport,
            consumer: consumerObj,
            clientId,
            displayName: clientInfo.displayName,
            producerId: prodId
          });

          consumersData.push({
            id: consumerObj.id,
            producerId: prodId,
            kind: consumerObj.kind,
            rtpParameters: consumerObj.rtpParameters
          });
        }

        ws.send(JSON.stringify({
          action: 'consumer-created',
          data: consumersData
        }));
        console.log(`🎧 Created ${consumersData.length} consumers for listener ${clientId}`);
      } catch (error) {
        console.error('Error creating consumer:', error);
        ws.send(JSON.stringify({
          action: 'error',
          data: { message: `Error creating consumer: ${error.message}` }
        }));
      }
      break;
    }

    case 'stop-broadcasting': {
      if (clientInfo.producer) {
        clientInfo.producer.producer.close();
        const channel = channels.get(clientInfo.channelId);
        if (channel) {
          channel.producers.delete(clientInfo.producer.id);
        }
        clientInfo.producer = null;
      }
      if (clientInfo.transport) {
        clientInfo.transport.close();
        clientInfo.transport = null;
      }
      ws.send(JSON.stringify({
        action: 'broadcast-stopped',
        data: {}
      }));
      break;
    }

    case 'leave-channel': {
      // Close all consumers for this client
      for (const consumerInfo of clientInfo.consumers) {
        consumerInfo.consumer.close();
      }
      clientInfo.consumers = [];

      if (clientInfo.transport) {
        clientInfo.transport.close();
        clientInfo.transport = null;
      }

      ws.send(JSON.stringify({
        action: 'left-channel',
        data: {}
      }));
      break;
    }

    default:
      console.log(`Unknown action: ${action}`);
  }
}

// Create consumer for a listener (when new producer joins after listener is already connected)
async function createConsumerForListener(listenerClient, producer, producerId, channelId) {
  try {
    if (!listenerClient.rtpCapabilities) {
      console.log(`Listener doesn't have rtpCapabilities yet, skipping`);
      return;
    }

    if (!router.canConsume({ producerId: producer.id, rtpCapabilities: listenerClient.rtpCapabilities })) {
      console.log(`Cannot consume producer ${producer.id} for listener`);
      return;
    }

    const consumer = await listenerClient.transport.consume({
      producerId: producer.id,
      rtpCapabilities: listenerClient.rtpCapabilities,
      paused: false
    });

    // Use the actual mediasoup consumer ID
    listenerClient.consumers.push({ id: consumer.id, consumer, producerId });

    const channel = channels.get(channelId);
    if (channel) {
      channel.consumers.set(consumer.id, {
        transport: listenerClient.transport,
        consumer,
        clientId: null,
        displayName: listenerClient.displayName,
        producerId
      });
    }

    listenerClient.socket.send(JSON.stringify({
      action: 'consumer-created',
      data: [{
        id: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters
      }]
    }));

    console.log(`🎧 Consumer created for listener: ${consumer.id}`);
  } catch (error) {
    console.error('Error creating consumer:', error);
  }
}

// Cleanup on disconnect
function cleanup(clientId) {
  const clientInfo = clients.get(clientId);
  if (!clientInfo) return;

  // Close producer and remove from channel
  if (clientInfo.producer) {
    clientInfo.producer.producer.close();
    const channel = channels.get(clientInfo.channelId);
    if (channel) {
      channel.producers.delete(clientInfo.producer.id);
    }
  }

  // Close consumers
  for (const consumerInfo of clientInfo.consumers) {
    consumerInfo.consumer.close();
    const channel = channels.get(clientInfo.channelId);
    if (channel) {
      channel.consumers.delete(consumerInfo.id);
    }
  }

  // Close transport
  if (clientInfo.transport) {
    clientInfo.transport.close();
  }

  // Remove client
  clients.delete(clientId);
}

// Register with master Soundcast instance
async function registerWithMaster() {
  const sfuUrl = `ws://${config.announcedIp}:${config.port}`;

  console.log(`📡 Registering with master: ${config.masterUrl}`);

  try {
    const response = await fetch(`${config.masterUrl}/api/sfu/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: config.name,
        url: sfuUrl,
        announced_ip: config.announcedIp,
        port: config.port,
        secret_key: config.secretKey
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

// Send disconnect signal to master
async function sendDisconnect(sfuId) {
  try {
    console.log('📡 Notifying master of disconnect...');
    await fetch(`${config.masterUrl}/api/sfu/${sfuId}/disconnect`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.secretKey}`
      }
    });
    console.log('✅ Master notified of disconnect');
  } catch (error) {
    console.error('⚠️  Failed to notify master:', error.message);
  }
}

// Store SFU ID globally for shutdown handler
let registeredSfuId = null;

// Main initialization
async function main() {
  try {
    // Initialize mediasoup
    await initMediasoup();

    // Start WebSocket server
    startWebSocketServer();

    // Register with master (optional, will continue even if it fails)
    registeredSfuId = await registerWithMaster();

    // Start heartbeat if registered
    if (registeredSfuId) {
      setInterval(() => sendHeartbeat(registeredSfuId), 30000); // Every 30 seconds
    }

    console.log('\n✅ SFU Server is ready!');
    console.log(`   Access URL: ws://${config.announcedIp}:${config.port}`);
    console.log(`   Status: ${registeredSfuId ? 'Registered' : 'Standalone'}\n`);

  } catch (error) {
    console.error('❌ Failed to start SFU server:', error);
    process.exit(1);
  }
}

// Handle shutdown gracefully
async function shutdown() {
  console.log('\n🛑 Shutting down SFU server...');

  // Notify master of disconnect
  if (registeredSfuId) {
    await sendDisconnect(registeredSfuId);
  }

  if (worker) worker.close();
  if (wss) wss.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start the server
main();
