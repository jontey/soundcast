import { authenticateTenant } from '../middleware/auth.js';
import { createRoom, getRoomBySlug, updateRoom, listRoomsByTenant, deleteRoom } from '../db/models/room.js';
import { createPublisher, listPublishersByRoom, deletePublisher, getPublisherById, updatePublisher } from '../db/models/publisher.js';
import { startRecording, stopRecording, getRecordingStatus, isRecording } from '../recording/recorder.js';
import { listRecordingsByRoomId } from '../db/models/recording.js';
import { listTranscriptionSessionsByRoom, countTranscriptionSessionsByRoom } from '../db/models/transcription.js';

/**
 * Register REST API routes
 */
export async function registerApiRoutes(fastify) {
  // GET /api/config - Get public configuration (for single-tenant mode detection)
  fastify.get('/api/config', async (request, reply) => {
    return {
      singleTenant: process.env.SINGLE_TENANT === 'true',
      defaultApiKey: process.env.SINGLE_TENANT === 'true' ? (process.env.ADMIN_KEY || 'admin') : null
    };
  });

  // POST /api/rooms - Create a new room
  fastify.post('/api/rooms', {
    preHandler: authenticateTenant,
    handler: async (request, reply) => {
      const { name, slug } = request.body;

      // Validate required fields
      if (!name) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Missing required field: name'
        });
      }

      try {
        const room = createRoom({
          tenant_id: request.tenant.id,
          name,
          slug
        });

        return reply.code(201).send({
          id: room.id,
          name: room.name,
          slug: room.slug
        });
      } catch (error) {
        // Check for unique constraint violation
        if (error.message.includes('UNIQUE constraint failed')) {
          return reply.code(409).send({
            error: 'Conflict',
            message: 'A room with this name already exists for this tenant'
          });
        }

        console.error('Error creating room:', error);
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to create room'
        });
      }
    }
  });

  // PUT /api/rooms/:room_slug - Update a room
  fastify.put('/api/rooms/:room_slug', {
    preHandler: authenticateTenant,
    handler: async (request, reply) => {
      const { room_slug } = request.params;
      const { name, slug } = request.body;

      // Validate at least one field is provided
      if (!name && !slug) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'At least one field must be provided for update'
        });
      }

      try {
        // Check if room exists and belongs to tenant
        const existingRoom = getRoomBySlug(room_slug);

        if (!existingRoom) {
          return reply.code(404).send({
            error: 'Not Found',
            message: 'Room not found'
          });
        }

        if (existingRoom.tenant_id !== request.tenant.id) {
          return reply.code(403).send({
            error: 'Forbidden',
            message: 'You do not have permission to update this room'
          });
        }

        // Update room
        const updates = {};
        if (name !== undefined) updates.name = name;
        if (slug !== undefined) updates.slug = slug;

        const updatedRoom = updateRoom(room_slug, updates);

        return reply.code(200).send({
          id: updatedRoom.id,
          name: updatedRoom.name,
          slug: updatedRoom.slug
        });
      } catch (error) {
        console.error('Error updating room:', error);
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to update room'
        });
      }
    }
  });

  // GET /api/rooms - List all rooms for tenant
  fastify.get('/api/rooms', {
    preHandler: authenticateTenant,
    handler: async (request, reply) => {
      try {
        const rooms = listRoomsByTenant(request.tenant.id);

        return reply.code(200).send({
          rooms: rooms.map(room => ({
            id: room.id,
            name: room.name,
            slug: room.slug,
            created_at: room.created_at
          }))
        });
      } catch (error) {
        console.error('Error listing rooms:', error);
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to list rooms'
        });
      }
    }
  });

  // GET /api/rooms/:room_slug - Get room details
  fastify.get('/api/rooms/:room_slug', {
    preHandler: authenticateTenant,
    handler: async (request, reply) => {
      const { room_slug } = request.params;

      try {
        const room = getRoomBySlug(room_slug);

        if (!room) {
          return reply.code(404).send({
            error: 'Not Found',
            message: 'Room not found'
          });
        }

        if (room.tenant_id !== request.tenant.id) {
          return reply.code(403).send({
            error: 'Forbidden',
            message: 'You do not have permission to view this room'
          });
        }

        return reply.code(200).send({
          id: room.id,
          name: room.name,
          slug: room.slug,
          created_at: room.created_at
        });
      } catch (error) {
        console.error('Error getting room:', error);
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to get room'
        });
      }
    }
  });

  // POST /api/rooms/:room_slug/publishers - Add publisher to room
  fastify.post('/api/rooms/:room_slug/publishers', {
    preHandler: authenticateTenant,
    handler: async (request, reply) => {
      const { room_slug } = request.params;
      const { name, channel_name } = request.body;

      // Validate required fields
      if (!name || !channel_name) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Missing required fields: name, channel_name'
        });
      }

      try {
        // Check if room exists and belongs to tenant
        const room = getRoomBySlug(room_slug);

        if (!room) {
          return reply.code(404).send({
            error: 'Not Found',
            message: 'Room not found'
          });
        }

        if (room.tenant_id !== request.tenant.id) {
          return reply.code(403).send({
            error: 'Forbidden',
            message: 'You do not have permission to add publishers to this room'
          });
        }

        // Create publisher
        const publisher = createPublisher({
          room_id: room.id,
          name,
          channel_name
        });

        return reply.code(201).send({
          id: publisher.id,
          room_slug: room.slug,
          name: publisher.name,
          channel_name: publisher.channel_name,
          join_token: publisher.join_token
        });
      } catch (error) {
        console.error('Error creating publisher:', error);
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to create publisher'
        });
      }
    }
  });

  // GET /api/rooms/:room_slug/publishers - List publishers for room
  fastify.get('/api/rooms/:room_slug/publishers', {
    preHandler: authenticateTenant,
    handler: async (request, reply) => {
      const { room_slug } = request.params;

      try {
        const room = getRoomBySlug(room_slug);

        if (!room) {
          return reply.code(404).send({
            error: 'Not Found',
            message: 'Room not found'
          });
        }

        if (room.tenant_id !== request.tenant.id) {
          return reply.code(403).send({
            error: 'Forbidden',
            message: 'You do not have permission to view this room'
          });
        }

        const publishers = listPublishersByRoom(room.id);

        return reply.code(200).send({
          publishers: publishers.map(publisher => ({
            id: publisher.id,
            name: publisher.name,
            channel_name: publisher.channel_name,
            join_token: publisher.join_token,
            created_at: publisher.created_at
          }))
        });
      } catch (error) {
        console.error('Error listing publishers:', error);
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to list publishers'
        });
      }
    }
  });

  // PUT /api/rooms/:room_slug/publishers/:id - Update a publisher
  fastify.put('/api/rooms/:room_slug/publishers/:id', {
    preHandler: authenticateTenant,
    handler: async (request, reply) => {
      const { room_slug, id } = request.params;
      const { name, channel_name } = request.body;

      try {
        // Check if room exists and belongs to tenant
        const room = getRoomBySlug(room_slug);

        if (!room) {
          return reply.code(404).send({
            error: 'Not Found',
            message: 'Room not found'
          });
        }

        if (room.tenant_id !== request.tenant.id) {
          return reply.code(403).send({
            error: 'Forbidden',
            message: 'You do not have permission to manage publishers in this room'
          });
        }

        // Check if publisher exists and belongs to this room
        const publisher = getPublisherById(parseInt(id));

        if (!publisher) {
          return reply.code(404).send({
            error: 'Not Found',
            message: 'Publisher not found'
          });
        }

        if (publisher.room_id !== room.id) {
          return reply.code(403).send({
            error: 'Forbidden',
            message: 'Publisher does not belong to this room'
          });
        }

        // Update publisher
        const updatedPublisher = updatePublisher(parseInt(id), {
          name,
          channel_name
        });

        return reply.code(200).send({
          id: updatedPublisher.id,
          room_slug: room.slug,
          name: updatedPublisher.name,
          channel_name: updatedPublisher.channel_name,
          message: 'Publisher updated successfully'
        });
      } catch (error) {
        console.error('Error updating publisher:', error);
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to update publisher'
        });
      }
    }
  });

  // DELETE /api/rooms/:room_slug/publishers/:id - Delete a publisher
  fastify.delete('/api/rooms/:room_slug/publishers/:id', {
    preHandler: authenticateTenant,
    handler: async (request, reply) => {
      const { room_slug, id } = request.params;

      try {
        // Check if room exists and belongs to tenant
        const room = getRoomBySlug(room_slug);

        if (!room) {
          return reply.code(404).send({
            error: 'Not Found',
            message: 'Room not found'
          });
        }

        if (room.tenant_id !== request.tenant.id) {
          return reply.code(403).send({
            error: 'Forbidden',
            message: 'You do not have permission to manage publishers in this room'
          });
        }

        // Check if publisher exists and belongs to this room
        const publisher = getPublisherById(parseInt(id));

        if (!publisher) {
          return reply.code(404).send({
            error: 'Not Found',
            message: 'Publisher not found'
          });
        }

        if (publisher.room_id !== room.id) {
          return reply.code(403).send({
            error: 'Forbidden',
            message: 'Publisher does not belong to this room'
          });
        }

        deletePublisher(parseInt(id));

        return reply.code(200).send({
          message: 'Publisher deleted successfully'
        });
      } catch (error) {
        console.error('Error deleting publisher:', error);
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to delete publisher'
        });
      }
    }
  });

  // DELETE /api/rooms/:room_slug - Delete a room
  fastify.delete('/api/rooms/:room_slug', {
    preHandler: authenticateTenant,
    handler: async (request, reply) => {
      const { room_slug } = request.params;

      try {
        // Check if room exists and belongs to tenant
        const room = getRoomBySlug(room_slug);

        if (!room) {
          return reply.code(404).send({
            error: 'Not Found',
            message: 'Room not found'
          });
        }

        if (room.tenant_id !== request.tenant.id) {
          return reply.code(403).send({
            error: 'Forbidden',
            message: 'You do not have permission to delete this room'
          });
        }

        const deleted = deleteRoom(room_slug);

        if (!deleted) {
          return reply.code(500).send({
            error: 'Internal Server Error',
            message: 'Failed to delete room'
          });
        }

        return reply.code(200).send({
          message: 'Room deleted successfully'
        });
      } catch (error) {
        console.error('Error deleting room:', error);
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to delete room'
        });
      }
    }
  });

  // ============ Recording Endpoints ============

  // POST /api/rooms/:room_slug/recordings/start - Start recording
  fastify.post('/api/rooms/:room_slug/recordings/start', {
    preHandler: authenticateTenant,
    handler: async (request, reply) => {
      const { room_slug } = request.params;
      const body = request.body || {};
      const eventName = (body.event_name || '').trim();
      const enableTranscription = body.enable_transcription !== false;

      try {
        // Check if room exists and belongs to tenant
        const room = getRoomBySlug(room_slug);

        if (!room) {
          return reply.code(404).send({
            error: 'Not Found',
            message: 'Room not found'
          });
        }

        if (room.tenant_id !== request.tenant.id) {
          return reply.code(403).send({
            error: 'Forbidden',
            message: 'You do not have permission to record this room'
          });
        }

        // Check if already recording
        if (isRecording(room.id)) {
          return reply.code(409).send({
            error: 'Conflict',
            message: 'Recording already in progress for this room'
          });
        }

        if (!eventName) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Missing required field: event_name'
          });
        }

        const transcriptionRuntime = request.server.transcriptionRuntime || null;
        if (enableTranscription) {
          if (!transcriptionRuntime) {
            return reply.code(503).send({
              error: 'Service Unavailable',
              message: 'Transcription runtime is not configured'
            });
          }
          try {
            await transcriptionRuntime.ensureAvailableOrThrow();
          } catch (error) {
            return reply.code(503).send({
              error: 'Service Unavailable',
              message: error.message
            });
          }
        }

        const result = await startRecording(room_slug, room.id, request.tenant.id);
        let transcriptionStatus = null;

        if (enableTranscription && transcriptionRuntime) {
          try {
            transcriptionStatus = await transcriptionRuntime.startRoomSession({
              roomId: room.id,
              roomSlug: room.slug,
              recordingId: result.recordingId,
              folderName: result.folderName,
              eventName,
              initialTracks: result.tracks || []
            });
          } catch (error) {
            await stopRecording(room_slug, room.id);
            await transcriptionRuntime.stopRoomSession(room.id, 'error', error.message);
            const overflow = error.code === 'SIDECAR_CAPACITY_EXCEEDED';
            return reply.code(503).send({
              error: 'Service Unavailable',
              message: overflow
                ? 'sidecar_capacity_exceeded'
                : `Failed to start transcription: ${error.message}`,
              code: overflow ? 'sidecar_capacity_exceeded' : 'transcription_start_failed'
            });
          }
        }

        if (request.server.notifyRecordingStatusChange) {
          request.server.notifyRecordingStatusChange(request.tenant.id, room.slug, {
            isRecording: true,
            recordingId: result.recordingId,
            folderName: result.folderName,
            startedAt: result.startedAt,
            trackCount: result.trackCount
          });
        }

        return reply.code(200).send({
          message: 'Recording started',
          ...result,
          eventName,
          transcriptionActive: Boolean(transcriptionStatus),
          transcriptionSessionId: transcriptionStatus?.transcriptionSessionId || null,
          sidecarMode: transcriptionStatus?.sidecarMode || null,
          sidecarInstanceCount: transcriptionStatus?.sidecarInstanceCount || 0,
          sidecarCapacity: transcriptionStatus?.sidecarCapacity || null,
          sidecarOverflow: Boolean(transcriptionStatus?.sidecarOverflow)
        });
      } catch (error) {
        console.error('Error starting recording:', error);
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: error.message || 'Failed to start recording'
        });
      }
    }
  });

  // POST /api/rooms/:room_slug/recordings/stop - Stop recording
  fastify.post('/api/rooms/:room_slug/recordings/stop', {
    preHandler: authenticateTenant,
    handler: async (request, reply) => {
      const { room_slug } = request.params;

      try {
        // Check if room exists and belongs to tenant
        const room = getRoomBySlug(room_slug);

        if (!room) {
          return reply.code(404).send({
            error: 'Not Found',
            message: 'Room not found'
          });
        }

        if (room.tenant_id !== request.tenant.id) {
          return reply.code(403).send({
            error: 'Forbidden',
            message: 'You do not have permission to manage recordings for this room'
          });
        }

        // Check if recording is active
        if (!isRecording(room.id)) {
          return reply.code(404).send({
            error: 'Not Found',
            message: 'No active recording for this room'
          });
        }

        const result = await stopRecording(room_slug, room.id);
        const transcriptionRuntime = request.server.transcriptionRuntime || null;
        let transcriptionStatus = null;
        if (transcriptionRuntime) {
          transcriptionStatus = await transcriptionRuntime.stopRoomSession(room.id);
        }

        if (request.server.notifyRecordingStatusChange) {
          request.server.notifyRecordingStatusChange(request.tenant.id, room.slug, {
            isRecording: false,
            recordingId: result.recordingId,
            folderName: result.folderName,
            startedAt: result.startedAt,
            stoppedAt: result.stoppedAt,
            trackCount: result.trackCount
          });
        }

        return reply.code(200).send({
          message: 'Recording stopped',
          ...result,
          transcription: transcriptionStatus
        });
      } catch (error) {
        console.error('Error stopping recording:', error);
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: error.message || 'Failed to stop recording'
        });
      }
    }
  });

  // GET /api/rooms/:room_slug/recordings/status - Get current recording status
  fastify.get('/api/rooms/:room_slug/recordings/status', {
    preHandler: authenticateTenant,
    handler: async (request, reply) => {
      const { room_slug } = request.params;

      try {
        // Check if room exists and belongs to tenant
        const room = getRoomBySlug(room_slug);

        if (!room) {
          return reply.code(404).send({
            error: 'Not Found',
            message: 'Room not found'
          });
        }

        if (room.tenant_id !== request.tenant.id) {
          return reply.code(403).send({
            error: 'Forbidden',
            message: 'You do not have permission to view this room'
          });
        }

        const status = getRecordingStatus(room.id);
        const transcriptionRuntime = request.server.transcriptionRuntime || null;
        const transcriptionStatus = transcriptionRuntime ? transcriptionRuntime.getRoomTranscriptionStatus(room.id) : null;

        if (!status) {
          return reply.code(200).send({
            isRecording: false,
            transcriptionActive: false,
            eventName: null,
            transcriptionSessionId: null
          });
        }

        return reply.code(200).send({
          ...status,
          transcriptionActive: Boolean(transcriptionStatus),
          eventName: transcriptionStatus?.eventName || null,
          transcriptionSessionId: transcriptionStatus?.transcriptionSessionId || null,
          modelName: transcriptionStatus?.modelName || null,
          sidecarMode: transcriptionStatus?.sidecarMode || null,
          sidecarInstanceCount: transcriptionStatus?.sidecarInstanceCount || 0,
          sidecarCapacity: transcriptionStatus?.sidecarCapacity || null,
          sidecarOverflow: Boolean(transcriptionStatus?.sidecarOverflow)
        });
      } catch (error) {
        console.error('Error getting recording status:', error);
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to get recording status'
        });
      }
    }
  });

  // GET /api/rooms/:room_slug/recordings - List all recordings for room
  fastify.get('/api/rooms/:room_slug/recordings', {
    preHandler: authenticateTenant,
    handler: async (request, reply) => {
      const { room_slug } = request.params;

      try {
        // Check if room exists and belongs to tenant
        const room = getRoomBySlug(room_slug);

        if (!room) {
          return reply.code(404).send({
            error: 'Not Found',
            message: 'Room not found'
          });
        }

        if (room.tenant_id !== request.tenant.id) {
          return reply.code(403).send({
            error: 'Forbidden',
            message: 'You do not have permission to view this room'
          });
        }

        const recordings = listRecordingsByRoomId(room.id);

        return reply.code(200).send({
          recordings: recordings.map(r => ({
            id: r.id,
            folderName: r.folder_name,
            status: r.status,
            startedAt: r.started_at,
            stoppedAt: r.stopped_at
          }))
        });
      } catch (error) {
        console.error('Error listing recordings:', error);
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to list recordings'
        });
      }
    }
  });

  // GET /api/rooms/:room_slug/transcriptions/current - Get active room transcription docs
  fastify.get('/api/rooms/:room_slug/transcriptions/current', {
    preHandler: authenticateTenant,
    handler: async (request, reply) => {
      const { room_slug } = request.params;
      try {
        const room = getRoomBySlug(room_slug);
        if (!room) {
          return reply.code(404).send({ error: 'Not Found', message: 'Room not found' });
        }
        if (room.tenant_id !== request.tenant.id) {
          return reply.code(403).send({ error: 'Forbidden', message: 'You do not have permission to view this room' });
        }

        const transcriptionRuntime = request.server.transcriptionRuntime || null;
        if (!transcriptionRuntime) {
          return reply.code(503).send({ error: 'Service Unavailable', message: 'Transcription runtime is not configured' });
        }

        const payload = transcriptionRuntime.getCurrentRoomDocs(room.id);
        if (!payload) {
          return reply.code(404).send({ error: 'Not Found', message: 'No active transcription session for this room' });
        }

        return reply.code(200).send(payload);
      } catch (error) {
        console.error('Error getting current room transcriptions:', error);
        return reply.code(500).send({ error: 'Internal Server Error', message: 'Failed to get room transcriptions' });
      }
    }
  });

  // GET /api/rooms/:room_slug/transcriptions/sessions - List room transcription sessions (paginated)
  fastify.get('/api/rooms/:room_slug/transcriptions/sessions', {
    preHandler: authenticateTenant,
    handler: async (request, reply) => {
      const { room_slug } = request.params;
      try {
        const room = getRoomBySlug(room_slug);
        if (!room) {
          return reply.code(404).send({ error: 'Not Found', message: 'Room not found' });
        }
        if (room.tenant_id !== request.tenant.id) {
          return reply.code(403).send({ error: 'Forbidden', message: 'You do not have permission to view this room' });
        }

        const rawLimit = parseInt(request.query?.limit ?? '20', 10);
        const rawOffset = parseInt(request.query?.offset ?? '0', 10);
        const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 100)) : 20;
        const offset = Number.isFinite(rawOffset) ? Math.max(0, rawOffset) : 0;

        const sessions = listTranscriptionSessionsByRoom(room.id, limit, offset);
        const total = countTranscriptionSessionsByRoom(room.id);

        return reply.code(200).send({
          sessions: sessions.map((session) => ({
            id: session.id,
            roomId: session.room_id,
            recordingId: session.recording_id,
            eventName: session.event_name,
            modelName: session.model_name,
            status: session.status,
            startedAt: session.started_at,
            stoppedAt: session.stopped_at,
            errorMessage: session.error_message
          })),
          pagination: {
            limit,
            offset,
            total,
            hasMore: offset + sessions.length < total
          }
        });
      } catch (error) {
        console.error('Error listing transcription sessions:', error);
        return reply.code(500).send({ error: 'Internal Server Error', message: 'Failed to list transcription sessions' });
      }
    }
  });

  // GET /api/rooms/:room_slug/transcriptions/sessions/:session_id - Get room transcription docs by session
  fastify.get('/api/rooms/:room_slug/transcriptions/sessions/:session_id', {
    preHandler: authenticateTenant,
    handler: async (request, reply) => {
      const { room_slug, session_id } = request.params;
      try {
        const room = getRoomBySlug(room_slug);
        if (!room) {
          return reply.code(404).send({ error: 'Not Found', message: 'Room not found' });
        }
        if (room.tenant_id !== request.tenant.id) {
          return reply.code(403).send({ error: 'Forbidden', message: 'You do not have permission to view this room' });
        }

        const sessionId = parseInt(session_id, 10);
        if (!Number.isFinite(sessionId) || sessionId <= 0) {
          return reply.code(400).send({ error: 'Bad Request', message: 'Invalid session_id' });
        }

        const transcriptionRuntime = request.server.transcriptionRuntime || null;
        if (!transcriptionRuntime) {
          return reply.code(503).send({ error: 'Service Unavailable', message: 'Transcription runtime is not configured' });
        }

        const payload = transcriptionRuntime.getSessionDocs(room.id, room.slug, sessionId);
        if (!payload) {
          return reply.code(404).send({ error: 'Not Found', message: 'Transcription session not found for this room' });
        }

        return reply.code(200).send(payload);
      } catch (error) {
        console.error('Error getting room transcription session docs:', error);
        return reply.code(500).send({ error: 'Internal Server Error', message: 'Failed to get transcription session docs' });
      }
    }
  });

  // GET /api/rooms/:room_slug/transcriptions/sessions/:session_id/channels/:channel_name - Get room transcript by session and channel
  fastify.get('/api/rooms/:room_slug/transcriptions/sessions/:session_id/channels/:channel_name', {
    preHandler: authenticateTenant,
    handler: async (request, reply) => {
      const { room_slug, session_id, channel_name } = request.params;
      try {
        const room = getRoomBySlug(room_slug);
        if (!room) {
          return reply.code(404).send({ error: 'Not Found', message: 'Room not found' });
        }
        if (room.tenant_id !== request.tenant.id) {
          return reply.code(403).send({ error: 'Forbidden', message: 'You do not have permission to view this room' });
        }

        const sessionId = parseInt(session_id, 10);
        if (!Number.isFinite(sessionId) || sessionId <= 0) {
          return reply.code(400).send({ error: 'Bad Request', message: 'Invalid session_id' });
        }

        const transcriptionRuntime = request.server.transcriptionRuntime || null;
        if (!transcriptionRuntime) {
          return reply.code(503).send({ error: 'Service Unavailable', message: 'Transcription runtime is not configured' });
        }

        const payload = transcriptionRuntime.getSessionChannelDoc(room.id, room.slug, sessionId, channel_name);
        if (!payload) {
          return reply.code(404).send({ error: 'Not Found', message: 'Transcription session not found for this room' });
        }
        return reply.code(200).send(payload);
      } catch (error) {
        console.error('Error getting room transcription session channel doc:', error);
        return reply.code(500).send({ error: 'Internal Server Error', message: 'Failed to get transcription session channel doc' });
      }
    }
  });

  // POST /api/rooms/:room_slug/transcriptions/sessions/:session_id/stop - Force stop a transcription session
  fastify.post('/api/rooms/:room_slug/transcriptions/sessions/:session_id/stop', {
    preHandler: authenticateTenant,
    handler: async (request, reply) => {
      const { room_slug, session_id } = request.params;
      const reason = (request.body?.reason || 'Stopped by admin').toString().trim().slice(0, 500) || 'Stopped by admin';

      try {
        const room = getRoomBySlug(room_slug);
        if (!room) {
          return reply.code(404).send({ error: 'Not Found', message: 'Room not found' });
        }
        if (room.tenant_id !== request.tenant.id) {
          return reply.code(403).send({ error: 'Forbidden', message: 'You do not have permission to update this room' });
        }

        const sessionId = parseInt(session_id, 10);
        if (!Number.isFinite(sessionId) || sessionId <= 0) {
          return reply.code(400).send({ error: 'Bad Request', message: 'Invalid session_id' });
        }

        const transcriptionRuntime = request.server.transcriptionRuntime || null;
        if (!transcriptionRuntime) {
          return reply.code(503).send({ error: 'Service Unavailable', message: 'Transcription runtime is not configured' });
        }

        const payload = await transcriptionRuntime.forceStopSession(room.id, sessionId, reason);
        if (!payload) {
          return reply.code(404).send({ error: 'Not Found', message: 'Transcription session not found for this room' });
        }

        if (request.server.notifyRecordingStatusChange) {
          const status = getRecordingStatus(room.id);
          request.server.notifyRecordingStatusChange(request.tenant.id, room.slug, status || { isRecording: false });
        }

        return reply.code(200).send({
          message: payload.status === 'stopped' ? 'Transcription session stopped' : `Session is already ${payload.status}`,
          ...payload
        });
      } catch (error) {
        console.error('Error forcing transcription session stop:', error);
        return reply.code(500).send({ error: 'Internal Server Error', message: 'Failed to stop transcription session' });
      }
    }
  });

  // GET /api/rooms/:room_slug/transcriptions/channels/:channel_name - Get active transcript by channel
  fastify.get('/api/rooms/:room_slug/transcriptions/channels/:channel_name', {
    preHandler: authenticateTenant,
    handler: async (request, reply) => {
      const { room_slug, channel_name } = request.params;
      try {
        const room = getRoomBySlug(room_slug);
        if (!room) {
          return reply.code(404).send({ error: 'Not Found', message: 'Room not found' });
        }
        if (room.tenant_id !== request.tenant.id) {
          return reply.code(403).send({ error: 'Forbidden', message: 'You do not have permission to view this room' });
        }

        const transcriptionRuntime = request.server.transcriptionRuntime || null;
        if (!transcriptionRuntime) {
          return reply.code(503).send({ error: 'Service Unavailable', message: 'Transcription runtime is not configured' });
        }

        const payload = transcriptionRuntime.getChannelDoc(room.id, channel_name);
        if (!payload) {
          return reply.code(404).send({ error: 'Not Found', message: 'No active transcription session for this room' });
        }
        return reply.code(200).send(payload);
      } catch (error) {
        console.error('Error getting room channel transcript:', error);
        return reply.code(500).send({ error: 'Internal Server Error', message: 'Failed to get room channel transcript' });
      }
    }
  });

}

export default registerApiRoutes;
