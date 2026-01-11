import { getRoomBySlug } from '../db/models/room.js';
import { getTranscriptsByRoom, getRecentTranscripts, countTranscripts } from '../db/models/transcript.js';
import { vectorStore } from '../transcription/vector-store.js';
import { startTranscription, stopTranscription, getTranscriptionSession, getSessionStats } from '../transcription/transcriber.js';
import { getDatabase } from '../db/database.js';

/**
 * Register transcription API routes
 * @param {object} fastify - Fastify instance
 * @param {function} authenticateTenant - Tenant authentication middleware
 */
export function registerTranscriptionRoutes(fastify, authenticateTenant) {
  // Access router and channels from fastify decorators (set in main())
  const getRouter = () => fastify.mediasoupRouter;
  const getChannels = () => fastify.mediasoupChannels;
  /**
   * GET /api/rooms/:slug/transcripts
   * Get transcripts for a room with optional filters
   */
  fastify.get(
    '/api/rooms/:slug/transcripts',
    { preHandler: authenticateTenant },
    async (request, reply) => {
      const { slug } = request.params;
      const {
        channel,
        startTime,
        endTime,
        limit = 100,
        offset = 0,
        recent
      } = request.query;

      const room = getRoomBySlug(slug);
      if (!room) {
        return reply.status(404).send({ error: 'Room not found' });
      }

      // Check tenant access
      if (room.tenant_id !== request.tenant.id) {
        return reply.status(403).send({ error: 'Access denied' });
      }

      try {
        let transcripts;

        if (recent) {
          // Get recent transcripts (default: last 60 minutes)
          const minutes = parseInt(recent) || 60;
          transcripts = getRecentTranscripts(room.id, minutes, channel);
        } else {
          // Get transcripts with filters
          const options = {
            limit: parseInt(limit),
            offset: parseInt(offset),
            channelName: channel,
            startTime: startTime ? parseFloat(startTime) : undefined,
            endTime: endTime ? parseFloat(endTime) : undefined
          };

          transcripts = getTranscriptsByRoom(room.id, options);
        }

        // Get total count
        const total = countTranscripts(room.id, channel);

        return {
          transcripts,
          total,
          limit: parseInt(limit),
          offset: parseInt(offset)
        };
      } catch (err) {
        console.error('[TranscriptionAPI] Error fetching transcripts:', err);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  /**
   * GET /api/rooms/:slug/transcripts/search
   * Semantic search for transcripts
   */
  fastify.get(
    '/api/rooms/:slug/transcripts/search',
    { preHandler: authenticateTenant },
    async (request, reply) => {
      const { slug } = request.params;
      const {
        q: query,
        channel,
        limit = 10,
        minScore = 0.5
      } = request.query;

      if (!query) {
        return reply.status(400).send({ error: 'Query parameter "q" is required' });
      }

      const room = getRoomBySlug(slug);
      if (!room) {
        return reply.status(404).send({ error: 'Room not found' });
      }

      // Check tenant access
      if (room.tenant_id !== request.tenant.id) {
        return reply.status(403).send({ error: 'Access denied' });
      }

      try {
        const results = await vectorStore.searchSimilar(query, room.id, {
          limit: parseInt(limit),
          minScore: parseFloat(minScore),
          channelName: channel
        });

        return {
          query,
          results,
          count: results.length
        };
      } catch (err) {
        console.error('[TranscriptionAPI] Search error:', err);
        return reply.status(500).send({ error: 'Search failed' });
      }
    }
  );

  /**
   * GET /api/rooms/:slug/transcripts/stats
   * Get transcription statistics for a room
   */
  fastify.get(
    '/api/rooms/:slug/transcripts/stats',
    { preHandler: authenticateTenant },
    async (request, reply) => {
      const { slug } = request.params;

      const room = getRoomBySlug(slug);
      if (!room) {
        return reply.status(404).send({ error: 'Room not found' });
      }

      // Check tenant access
      if (room.tenant_id !== request.tenant.id) {
        return reply.status(403).send({ error: 'Access denied' });
      }

      try {
        const total = countTranscripts(room.id);
        const recentCount = getRecentTranscripts(room.id, 60).length;

        // Get channel breakdown
        const db = fastify.db || require('../db/database.js').getDatabase();
        const channelStatsStmt = db.prepare(`
          SELECT channel_name, COUNT(*) as count
          FROM transcripts
          WHERE room_id = ?
          GROUP BY channel_name
        `);
        const channelStats = channelStatsStmt.all(room.id);

        return {
          total,
          recentCount,
          channelStats
        };
      } catch (err) {
        console.error('[TranscriptionAPI] Stats error:', err);
        return reply.status(500).send({ error: 'Failed to get stats' });
      }
    }
  );

  /**
   * POST /api/rooms/:slug/transcription/start
   * Start transcription for a specific channel in the room
   */
  fastify.post(
    '/api/rooms/:slug/transcription/start',
    { preHandler: authenticateTenant },
    async (request, reply) => {
      const { slug } = request.params;
      const { channelName = 'default', language = 'en', modelPath } = request.body;

      const room = getRoomBySlug(slug);
      if (!room) {
        return reply.status(404).send({ error: 'Room not found' });
      }

      if (room.tenant_id !== request.tenant.id) {
        return reply.status(403).send({ error: 'Access denied' });
      }

      const router = getRouter();
      const channels = getChannels();

      if (!router || !channels) {
        return reply.status(503).send({ error: 'Transcription service not initialized' });
      }

      try {
        const fullChannelId = `${slug}:${channelName}`;
        const channel = channels.get(fullChannelId);

        // Check if channel exists and has active publishers
        if (!channel || !channel.producers || channel.producers.size === 0) {
          // No active publishers yet - verify channel exists in database via publishers
          const db = getDatabase();
          const publishers = db.prepare(`
            SELECT id, name, channel_name, transcription_language
            FROM publishers
            WHERE room_id = ? AND channel_name = ?
          `).all(room.id, channelName);

          if (publishers.length === 0) {
            return reply.status(404).send({
              error: `No publishers configured for channel "${channelName}". Add a publisher first.`
            });
          }

          // Store configuration for when publishers connect
          return reply.send({
            message: `Transcription configured for channel "${channelName}". Will start automatically when publishers connect.`,
            channelName,
            language,
            modelPath,
            publishersConfigured: publishers.length
          });
        }

        // Active publishers found - start transcription immediately
        const sessions = [];
        const errors = [];
        let alreadyRunningCount = 0;

        for (const [producerId, producerInfo] of channel.producers) {
          const existingSession = getTranscriptionSession(producerId);
          if (existingSession) {
            alreadyRunningCount++;
            console.log(`[TranscriptionAPI] Transcription already running for producer ${producerId}`);
            continue;
          }

          try {
            const session = await startTranscription(room.id, producerInfo.producer, {
              channelName,
              producerName: producerInfo.clientId || 'Unknown',
              language,
              roomSlug: slug,
              modelPath
            });

            if (session) {
              sessions.push({
                sessionId: producerId,
                producerId,
                channelName,
                language
              });
              console.log(`[TranscriptionAPI] Started transcription for producer ${producerId}`);
            } else {
              errors.push(`Producer ${producerId}: startTranscription returned null`);
            }
          } catch (err) {
            console.error(`[TranscriptionAPI] Failed to start session for producer ${producerId}:`, err);
            errors.push(`Producer ${producerId}: ${err.message}`);
          }
        }

        if (sessions.length === 0) {
          let errorMsg = 'Failed to start any transcription sessions. ';

          if (alreadyRunningCount > 0) {
            errorMsg += `${alreadyRunningCount} session(s) already running. `;
          }

          if (errors.length > 0) {
            errorMsg += `Errors: ${errors.join('; ')}`;
          }

          return reply.status(400).send({ error: errorMsg.trim() });
        }

        return {
          message: 'Transcription started',
          sessions
        };
      } catch (err) {
        console.error('[TranscriptionAPI] Start transcription error:', err);
        return reply.status(500).send({ error: 'Failed to start transcription' });
      }
    }
  );

  /**
   * POST /api/rooms/:slug/transcription/stop
   * Stop transcription session(s) for a room
   */
  fastify.post(
    '/api/rooms/:slug/transcription/stop',
    { preHandler: authenticateTenant },
    async (request, reply) => {
      const { slug } = request.params;
      const { sessionId, channelName } = request.body;

      const room = getRoomBySlug(slug);
      if (!room) {
        return reply.status(404).send({ error: 'Room not found' });
      }

      if (room.tenant_id !== request.tenant.id) {
        return reply.status(403).send({ error: 'Access denied' });
      }

      const router = getRouter();
      const channels = getChannels();

      if (!router || !channels) {
        return reply.status(503).send({ error: 'Transcription service not initialized' });
      }

      try {
        const stopped = [];

        if (sessionId) {
          const session = getTranscriptionSession(sessionId);
          if (session) {
            const startTime = session.startTime;
            const duration = (Date.now() - startTime) / 1000;
            const segmentsProcessed = session.audioChunkCount || 0;

            await stopTranscription(sessionId);
            stopped.push({
              sessionId,
              duration,
              segmentsProcessed
            });
          }
        } else if (channelName) {
          const fullChannelId = `${slug}:${channelName}`;
          const channel = channels.get(fullChannelId);

          if (channel && channel.producers) {
            for (const [producerId] of channel.producers) {
              const session = getTranscriptionSession(producerId);
              if (session) {
                const startTime = session.startTime;
                const duration = (Date.now() - startTime) / 1000;
                const segmentsProcessed = session.audioChunkCount || 0;

                await stopTranscription(producerId);
                stopped.push({
                  sessionId: producerId,
                  duration,
                  segmentsProcessed
                });
              }
            }
          }
        } else {
          return reply.status(400).send({ error: 'Either sessionId or channelName is required' });
        }

        if (stopped.length === 0) {
          return reply.status(404).send({ error: 'No active transcription sessions found' });
        }

        return {
          message: 'Transcription stopped',
          stopped
        };
      } catch (err) {
        console.error('[TranscriptionAPI] Stop transcription error:', err);
        return reply.status(500).send({ error: 'Failed to stop transcription' });
      }
    }
  );

  /**
   * GET /api/rooms/:slug/transcription/status
   * Get status of all active transcription sessions for a room
   */
  fastify.get(
    '/api/rooms/:slug/transcription/status',
    { preHandler: authenticateTenant },
    async (request, reply) => {
      const { slug } = request.params;

      const room = getRoomBySlug(slug);
      if (!room) {
        return reply.status(404).send({ error: 'Room not found' });
      }

      if (room.tenant_id !== request.tenant.id) {
        return reply.status(403).send({ error: 'Access denied' });
      }

      try {
        const sessions = getSessionStats(room.id);

        return {
          sessions
        };
      } catch (err) {
        console.error('[TranscriptionAPI] Status error:', err);
        return reply.status(500).send({ error: 'Failed to get transcription status' });
      }
    }
  );
}

export default registerTranscriptionRoutes;
