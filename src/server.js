import 'dotenv/config';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import https from 'https';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import mediasoup from 'mediasoup';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { initDatabase, getDatabase } from './db/database.js';
import { registerApiRoutes } from './routes/api.js';
import { registerSfuRoutes } from './routes/sfu-api.js';
import { getRoomBySlug, listRoomsByTenant, createRoom } from './db/models/room.js';
import { verifyPublisherToken, getChannelsByRoom, listPublishersByRoom } from './db/models/publisher.js';
import { verifyTenantApiKey, getTenantByName, createTenant } from './db/models/tenant.js';
import { verifySfuSecretKey, listSfus } from './db/models/sfu.js';

// ES module equivalent for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve public directory (supports packaged executable)
function getPublicDir() {
  // Try standard location first (development)
  const devPath = path.join(__dirname, 'public');
  if (fs.existsSync(devPath)) return devPath;

  // Try next to executable (packaged)
  const exeDir = path.dirname(process.execPath);
  const pkgPath = path.join(exeDir, 'public');
  if (fs.existsSync(pkgPath)) return pkgPath;

  // Fallback to cwd
  const cwdPath = path.join(process.cwd(), 'public');
  if (fs.existsSync(cwdPath)) return cwdPath;

  // Return default even if not found (will error on access)
  return devPath;
}

// Create fastify instance
const fastify = Fastify({
  logger: true
});

// Initialize database
const dbPath = process.env.DB_PATH || './soundcast.db';
initDatabase(dbPath);
console.log('Database initialized');

// Single-tenant mode: auto-create default tenant and room
const singleTenantMode = process.env.SINGLE_TENANT === 'true';
let defaultApiKey = null;
let defaultTenant = null;

if (singleTenantMode) {
  defaultTenant = getTenantByName('default');
  if (!defaultTenant) {
    defaultApiKey = process.env.ADMIN_KEY || 'admin';
    defaultTenant = createTenant('default', defaultApiKey);
    console.log(`Single-tenant mode: Created default tenant with API key: ${defaultApiKey}`);
  } else {
    console.log('Single-tenant mode: Using existing default tenant');
    defaultApiKey = process.env.ADMIN_KEY || 'admin';
  }

  // Auto-create default "main" room if it doesn't exist
  const existingRoom = getRoomBySlug('main');
  if (!existingRoom) {
    const defaultSfuUrl = `ws://localhost:${process.env.PORT || 3000}/ws`;
    createRoom({
      tenant_id: defaultTenant.id,
      name: 'Main',
      slug: 'main',
      is_local_only: false,
      sfu_url: defaultSfuUrl,
      coturn_config_json: '[]'
    });
    console.log('Single-tenant mode: Created default "main" room');
  }
}

/**
 * Rewrite SFU URL protocol and port based on connection security
 * If client connected via wss://, rewrite ws:// to wss:// and update port
 * @param {string} sfuUrl - The original SFU URL
 * @param {object} req - The request object to check connection security
 * @returns {string} The potentially rewritten URL
 */
function getSecureSfuUrl(sfuUrl, req) {
  if (!sfuUrl) return sfuUrl;

  // Check if the incoming connection is secure
  // req.headers['x-forwarded-proto'] for reverse proxy scenarios
  // req.socket.encrypted for direct TLS connections
  const isSecure = req.socket?.encrypted ||
    req.headers?.['x-forwarded-proto'] === 'https' ||
    req.protocol === 'https';

  if (isSecure && sfuUrl.startsWith('ws://')) {
    const httpPort = process.env.PORT || '3000';
    const httpsPort = process.env.HTTPS_PORT || '3001';

    // Replace protocol
    let secureUrl = sfuUrl.replace(/^ws:\/\//, 'wss://');

    // Replace port if it matches the HTTP port
    // Matches :3000/ or :3000 at end of string
    const portRegex = new RegExp(`:${httpPort}(\\/|$)`);
    secureUrl = secureUrl.replace(portRegex, `:${httpsPort}$1`);

    return secureUrl;
  }

  return sfuUrl;
}

/**
 * Generate TURN credentials using coturn's static-auth-secret mechanism
 * @param {string} secret - The static-auth-secret from coturn config
 * @param {number} ttl - Time-to-live in seconds (default 24 hours)
 * @returns {{ username: string, credential: string }}
 */
function generateTurnCredentials(secret, ttl = 86400) {
  const timestamp = Math.floor(Date.now() / 1000) + ttl;
  const username = `${timestamp}:soundcast`;
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential };
}

/**
 * Process ICE servers array and generate dynamic TURN credentials where needed
 *
 * ICE servers with __turn_secret__ field will have credentials generated dynamically.
 * Format: { "urls": [...], "__turn_secret__": "secret", "__turn_ttl__": 86400 }
 *
 * @param {Array} iceServers - Array of ICE server configurations
 * @returns {Array} Processed ICE servers with generated credentials
 */
function processIceServers(iceServers) {
  return iceServers.map(server => {
    if (server.__turn_secret__) {
      const ttl = server.__turn_ttl__ || 86400;
      const { username, credential } = generateTurnCredentials(server.__turn_secret__, ttl);

      // Return new server object without the secret fields
      const { __turn_secret__, __turn_ttl__, ...rest } = server;
      return {
        ...rest,
        username,
        credential
      };
    }
    return server;
  });
}

// Fastify setup - serve static files
const publicDir = getPublicDir();
console.log('Serving static files from:', publicDir);
fastify.register(fastifyStatic, {
  root: publicDir,
  prefix: '/' // optional: default '/'
});

// Register WebSocket plugin
fastify.register(fastifyWebsocket, {
  options: {
    maxPayload: 1048576 // 1MB max payload
  }
});

// Register REST API routes
fastify.register(registerApiRoutes);

// Register SFU management routes
fastify.register(registerSfuRoutes);

// Room-specific HTML routes
fastify.get('/room/:slug/publish', async (request, reply) => {
  const { slug } = request.params;

  // Verify room exists
  const room = getRoomBySlug(slug);
  if (!room) {
    return reply.code(404).send('Room not found');
  }

  return reply.sendFile('room-publish.html');
});

fastify.get('/room/:slug/listen', async (request, reply) => {
  const { slug } = request.params;

  // Verify room exists
  const room = getRoomBySlug(slug);
  if (!room) {
    return reply.code(404).send('Room not found');
  }

  return reply.sendFile('room-listen.html');
});

// Tenant admin route
fastify.get('/tenant-admin', async (request, reply) => {
  return reply.sendFile('tenant-admin.html');
});

// mediasoup configuration
const mediasoupConfig = {
  listenIp: process.env.LISTEN_IP || '0.0.0.0',
  announcedIp: process.env.ANNOUNCED_IP || '127.0.0.1',
  rtcMinPort: parseInt(process.env.RTC_MIN_PORT || process.env.MEDIASOUP_MIN_PORT || '40000'),
  rtcMaxPort: parseInt(process.env.RTC_MAX_PORT || process.env.MEDIASOUP_MAX_PORT || '49999')
};

console.log('mediasoup configuration:');
console.log(`  Listen IP:    ${mediasoupConfig.listenIp}`);
console.log(`  Announced IP: ${mediasoupConfig.announcedIp}`);
console.log(`  RTC Ports:    ${mediasoupConfig.rtcMinPort}-${mediasoupConfig.rtcMaxPort}`);

if (mediasoupConfig.announcedIp === '127.0.0.1') {
  console.warn('WARNING: ANNOUNCED_IP is set to 127.0.0.1 - remote clients will not be able to connect!');
  console.warn('         Set ANNOUNCED_IP to your server\'s public IP address.');
}

// Router: audio only
const mediaCodecs = [{
  kind: 'audio',
  mimeType: 'audio/opus',
  clockRate: 48000,
  channels: 2
}];

// These will be initialized in main()
let worker;
let router;

// In-memory channel store
// channelId -> { producers: Map<producerId, { transport, producer, clientId }>, consumers: Map }
const channels = new Map();

// Store active connections
const clients = new Map();

// Tenant admin WebSocket connections: tenantId -> Set<socket>
const tenantAdminClients = new Map();

// SFU stats WebSocket connections: sfuId -> socket
const sfuStatsClients = new Map();

// Local SFU stats: sfuId -> { channels: { channelName: { publishers, subscribers } } }
const localSfuStats = new Map();

// Broadcast updated channel list to all clients
function broadcastChannelList() {
  const list = Array.from(channels.keys());
  for (const [clientId, client] of clients.entries()) {
    // In newer versions of fastify-websocket, the connection is the socket
    client.socket.send(JSON.stringify({
      action: 'channel-list',
      data: list
    }));
  }
}

// Get SFU ID for a room by matching sfu_url
function getSfuIdForRoom(room) {
  if (!room.sfu_url) return null;
  const sfus = listSfus();
  for (const sfu of sfus) {
    if (sfu.url === room.sfu_url) {
      return sfu.id;
    }
  }
  return null;
}

// Get channel stats for a specific tenant (combines main SFU and local SFU data)
function getChannelStatsForTenant(tenantId) {
  const stats = {};
  const rooms = listRoomsByTenant(tenantId);

  for (const room of rooms) {
    stats[room.slug] = {};
    const publishers = listPublishersByRoom(room.id);
    const channelNames = [...new Set(publishers.map(p => p.channel_name))];

    for (const channelName of channelNames) {
      // Full channel ID format used by SFU: "roomSlug:channelName"
      const fullChannelId = `${room.slug}:${channelName}`;

      // Helper to count unique listeners in a channel
      function countUniqueListeners(ch) {
        const uniqueListeners = new Set();
        if (ch.consumers) {
          for (const [consumerId, consumer] of ch.consumers) {
            if (consumer.clientId) {
              uniqueListeners.add(consumer.clientId);
            }
          }
        }
        return uniqueListeners.size;
      }

      // Check main SFU's channels Map (try both formats)
      if (channels.has(fullChannelId)) {
        const ch = channels.get(fullChannelId);
        stats[room.slug][channelName] = {
          publishers: ch.producers ? ch.producers.size : 0,
          subscribers: countUniqueListeners(ch)
        };
      } else if (channels.has(channelName)) {
        // Fallback to legacy format
        const ch = channels.get(channelName);
        stats[room.slug][channelName] = {
          publishers: ch.producers ? ch.producers.size : 0,
          subscribers: countUniqueListeners(ch)
        };
      }
      // Check local SFU stats (if room uses local SFU)
      else if (room.is_local_only) {
        const sfuId = getSfuIdForRoom(room);
        const sfuStats = sfuId ? localSfuStats.get(sfuId) : null;
        // Local SFU uses full channel ID format
        if (sfuStats?.channels?.[fullChannelId]) {
          stats[room.slug][channelName] = sfuStats.channels[fullChannelId];
        } else if (sfuStats?.channels?.[channelName]) {
          // Fallback to legacy format
          stats[room.slug][channelName] = sfuStats.channels[channelName];
        } else {
          stats[room.slug][channelName] = { publishers: 0, subscribers: 0 };
        }
      } else {
        stats[room.slug][channelName] = { publishers: 0, subscribers: 0 };
      }
    }
  }
  return stats;
}

// Find room and tenant for a channel name
// channelId format can be "roomSlug:channelName" (e.g., "sjh2:English") or just "channelName"
function findRoomForChannel(channelId) {
  const db = getDatabase();

  // Check if channelId has the "roomSlug:channelName" format
  const colonIndex = channelId.indexOf(':');
  if (colonIndex !== -1) {
    // Parse roomSlug and channelName
    const roomSlug = channelId.substring(0, colonIndex);
    const channelName = channelId.substring(colonIndex + 1);

    // Look up by room slug and channel name
    const stmt = db.prepare(`
      SELECT r.id as room_id, r.slug, r.tenant_id
      FROM rooms r
      JOIN publishers p ON p.room_id = r.id
      WHERE r.slug = ? AND p.channel_name = ?
      LIMIT 1
    `);
    return stmt.get(roomSlug, channelName);
  }

  // Fallback: query by channel_name directly (legacy format)
  const stmt = db.prepare(`
    SELECT r.id as room_id, r.slug, r.tenant_id
    FROM rooms r
    JOIN publishers p ON p.room_id = r.id
    WHERE p.channel_name = ?
    LIMIT 1
  `);
  return stmt.get(channelId);
}

// Extract short channel name from full channel ID
// "roomSlug:channelName" -> "channelName", or returns original if no colon
function getShortChannelName(channelId) {
  const colonIndex = channelId.indexOf(':');
  return colonIndex !== -1 ? channelId.substring(colonIndex + 1) : channelId;
}

// Notify tenant admins about channel updates
function notifyTenantAdmins(channelId, source = 'main') {
  const roomInfo = findRoomForChannel(channelId);
  if (!roomInfo) return;

  const tenantId = roomInfo.tenant_id;
  const adminSockets = tenantAdminClients.get(tenantId);
  if (!adminSockets || adminSockets.size === 0) return;

  // Get current stats for this channel
  let channelStats;
  if (source === 'main' && channels.has(channelId)) {
    const ch = channels.get(channelId);
    // Count unique listeners (by clientId) to match what publishers see
    const uniqueListeners = new Set();
    if (ch.consumers) {
      for (const [consumerId, consumer] of ch.consumers) {
        if (consumer.clientId) {
          uniqueListeners.add(consumer.clientId);
        }
      }
    }
    channelStats = {
      publishers: ch.producers ? ch.producers.size : 0,
      subscribers: uniqueListeners.size
    };
  } else {
    channelStats = { publishers: 0, subscribers: 0 };
  }

  // Use short channel name for the update (frontend expects "English", not "sjh2:English")
  const shortChannelName = getShortChannelName(channelId);

  const update = {
    type: 'channel-update',
    roomSlug: roomInfo.slug,
    channelName: shortChannelName,
    publishers: channelStats.publishers,
    subscribers: channelStats.subscribers
  };

  for (const socket of adminSockets) {
    try {
      socket.send(JSON.stringify(update));
    } catch (e) {
      fastify.log.error(`Failed to send update to tenant admin: ${e.message}`);
    }
  }
}

// Notify publishers in a channel about listener count changes
function notifyPublishersListenerCount(channelId) {
  const channel = channels.get(channelId);
  if (!channel) return;

  // Count unique listeners (consumers with unique clientIds)
  const uniqueListeners = new Set();
  for (const [consumerId, consumer] of channel.consumers) {
    if (consumer.clientId) {
      uniqueListeners.add(consumer.clientId);
    }
  }
  const listenerCount = uniqueListeners.size;

  // Notify all publishers in this channel
  for (const [producerId, producerInfo] of channel.producers) {
    if (producerInfo.clientId && clients.has(producerInfo.clientId)) {
      const publisherClient = clients.get(producerInfo.clientId);
      try {
        publisherClient.socket.send(JSON.stringify({
          action: 'listener-count',
          data: { count: listenerCount, channelId }
        }));
      } catch (e) {
        // Client may have disconnected
      }
    }
  }
}

// Notify tenant admins with stats from local SFU
function notifyTenantAdminsFromSfu(sfuId, channelId, stats) {
  // Find which rooms use this SFU
  const allSfus = listSfus();
  const sfu = allSfus.find(s => s.id === sfuId);
  if (!sfu) {
    fastify.log.warn(`notifyTenantAdminsFromSfu: SFU ${sfuId} not found`);
    return;
  }

  const tenantId = sfu.tenant_id;
  const adminSockets = tenantAdminClients.get(tenantId);
  if (!adminSockets || adminSockets.size === 0) {
    fastify.log.info(`notifyTenantAdminsFromSfu: No admin sockets for tenant ${tenantId}`);
    return;
  }

  // Find the room for this channel
  const roomInfo = findRoomForChannel(channelId);
  if (!roomInfo) {
    fastify.log.warn(`notifyTenantAdminsFromSfu: Room not found for channel "${channelId}"`);
    return;
  }
  if (roomInfo.tenant_id !== tenantId) {
    fastify.log.warn(`notifyTenantAdminsFromSfu: Channel "${channelId}" belongs to tenant ${roomInfo.tenant_id}, not ${tenantId}`);
    return;
  }

  // Use short channel name for the update (frontend expects "English", not "sjh2:English")
  const shortChannelName = getShortChannelName(channelId);

  const update = {
    type: 'channel-update',
    roomSlug: roomInfo.slug,
    channelName: shortChannelName,
    publishers: stats.publishers,
    subscribers: stats.subscribers
  };

  fastify.log.info(`Sending channel update to ${adminSockets.size} admin(s): ${JSON.stringify(update)}`);

  for (const socket of adminSockets) {
    try {
      socket.send(JSON.stringify(update));
    } catch (e) {
      fastify.log.error(`Failed to send SFU update to tenant admin: ${e.message}`);
    }
  }
}

// Helper to create WebRTC transport
async function createWebRtcTransport() {
  const transport = await router.createWebRtcTransport({
    listenIps: [
      { ip: mediasoupConfig.listenIp, announcedIp: mediasoupConfig.announcedIp }
    ],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true
  });

  // Log transport creation
  fastify.log.info(`Transport created with id ${transport.id}`);

  // Monitor transport
  transport.on('icestatechange', (iceState) => {
    fastify.log.info(`Transport ICE state changed to ${iceState}`);
  });

  transport.on('dtlsstatechange', (dtlsState) => {
    fastify.log.info(`Transport DTLS state changed to ${dtlsState}`);
    if (dtlsState === 'closed') {
      transport.close();
    }
  });

  transport.on('close', () => {
    fastify.log.info(`Transport closed`);
  });

  return {
    transport,
    params: {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters
    }
  };
}

// WebSocket route handler - extracted as a plugin for reuse
async function registerMainWsRoutes(fastify) {
  fastify.get('/ws', { websocket: true }, (connection, req) => {
    const clientId = uuidv4();
    fastify.log.info(`New connection: ${clientId}`);

    // Store client info
    const clientInfo = {
      id: clientId,
      socket: connection,  // In newer versions, connection is the socket
      isAdmin: false,
      isPublisher: false,
      isListener: false,
      channelId: null,
      displayName: null,
      transport: null,
      producer: null,
      consumers: [],
      rtpCapabilities: null
    };

    // Add to clients map
    clients.set(clientId, clientInfo);

    connection.on('message', async (message) => {
      let payload;
      try {
        payload = JSON.parse(message.toString());
      } catch (e) {
        fastify.log.error('Invalid JSON', e);
        return;
      }

      const { action, data } = payload;
      fastify.log.info(`Received action: ${action} from ${clientId}`);

      switch (action) {
        case 'get-rtpCapabilities':
          connection.send(JSON.stringify({
            action: 'rtpCapabilities',
            data: router.rtpCapabilities
          }));
          break;

        case 'get-channels':
          connection.send(JSON.stringify({
            action: 'channel-list',
            data: Array.from(channels.keys())
          }));
          break;

        case 'admin-create-channel':
          if (!data.channelId || typeof data.channelId !== 'string') {
            connection.send(JSON.stringify({
              action: 'error',
              data: { message: 'Invalid channel ID' }
            }));
            break;
          }

          // Create new channel
          channels.set(data.channelId, {
            producers: new Map(),
            consumers: new Map()
          });

          clientInfo.isAdmin = true;
          connection.send(JSON.stringify({
            action: 'channel-created',
            data: { channelId: data.channelId }
          }));

          // Broadcast updated channel list
          broadcastChannelList();
          break;

        case 'admin-delete-channel':
          if (!data.channelId || !channels.has(data.channelId)) {
            connection.send(JSON.stringify({
              action: 'error',
              data: { message: 'Channel does not exist' }
            }));
            break;
          }

          const channel = channels.get(data.channelId);

          // Close all producer transports
          for (const [prodId, prodInfo] of channel.producers) {
            if (prodInfo.transport) {
              prodInfo.transport.close();
            }
            if (prodInfo.producer) {
              prodInfo.producer.close();
            }
          }

          // Close all consumer transports
          for (const [consumerId, consumer] of channel.consumers) {
            if (consumer.transport) {
              consumer.transport.close();
            }

            // Notify listener about forced disconnect
            if (consumer.clientId && clients.has(consumer.clientId)) {
              const listenerClient = clients.get(consumer.clientId);
              // In newer versions of fastify-websocket, the connection is the socket
              listenerClient.socket.send(JSON.stringify({
                action: 'forced-disconnect',
                data: { reason: 'Channel deleted by admin' }
              }));
            }
          }

          // Remove channel
          channels.delete(data.channelId);

          clientInfo.isAdmin = true;
          connection.send(JSON.stringify({
            action: 'channel-deleted',
            data: { channelId: data.channelId }
          }));

          // Broadcast updated channel list
          broadcastChannelList();
          break;

        case 'admin-get-channels-subscribers':
          const channelsData = {};

          for (const [channelId, channel] of channels.entries()) {
            channelsData[channelId] = Array.from(channel.consumers.entries()).map(([id, consumer]) => ({
              id,
              name: consumer.displayName
            }));
          }

          clientInfo.isAdmin = true;
          connection.send(JSON.stringify({
            action: 'channels-subscribers',
            data: channelsData
          }));
          break;

        case 'admin-remove-subscriber':
          if (!data.channelId || !data.consumerId ||
            !channels.has(data.channelId) ||
            !channels.get(data.channelId).consumers.has(data.consumerId)) {
            connection.send(JSON.stringify({
              action: 'error',
              data: { message: 'Invalid channel or consumer ID' }
            }));
            break;
          }

          const targetChannel = channels.get(data.channelId);
          const consumer = targetChannel.consumers.get(data.consumerId);

          // Close consumer transport
          if (consumer.transport) {
            consumer.transport.close();
          }

          // Notify listener about forced disconnect
          if (consumer.clientId && clients.has(consumer.clientId)) {
            const listenerClient = clients.get(consumer.clientId);
            // In newer versions of fastify-websocket, the connection is the socket directly
            listenerClient.socket.send(JSON.stringify({
              action: 'forced-disconnect',
              data: { reason: 'Removed by admin' }
            }));
          }

          // Remove consumer from channel
          targetChannel.consumers.delete(data.consumerId);

          clientInfo.isAdmin = true;
          connection.send(JSON.stringify({
            action: 'subscriber-removed',
            data: {
              channelId: data.channelId,
              consumerId: data.consumerId
            }
          }));
          break;

        case 'admin-get-publishers':
          const publishers = [];
          for (const [id, c] of clients.entries()) {
            if (c.isPublisher) {
              publishers.push({ id, channelId: c.channelId });
            }
          }

          clientInfo.isAdmin = true;
          connection.send(JSON.stringify({
            action: 'publishers-list',
            data: publishers
          }));
          break;

        case 'admin-change-publisher-channel':
          if (!data.publisherId || !data.newChannelId ||
            !clients.has(data.publisherId) ||
            !channels.has(data.newChannelId)) {
            connection.send(JSON.stringify({
              action: 'error',
              data: { message: 'Invalid publisher or channel ID' }
            }));
            break;
          }

          const publisherClient = clients.get(data.publisherId);
          if (!publisherClient.isPublisher) {
            connection.send(JSON.stringify({
              action: 'error',
              data: { message: 'Target client is not a publisher' }
            }));
            break;
          }

          if (publisherClient.channelId === data.newChannelId) {
            connection.send(JSON.stringify({
              action: 'error',
              data: { message: 'Publisher already in that channel' }
            }));
            break;
          }

          const oldChannelId = publisherClient.channelId;
          const oldChannel = channels.get(oldChannelId);
          const newChannel = channels.get(data.newChannelId);

          if (publisherClient.producer) {
            const { id: prodId, producer } = publisherClient.producer;

            // Remove consumers of this producer from old channel
            for (const [consumerId, consumer] of oldChannel.consumers) {
              if (consumer.producerId === prodId) {
                if (consumer.consumer) consumer.consumer.close();
                oldChannel.consumers.delete(consumerId);

                if (consumer.clientId && clients.has(consumer.clientId)) {
                  const listener = clients.get(consumer.clientId);
                  listener.consumers = listener.consumers.filter(c => c.id !== consumerId);
                  listener.socket.send(JSON.stringify({ action: 'producer-stopped', data: { producerId: prodId } }));
                }
              }
            }

            // Move producer map entry
            oldChannel.producers.delete(prodId);
            newChannel.producers.set(prodId, { transport: publisherClient.transport, producer, clientId: data.publisherId });

            // Create consumers for listeners in the new channel
            for (const [otherId, otherClient] of clients.entries()) {
              if (otherClient.isListener && otherClient.channelId === data.newChannelId && otherClient.transport && otherClient.rtpCapabilities) {
                if (router.canConsume({ producerId: producer.id, rtpCapabilities: otherClient.rtpCapabilities })) {
                  const newConsumer = await otherClient.transport.consume({ producerId: producer.id, rtpCapabilities: otherClient.rtpCapabilities, paused: false });
                  const newConsumerId = uuidv4();
                  otherClient.consumers.push({ id: newConsumerId, consumer: newConsumer, producerId: prodId });
                  newChannel.consumers.set(newConsumerId, { transport: otherClient.transport, consumer: newConsumer, clientId: otherId, displayName: otherClient.displayName, producerId: prodId });

                  otherClient.socket.send(JSON.stringify({
                    action: 'consumer-created',
                    data: [{ id: newConsumerId, producerId: prodId, kind: newConsumer.kind, rtpParameters: newConsumer.rtpParameters }]
                  }));
                }
              }
            }
          }

          publisherClient.channelId = data.newChannelId;

          connection.send(JSON.stringify({
            action: 'publisher-channel-changed',
            data: { publisherId: data.publisherId, newChannelId: data.newChannelId }
          }));

          if (clients.has(data.publisherId)) {
            const pubSocket = clients.get(data.publisherId).socket;
            pubSocket.send(JSON.stringify({ action: 'admin-channel-changed', data: { channelId: data.newChannelId } }));
          }

          // Broadcast updated channel list
          broadcastChannelList();
          break;

        case 'create-publisher-transport':
          if (!data.channelId) {
            connection.send(JSON.stringify({
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
            fastify.log.info(`Auto-created channel: ${data.channelId}`);
            broadcastChannelList();
          }

          const publisherChannel = channels.get(data.channelId);

          // Create transport
          const { transport, params } = await createWebRtcTransport();

          // Store transport
          clientInfo.transport = transport;
          clientInfo.isPublisher = true;
          clientInfo.channelId = data.channelId;



          connection.send(JSON.stringify({
            action: 'publisher-transport-created',
            data: params
          }));
          break;

        case 'connect-publisher-transport':
          if (!clientInfo.transport || !clientInfo.isPublisher || !clientInfo.channelId) {
            fastify.log.warn(`Client ${clientId} attempted to connect publisher transport without proper setup`);
            connection.send(JSON.stringify({
              action: 'error',
              data: { message: 'No publisher transport created' }
            }));
            break;
          }

          try {
            fastify.log.info(`Connecting publisher transport for client ${clientId}`);
            await clientInfo.transport.connect({ dtlsParameters: data.dtlsParameters });

            fastify.log.info(`Publisher transport connected successfully for client ${clientId}`);
            connection.send(JSON.stringify({
              action: 'publisher-transport-connected',
              data: { connected: true, transportId: clientInfo.transport.id }
            }));
          } catch (error) {
            fastify.log.error(`Error connecting publisher transport: ${error.message}`);
            connection.send(JSON.stringify({
              action: 'error',
              data: { message: `Error connecting transport: ${error.message}` }
            }));
          }
          break;

        case 'produce-audio':
          if (!clientInfo.transport || !clientInfo.isPublisher || !clientInfo.channelId) {
            fastify.log.warn(`Client ${clientId} attempted to produce audio without proper transport setup`);
            connection.send(JSON.stringify({
              action: 'error',
              data: { message: 'No publisher transport connected' }
            }));
            break;
          }

          try {
            fastify.log.info(`Creating audio producer for client ${clientId}`);

            // Create producer
            const producer = await clientInfo.transport.produce({
              kind: 'audio',
              rtpParameters: data.rtpParameters
            });

            // Set up producer event handlers
            producer.on('transportclose', () => {
              fastify.log.info(`Producer transport closed for producer ${producer.id}`);
              producer.close();
            });

            producer.on('score', (score) => {
              fastify.log.debug(`Producer score update for ${producer.id}:`, score);
            });

            // Store producer
            const publishChannel = channels.get(clientInfo.channelId);
            const producerId = uuidv4();
            clientInfo.producer = { id: producerId, producer };
            publishChannel.producers.set(producerId, {
              transport: clientInfo.transport,
              producer,
              clientId
            });

            fastify.log.info(`Audio producer created successfully with id ${producer.id}`);
            connection.send(JSON.stringify({
              action: 'produced',
              data: { id: producerId }
            }));

            // Notify all clients that the channel list has changed
            broadcastChannelList();

            // Notify tenant admins about the new publisher
            notifyTenantAdmins(clientInfo.channelId);

            // Create consumers for existing listeners in the same channel
            for (const [otherId, otherClient] of clients) {
              if (
                otherClient.isListener &&
                otherClient.channelId === clientInfo.channelId &&
                otherClient.transport &&
                otherClient.rtpCapabilities
              ) {
                try {
                  if (
                    router.canConsume({
                      producerId: producer.id,
                      rtpCapabilities: otherClient.rtpCapabilities
                    })
                  ) {
                    const newConsumer = await otherClient.transport.consume({
                      producerId: producer.id,
                      rtpCapabilities: otherClient.rtpCapabilities,
                      paused: false
                    });
                    const newConsumerId = uuidv4();
                    otherClient.consumers.push({
                      id: newConsumerId,
                      consumer: newConsumer,
                      producerId
                    });
                    publishChannel.consumers.set(newConsumerId, {
                      transport: otherClient.transport,
                      consumer: newConsumer,
                      clientId: otherId,
                      displayName: otherClient.displayName,
                      producerId
                    });
                    otherClient.socket.send(
                      JSON.stringify({
                        action: 'consumer-created',
                        data: {
                          id: newConsumerId,
                          producerId,
                          kind: newConsumer.kind,
                          rtpParameters: newConsumer.rtpParameters
                        }
                      })
                    );
                  }
                } catch (err) {
                  fastify.log.error(
                    `Error creating consumer for listener ${otherId}: ${err.message}`
                  );
                }
              }
            }

            // Send listener count after consumers are created for existing listeners
            notifyPublishersListenerCount(clientInfo.channelId);
          } catch (error) {
            fastify.log.error(`Error creating producer: ${error.message}`);
            connection.send(JSON.stringify({
              action: 'error',
              data: { message: `Error creating producer: ${error.message}` }
            }));
          }
          break;

        case 'create-listener-transport':
          fastify.log.info(`Client ${clientId} requesting listener transport for channel ${data.channelId}`);

          if (!data.channelId) {
            connection.send(JSON.stringify({
              action: 'error',
              data: { message: 'Channel ID required' }
            }));
            break;
          }

          // Auto-create channel if it doesn't exist (listener will wait for publisher)
          if (!channels.has(data.channelId)) {
            channels.set(data.channelId, {
              producers: new Map(),
              consumers: new Map()
            });
            fastify.log.info(`Auto-created channel for listener: ${data.channelId}`);
            broadcastChannelList();
          }

          const listenerChannel = channels.get(data.channelId);

          try {
            // Create transport
            fastify.log.info(`Creating listener transport for client ${clientId}`);
            const listenerTransport = await createWebRtcTransport();

            // Store transport
            clientInfo.transport = listenerTransport.transport;
            clientInfo.isListener = true;
            clientInfo.channelId = data.channelId;
            clientInfo.displayName = data.displayName || 'Anonymous';

            fastify.log.info(`Listener transport created for client ${clientId} with id ${listenerTransport.transport.id}`);
            connection.send(JSON.stringify({
              action: 'listener-transport-created',
              data: listenerTransport.params
            }));
          } catch (error) {
            fastify.log.error(`Error creating listener transport: ${error.message}`);
            connection.send(JSON.stringify({
              action: 'error',
              data: { message: `Error creating listener transport: ${error.message}` }
            }));
          }
          break;

        case 'connect-listener-transport':
          if (!clientInfo.transport || !clientInfo.isListener || !clientInfo.channelId) {
            fastify.log.warn(`Client ${clientId} attempted to connect listener transport without proper setup`);
            connection.send(JSON.stringify({
              action: 'error',
              data: { message: 'No listener transport created' }
            }));
            break;
          }

          try {
            fastify.log.info(`Connecting listener transport for client ${clientId}`);
            await clientInfo.transport.connect({ dtlsParameters: data.dtlsParameters });

            fastify.log.info(`Listener transport connected successfully for client ${clientId}`);
            connection.send(JSON.stringify({
              action: 'listener-transport-connected',
              data: {
                connected: true,
                channelId: clientInfo.channelId,
                transportId: clientInfo.transport.id
              }
            }));
          } catch (error) {
            fastify.log.error(`Error connecting listener transport: ${error.message}`);
            connection.send(JSON.stringify({
              action: 'error',
              data: { message: `Error connecting transport: ${error.message}` }
            }));
          }
          break;

        case 'consume-audio':
          fastify.log.info(`Consume audio request from client ${clientId}`);

          if (!clientInfo.transport || !clientInfo.isListener || !clientInfo.channelId) {
            fastify.log.warn(`Client ${clientId} has no valid transport or is not a listener`);
            connection.send(JSON.stringify({
              action: 'error',
              data: { message: 'No listener transport connected' }
            }));
            break;
          }

          const consumerChannel = channels.get(clientInfo.channelId);
          fastify.log.info(`Client ${clientId} requesting to consume from channel ${clientInfo.channelId}`);

          if (!consumerChannel) {
            fastify.log.warn(`Channel ${clientInfo.channelId} no longer exists`);
            connection.send(JSON.stringify({
              action: 'error',
              data: { message: 'Channel no longer exists' }
            }));
            break;
          }

          if (consumerChannel.producers.size === 0) {
            fastify.log.info(`Listener ${clientId} waiting for publisher in channel ${clientInfo.channelId}`);
            clientInfo.rtpCapabilities = data.rtpCapabilities;
            connection.send(JSON.stringify({ action: 'waiting-for-publisher' }));
            break;
          }

          try {
            clientInfo.rtpCapabilities = data.rtpCapabilities;
            const consumersData = [];

            for (const [prodId, prodInfo] of consumerChannel.producers) {
              if (prodInfo.producer.closed) continue;

              if (!router.canConsume({ producerId: prodInfo.producer.id, rtpCapabilities: data.rtpCapabilities })) {
                fastify.log.warn(`Client ${clientId} cannot consume producer ${prodId} due to RTP capabilities mismatch`);
                continue;
              }

              const consumerObj = await clientInfo.transport.consume({
                producerId: prodInfo.producer.id,
                rtpCapabilities: data.rtpCapabilities,
                paused: false
              });

              const consumerId = uuidv4();
              clientInfo.consumers.push({ id: consumerId, consumer: consumerObj, producerId: prodId });
              consumerChannel.consumers.set(consumerId, {
                transport: clientInfo.transport,
                consumer: consumerObj,
                clientId,
                displayName: clientInfo.displayName,
                producerId: prodId
              });

              consumersData.push({
                id: consumerId,
                producerId: prodId,
                kind: consumerObj.kind,
                rtpParameters: consumerObj.rtpParameters
              });
            }

            connection.send(JSON.stringify({
              action: 'consumer-created',
              data: consumersData
            }));
            fastify.log.info(`Created ${consumersData.length} consumers for listener ${clientId}`);

            // Notify tenant admins about the new subscriber
            if (consumersData.length > 0) {
              notifyTenantAdmins(clientInfo.channelId);
              notifyPublishersListenerCount(clientInfo.channelId);
            }
          } catch (error) {
            fastify.log.error(`Error creating consumer for client ${clientId}: ${error.message}`);
            connection.send(JSON.stringify({
              action: 'error',
              data: { message: `Error creating consumer: ${error.message}` }
            }));
          }
          break;

        case 'stop-broadcasting':
          fastify.log.info(`Client ${clientId} stopping broadcasting in channel ${data.channelId}`);

          if (!data.channelId || !channels.has(data.channelId)) {
            fastify.log.warn(`Channel ${data.channelId} does not exist`);
            break;
          }

          const stopBroadcastChannel = channels.get(data.channelId);

          try {
            fastify.log.info(`Cleaning up publisher resources for channel ${data.channelId}`);

            if (clientInfo.isPublisher && clientInfo.producer) {
              const { id: prodId, producer } = clientInfo.producer;
              if (producer) {
                try {
                  producer.close();
                } catch (error) {
                  fastify.log.error(`Error closing producer: ${error.message}`);
                }
              }

              if (clientInfo.transport) {
                try {
                  clientInfo.transport.close();
                } catch { }
              }

              stopBroadcastChannel.producers.delete(prodId);

              // Remove related consumers
              for (const [consumerId, consumer] of stopBroadcastChannel.consumers) {
                if (consumer.producerId === prodId) {
                  if (consumer.consumer) consumer.consumer.close();
                  stopBroadcastChannel.consumers.delete(consumerId);
                  if (consumer.clientId && clients.has(consumer.clientId)) {
                    const listenerClient = clients.get(consumer.clientId);
                    listenerClient.consumers = listenerClient.consumers.filter(c => c.id !== consumerId);
                    listenerClient.socket.send(JSON.stringify({ action: 'producer-stopped', data: { producerId: prodId } }));
                  }
                }
              }

              clientInfo.isPublisher = false;
              clientInfo.producer = null;
              clientInfo.transport = null;
            }

            // Notify all clients that the channel list has changed
            broadcastChannelList();

            // Notify tenant admins about the publisher leaving
            notifyTenantAdmins(data.channelId);

            // Send confirmation to the client
            connection.send(JSON.stringify({
              action: 'broadcasting-stopped',
              data: { channelId: data.channelId }
            }));

            fastify.log.info(`Publisher resources cleaned up for channel ${data.channelId}`);
          } catch (error) {
            fastify.log.error(`Error cleaning up publisher resources: ${error.message}`);
            connection.send(JSON.stringify({
              action: 'error',
              data: { message: `Error stopping broadcast: ${error.message}` }
            }));
          }
          break;

        case 'leave-channel':
          fastify.log.info(`Client ${clientId} leaving channel`);

          if (clientInfo.isListener && clientInfo.channelId && channels.has(clientInfo.channelId)) {
            const channel = channels.get(clientInfo.channelId);
            fastify.log.info(`Removing listener from channel ${clientInfo.channelId}`);

            // Remove all consumers for this listener
            for (const [consumerId, consumer] of channel.consumers) {
              if (consumer.clientId === clientId) {
                if (consumer.consumer) {
                  try { consumer.consumer.close(); } catch { }
                }
                channel.consumers.delete(consumerId);
              }
            }

            if (clientInfo.transport) {
              try { clientInfo.transport.close(); } catch { }
            }

            clientInfo.consumers = [];

            // Notify tenant admins about the subscriber leaving
            notifyTenantAdmins(clientInfo.channelId);
            notifyPublishersListenerCount(clientInfo.channelId);

            // Reset client info
            clientInfo.isListener = false;
            clientInfo.channelId = null;
            clientInfo.transport = null;
            clientInfo.consumers = [];
          }
          break;

        default:
          fastify.log.warn('Unknown action', action);
      }
    });

    // Handle WebSocket connection close
    connection.on('close', () => {
      fastify.log.info(`Connection closed: ${clientId}`);

      // Clean up resources
      if (clientInfo.transport) {
        clientInfo.transport.close();
      }

      if (clientInfo.isPublisher && clientInfo.channelId && channels.has(clientInfo.channelId)) {
        const channel = channels.get(clientInfo.channelId);

        if (clientInfo.producer) {
          const { id: prodId, producer } = clientInfo.producer;
          if (producer) {
            try { producer.close(); } catch { }
          }
          channel.producers.delete(prodId);

          for (const [consumerId, consumer] of channel.consumers) {
            if (consumer.producerId === prodId) {
              if (consumer.consumer) {
                try { consumer.consumer.close(); } catch { }
              }
              if (consumer.clientId && clients.has(consumer.clientId)) {
                const listenerClient = clients.get(consumer.clientId);
                listenerClient.consumers = listenerClient.consumers.filter(c => c.id !== consumerId);
                listenerClient.socket.send(JSON.stringify({ action: 'producer-stopped', data: { producerId: prodId } }));
              }
              channel.consumers.delete(consumerId);
            }
          }
        }

        // Notify tenant admins about the publisher disconnect
        notifyTenantAdmins(clientInfo.channelId);
        // Notify remaining publishers about updated listener count
        notifyPublishersListenerCount(clientInfo.channelId);
      }

      if (clientInfo.isListener && clientInfo.channelId && channels.has(clientInfo.channelId)) {
        const channel = channels.get(clientInfo.channelId);

        // Remove consumer from channel
        for (const [consumerId, consumer] of channel.consumers) {
          if (consumer.clientId === clientId) {
            if (consumer.consumer) {
              try { consumer.consumer.close(); } catch { }
            }
            channel.consumers.delete(consumerId);
          }
        }
        clientInfo.consumers = [];

        // Notify tenant admins about the listener disconnect
        notifyTenantAdmins(clientInfo.channelId);
        notifyPublishersListenerCount(clientInfo.channelId);
      }

      // Remove client from clients map
      clients.delete(clientId);
    });
  });
}

// Room-based WebSocket endpoints for multi-tenant support
async function registerRoomWsRoutes(fastify) {
  // Listener endpoint: /ws/room/:slug/listen
  fastify.get('/ws/room/:slug/listen', { websocket: true }, (connection, req) => {
    const { slug } = req.params;
    const clientId = uuidv4();

    fastify.log.info(`New listener connection for room: ${slug}, client: ${clientId}`);

    // Verify room exists
    const room = getRoomBySlug(slug);

    if (!room) {
      fastify.log.warn(`Room not found: ${slug}`);
      connection.send(JSON.stringify({
        type: 'error',
        data: { message: 'Room not found' }
      }));
      connection.close();
      return;
    }

    // Parse ICE servers from JSON and generate dynamic TURN credentials
    let iceServers;
    try {
      const rawIceServers = JSON.parse(room.coturn_config_json);
      iceServers = processIceServers(rawIceServers);
    } catch (e) {
      fastify.log.error(`Invalid coturn_config_json for room ${slug}: ${e.message}`);
      connection.send(JSON.stringify({
        type: 'error',
        data: { message: 'Invalid room configuration' }
      }));
      connection.close();
      return;
    }

    // Get available channels for this room
    const channels = getChannelsByRoom(room.id);

    // Rewrite SFU URL to wss:// if client connected securely
    const sfuUrl = getSecureSfuUrl(room.sfu_url, req);

    // Prepare configuration message with channels
    const config = {
      type: 'config',
      data: {
        sfuUrl: sfuUrl,
        iceServers: iceServers,
        isLocalOnly: room.is_local_only,
        channels: channels,
        roomSlug: slug
      }
    };

    // Handle messages (WebRTC signaling relay)
    connection.on('message', async (message) => {
      try {
        const payload = JSON.parse(message.toString());

        if (payload.type === 'get-config') {
          // Client requests config after handlers are ready (fixes iOS Safari timing issue)
          connection.send(JSON.stringify(config));
          fastify.log.info(`Config sent to listener ${clientId} for room ${slug}, sfuUrl: ${sfuUrl}, channels: ${channels.join(', ')}`);
        } else if (payload.type === 'webrtc_signal') {
          // In a full implementation, this would relay to the SFU
          // For now, we just log it
          fastify.log.info(`WebRTC signal from listener ${clientId}: ${payload.data.payload.type}`);
        }
      } catch (e) {
        fastify.log.error(`Invalid message from listener ${clientId}: ${e.message}`);
      }
    });

    connection.on('close', () => {
      fastify.log.info(`Listener ${clientId} disconnected from room ${slug}`);
    });
  });

  // Publisher endpoint: /ws/room/:slug/publish?token=xxx
  fastify.get('/ws/room/:slug/publish', { websocket: true }, (connection, req) => {
    const { slug } = req.params;
    const token = req.query.token;
    const clientId = uuidv4();

    fastify.log.info(`New publisher connection for room: ${slug}, client: ${clientId}`);

    // Verify token is provided
    if (!token) {
      fastify.log.warn(`Missing token for publisher connection to room ${slug}`);
      connection.send(JSON.stringify({
        type: 'error',
        data: { message: 'Missing token' }
      }));
      connection.close();
      return;
    }

    // Verify publisher token
    const publisher = verifyPublisherToken(token);

    if (!publisher) {
      fastify.log.warn(`Invalid token for publisher connection to room ${slug}`);
      connection.send(JSON.stringify({
        type: 'error',
        data: { message: 'Invalid token' }
      }));
      connection.close();
      return;
    }

    // Verify room exists and matches publisher's room
    const room = getRoomBySlug(slug);

    if (!room) {
      fastify.log.warn(`Room not found: ${slug}`);
      connection.send(JSON.stringify({
        type: 'error',
        data: { message: 'Room not found' }
      }));
      connection.close();
      return;
    }

    if (room.id !== publisher.room_id) {
      fastify.log.warn(`Publisher ${publisher.id} attempted to join wrong room ${slug}`);
      connection.send(JSON.stringify({
        type: 'error',
        data: { message: 'Token not valid for this room' }
      }));
      connection.close();
      return;
    }

    // Parse ICE servers from JSON and generate dynamic TURN credentials
    let iceServers;
    try {
      const rawIceServers = JSON.parse(room.coturn_config_json);
      iceServers = processIceServers(rawIceServers);
    } catch (e) {
      fastify.log.error(`Invalid coturn_config_json for room ${slug}: ${e.message}`);
      connection.send(JSON.stringify({
        type: 'error',
        data: { message: 'Invalid room configuration' }
      }));
      connection.close();
      return;
    }

    // Rewrite SFU URL to wss:// if client connected securely
    const sfuUrl = getSecureSfuUrl(room.sfu_url, req);

    // Prepare configuration message with channel name
    const config = {
      type: 'config',
      data: {
        sfuUrl: sfuUrl,
        iceServers: iceServers,
        isLocalOnly: room.is_local_only,
        channelName: publisher.channel_name
      }
    };

    // Handle messages (WebRTC signaling relay)
    connection.on('message', async (message) => {
      try {
        const payload = JSON.parse(message.toString());

        if (payload.type === 'get-config') {
          // Client requests config after handlers are ready (fixes iOS Safari timing issue)
          connection.send(JSON.stringify(config));
          fastify.log.info(`Config sent to publisher ${clientId} (${publisher.name}) for room ${slug}, sfuUrl: ${sfuUrl}, channel: ${publisher.channel_name}`);
        } else if (payload.type === 'webrtc_signal') {
          // In a full implementation, this would relay to the SFU
          // For now, we just log it
          fastify.log.info(`WebRTC signal from publisher ${clientId}: ${payload.data.payload.type}`);
        }
      } catch (e) {
        fastify.log.error(`Invalid message from publisher ${clientId}: ${e.message}`);
      }
    });

    connection.on('close', () => {
      fastify.log.info(`Publisher ${clientId} (${publisher.name}) disconnected from room ${slug}`);
    });
  });
}

// Tenant Admin WebSocket endpoint
async function registerAdminWsRoutes(fastify) {
  // Admin endpoint: /ws/admin?apiKey=xxx
  fastify.get('/ws/admin', { websocket: true }, (connection, req) => {
    const apiKey = req.query.apiKey;

    // Verify API key
    if (!apiKey) {
      fastify.log.warn('Missing API key for admin WebSocket connection');
      connection.send(JSON.stringify({
        type: 'error',
        data: { message: 'Missing API key' }
      }));
      connection.close();
      return;
    }

    const tenant = verifyTenantApiKey(apiKey);
    if (!tenant) {
      fastify.log.warn('Invalid API key for admin WebSocket connection');
      connection.send(JSON.stringify({
        type: 'error',
        data: { message: 'Invalid API key' }
      }));
      connection.close();
      return;
    }

    fastify.log.info(`Tenant admin connected: ${tenant.name} (ID: ${tenant.id})`);

    // Add to tenantAdminClients Map
    if (!tenantAdminClients.has(tenant.id)) {
      tenantAdminClients.set(tenant.id, new Set());
    }
    tenantAdminClients.get(tenant.id).add(connection);

    // Send initial channel stats
    const stats = getChannelStatsForTenant(tenant.id);
    connection.send(JSON.stringify({
      type: 'channel-stats',
      stats
    }));

    connection.on('message', async (message) => {
      try {
        const payload = JSON.parse(message.toString());

        if (payload.type === 'refresh') {
          // Send updated stats
          const stats = getChannelStatsForTenant(tenant.id);
          connection.send(JSON.stringify({
            type: 'channel-stats',
            stats
          }));
        }
      } catch (e) {
        fastify.log.error(`Invalid message from tenant admin: ${e.message}`);
      }
    });

    connection.on('close', () => {
      fastify.log.info(`Tenant admin disconnected: ${tenant.name}`);
      const sockets = tenantAdminClients.get(tenant.id);
      if (sockets) {
        sockets.delete(connection);
        if (sockets.size === 0) {
          tenantAdminClients.delete(tenant.id);
        }
      }
    });
  });

  // SFU Stats endpoint: /ws/sfu-stats?secretKey=xxx
  fastify.get('/ws/sfu-stats', { websocket: true }, (connection, req) => {
    const secretKey = req.query.secretKey;

    // Verify secret key
    if (!secretKey) {
      fastify.log.warn('Missing secret key for SFU stats WebSocket connection');
      connection.send(JSON.stringify({
        type: 'error',
        data: { message: 'Missing secret key' }
      }));
      connection.close();
      return;
    }

    const sfu = verifySfuSecretKey(secretKey);
    if (!sfu) {
      fastify.log.warn('Invalid secret key for SFU stats WebSocket connection');
      connection.send(JSON.stringify({
        type: 'error',
        data: { message: 'Invalid secret key' }
      }));
      connection.close();
      return;
    }

    fastify.log.info(`SFU stats connected: ${sfu.name || 'unnamed'} (ID: ${sfu.id})`);

    // Store connection
    sfuStatsClients.set(sfu.id, connection);

    // Initialize empty stats for this SFU
    localSfuStats.set(sfu.id, { channels: {} });

    // Send acknowledgment
    connection.send(JSON.stringify({
      type: 'connected',
      sfuId: sfu.id
    }));

    connection.on('message', async (message) => {
      try {
        const payload = JSON.parse(message.toString());

        if (payload.type === 'stats-update') {
          fastify.log.info(`Received stats-update from SFU ${sfu.id}: ${JSON.stringify(payload.channels)}`);

          // Update local SFU stats
          const previousStats = localSfuStats.get(sfu.id) || { channels: {} };
          localSfuStats.set(sfu.id, { channels: payload.channels || {} });

          // Notify tenant admins for each channel that changed
          for (const channelName in payload.channels) {
            const newStats = payload.channels[channelName];
            const oldStats = previousStats.channels?.[channelName];

            // Only notify if stats changed
            if (!oldStats ||
              oldStats.publishers !== newStats.publishers ||
              oldStats.subscribers !== newStats.subscribers) {
              fastify.log.info(`Stats changed for channel ${channelName}, notifying tenant admins...`);
              notifyTenantAdminsFromSfu(sfu.id, channelName, newStats);
            }
          }

          // Check for removed channels
          for (const channelName in previousStats.channels) {
            if (!(channelName in (payload.channels || {}))) {
              notifyTenantAdminsFromSfu(sfu.id, channelName, { publishers: 0, subscribers: 0 });
            }
          }
        }
      } catch (e) {
        fastify.log.error(`Invalid message from SFU ${sfu.id}: ${e.message}`);
      }
    });

    connection.on('close', () => {
      fastify.log.info(`SFU stats disconnected: ${sfu.name || 'unnamed'} (ID: ${sfu.id})`);
      sfuStatsClients.delete(sfu.id);

      // Clear stats and notify admins about offline channels
      const oldStats = localSfuStats.get(sfu.id);
      if (oldStats?.channels) {
        for (const channelName in oldStats.channels) {
          notifyTenantAdminsFromSfu(sfu.id, channelName, { publishers: 0, subscribers: 0 });
        }
      }
      localSfuStats.delete(sfu.id);
    });
  });
}

// Register all WebSocket routes on a Fastify instance
function registerAllWsRoutes(fastifyInstance) {
  fastifyInstance.register(registerMainWsRoutes);
  fastifyInstance.register(registerRoomWsRoutes);
  fastifyInstance.register(registerAdminWsRoutes);
}

// Register WebSocket routes on HTTP server
registerAllWsRoutes(fastify);

const PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';

// TLS certificate paths
const TLS_KEY_PATH = process.env.TLS_KEY_PATH || './certs/server.key';
const TLS_CERT_PATH = process.env.TLS_CERT_PATH || './certs/server.crt';

// Create HTTPS Fastify instance if certificates exist
let fastifyHttps = null;

function createHttpsServer() {
  if (!fs.existsSync(TLS_KEY_PATH) || !fs.existsSync(TLS_CERT_PATH)) {
    console.log('TLS certificates not found, HTTPS server will not start');
    console.log(`  Key path: ${TLS_KEY_PATH}`);
    console.log(`  Cert path: ${TLS_CERT_PATH}`);
    return null;
  }

  const httpsOptions = {
    key: fs.readFileSync(TLS_KEY_PATH),
    cert: fs.readFileSync(TLS_CERT_PATH)
  };

  fastifyHttps = Fastify({
    logger: true,
    https: httpsOptions
  });

  // Register same plugins and routes for HTTPS server
  fastifyHttps.register(fastifyStatic, {
    root: publicDir,
    prefix: '/'
  });

  fastifyHttps.register(fastifyWebsocket, {
    options: {
      maxPayload: 1048576
    }
  });

  fastifyHttps.register(registerApiRoutes);
  fastifyHttps.register(registerSfuRoutes);

  // Register WebSocket routes on HTTPS server
  registerAllWsRoutes(fastifyHttps);

  // Room-specific HTML routes
  fastifyHttps.get('/room/:slug/publish', async (request, reply) => {
    const { slug } = request.params;
    const room = getRoomBySlug(slug);
    if (!room) {
      return reply.code(404).send('Room not found');
    }
    return reply.sendFile('room-publish.html');
  });

  fastifyHttps.get('/room/:slug/listen', async (request, reply) => {
    const { slug } = request.params;
    const room = getRoomBySlug(slug);
    if (!room) {
      return reply.code(404).send('Room not found');
    }
    return reply.sendFile('room-listen.html');
  });

  fastifyHttps.get('/tenant-admin', async (request, reply) => {
    return reply.sendFile('tenant-admin.html');
  });

  return fastifyHttps;
}

// Main async entry point
async function main() {
  // Create mediasoup Worker
  worker = await mediasoup.createWorker({
    rtcMinPort: mediasoupConfig.rtcMinPort,
    rtcMaxPort: mediasoupConfig.rtcMaxPort,
    logLevel: 'warn',
    logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp']
  });
  worker.on('died', () => {
    fastify.log.error('mediasoup worker died, exiting...');
    setTimeout(() => process.exit(1), 2000);
  });

  // Create Router
  router = await worker.createRouter({ mediaCodecs });

  // Start HTTP server
  try {
    await fastify.listen({ port: PORT, host: HOST });
    fastify.log.info(`HTTP server listening on ${HOST}:${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }

  // Start HTTPS server if certificates are available
  const httpsServer = createHttpsServer();
  if (httpsServer) {
    try {
      await httpsServer.listen({ port: HTTPS_PORT, host: HOST });
      console.log(`HTTPS server listening on ${HOST}:${HTTPS_PORT}`);
    } catch (err) {
      console.error('Failed to start HTTPS server:', err);
    }
  }
}

main();
