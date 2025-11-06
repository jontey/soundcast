import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import mediasoup from 'mediasoup';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { initDatabase } from './db/database.js';
import { registerApiRoutes } from './routes/api.js';
import { getRoomBySlug } from './db/models/room.js';
import { verifyInterpreterToken } from './db/models/interpreter.js';

// ES module equivalent for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create fastify instance
const fastify = Fastify({
  logger: true
});

// Initialize database
const dbPath = process.env.DB_PATH || './soundcast.db';
initDatabase(dbPath);
console.log('Database initialized');

// Fastify setup
fastify.register(fastifyStatic, {
  root: path.join(__dirname, 'public'),
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

// mediasoup Worker
const worker = await mediasoup.createWorker({
  rtcMinPort: process.env.MEDIASOUP_MIN_PORT || 20000,
  rtcMaxPort: process.env.MEDIASOUP_MAX_PORT || 30000,
  logLevel: 'warn',
  logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp']
});
worker.on('died', () => {
  fastify.log.error('mediasoup worker died, exiting...');
  setTimeout(() => process.exit(1), 2000);
});

// Router: audio only
const mediaCodecs = [{
  kind: 'audio',
  mimeType: 'audio/opus',
  clockRate: 48000,
  channels: 2
  }];
const router = await worker.createRouter({ mediaCodecs });

// In-memory channel store
// channelId -> { producers: Map<producerId, { transport, producer, clientId }>, consumers: Map }
const channels = new Map();

// Store active connections
const clients = new Map();
  
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

// Helper to create WebRTC transport
async function createWebRtcTransport() {
    const transport = await router.createWebRtcTransport({
      listenIps: [
        // For local development, we'll still need this
        { ip: process.env.LISTEN_IP || '0.0.0.0', announcedIp: process.env.ANNOUNCED_IP || '127.0.0.1' }
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      // Add SCTP for data channels if needed
      // enableSctp: true,
      // numSctpStreams: { OS: 1024, MIS: 1024 }
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

// WebSocket route handler
fastify.register(async function (fastify) {
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
            if (!data.channelId || !channels.has(data.channelId)) {
              connection.send(JSON.stringify({
                action: 'error',
                data: { message: 'Channel does not exist' }
              }));
              break;
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
            
            if (!data.channelId || !channels.has(data.channelId)) {
              fastify.log.warn(`Client ${clientId} requested non-existent channel ${data.channelId}`);
              connection.send(JSON.stringify({
                action: 'error',
                data: { message: 'Channel does not exist' }
              }));
              break;
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
                  } catch {}
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
                    try { consumer.consumer.close(); } catch {}
                  }
                  channel.consumers.delete(consumerId);
                }
              }

              if (clientInfo.transport) {
                try { clientInfo.transport.close(); } catch {}
              }

              clientInfo.consumers = [];
              
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
              try { producer.close(); } catch {}
            }
            channel.producers.delete(prodId);

            for (const [consumerId, consumer] of channel.consumers) {
              if (consumer.producerId === prodId) {
                if (consumer.consumer) {
                  try { consumer.consumer.close(); } catch {}
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
        }

        if (clientInfo.isListener && clientInfo.channelId && channels.has(clientInfo.channelId)) {
          const channel = channels.get(clientInfo.channelId);

          // Remove consumer from channel
          for (const [consumerId, consumer] of channel.consumers) {
            if (consumer.clientId === clientId) {
              if (consumer.consumer) {
                try { consumer.consumer.close(); } catch {}
              }
              channel.consumers.delete(consumerId);
            }
          }
          clientInfo.consumers = [];
        }
        
        // Remove client from clients map
        clients.delete(clientId);
      });
    });
  });

// Room-based WebSocket endpoints for multi-tenant support
fastify.register(async function (fastify) {
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

    // Parse ICE servers from JSON
    let iceServers;
    try {
      iceServers = JSON.parse(room.coturn_config_json);
    } catch (e) {
      fastify.log.error(`Invalid coturn_config_json for room ${slug}: ${e.message}`);
      connection.send(JSON.stringify({
        type: 'error',
        data: { message: 'Invalid room configuration' }
      }));
      connection.close();
      return;
    }

    // Send configuration message
    const config = {
      type: 'config',
      data: {
        sfuUrl: room.sfu_url,
        iceServers: iceServers,
        isLocalOnly: room.is_local_only
      }
    };

    connection.send(JSON.stringify(config));
    fastify.log.info(`Config sent to listener ${clientId} for room ${slug}`);

    // Handle messages (WebRTC signaling relay)
    connection.on('message', async (message) => {
      try {
        const payload = JSON.parse(message.toString());

        if (payload.type === 'webrtc_signal') {
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

  // Interpreter endpoint: /ws/room/:slug/interpret?token=xxx
  fastify.get('/ws/room/:slug/interpret', { websocket: true }, (connection, req) => {
    const { slug } = req.params;
    const token = req.query.token;
    const clientId = uuidv4();

    fastify.log.info(`New interpreter connection for room: ${slug}, client: ${clientId}`);

    // Verify token is provided
    if (!token) {
      fastify.log.warn(`Missing token for interpreter connection to room ${slug}`);
      connection.send(JSON.stringify({
        type: 'error',
        data: { message: 'Missing token' }
      }));
      connection.close();
      return;
    }

    // Verify interpreter token
    const interpreter = verifyInterpreterToken(token);

    if (!interpreter) {
      fastify.log.warn(`Invalid token for interpreter connection to room ${slug}`);
      connection.send(JSON.stringify({
        type: 'error',
        data: { message: 'Invalid token' }
      }));
      connection.close();
      return;
    }

    // Verify room exists and matches interpreter's room
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

    if (room.id !== interpreter.room_id) {
      fastify.log.warn(`Interpreter ${interpreter.id} attempted to join wrong room ${slug}`);
      connection.send(JSON.stringify({
        type: 'error',
        data: { message: 'Token not valid for this room' }
      }));
      connection.close();
      return;
    }

    // Parse ICE servers from JSON
    let iceServers;
    try {
      iceServers = JSON.parse(room.coturn_config_json);
    } catch (e) {
      fastify.log.error(`Invalid coturn_config_json for room ${slug}: ${e.message}`);
      connection.send(JSON.stringify({
        type: 'error',
        data: { message: 'Invalid room configuration' }
      }));
      connection.close();
      return;
    }

    // Send configuration message with target language
    const config = {
      type: 'config',
      data: {
        sfuUrl: room.sfu_url,
        iceServers: iceServers,
        isLocalOnly: room.is_local_only,
        targetLanguage: interpreter.target_language
      }
    };

    connection.send(JSON.stringify(config));
    fastify.log.info(`Config sent to interpreter ${clientId} (${interpreter.name}) for room ${slug}`);

    // Handle messages (WebRTC signaling relay)
    connection.on('message', async (message) => {
      try {
        const payload = JSON.parse(message.toString());

        if (payload.type === 'webrtc_signal') {
          // In a full implementation, this would relay to the SFU
          // For now, we just log it
          fastify.log.info(`WebRTC signal from interpreter ${clientId}: ${payload.data.payload.type}`);
        }
      } catch (e) {
        fastify.log.error(`Invalid message from interpreter ${clientId}: ${e.message}`);
      }
    });

    connection.on('close', () => {
      fastify.log.info(`Interpreter ${clientId} (${interpreter.name}) disconnected from room ${slug}`);
    });
  });
});

  const PORT = process.env.PORT || 3000;
  const HOST = process.env.HOST || '0.0.0.0';
  
try {
  await fastify.listen({ port: PORT, host: HOST });
  fastify.log.info(`Server listening on ${HOST}:${PORT}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
