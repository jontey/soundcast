import { authenticateTenant } from '../middleware/auth.js';
import { createRoom, getRoomBySlug, updateRoom, listRoomsByTenant, deleteRoom } from '../db/models/room.js';
import { createPublisher, listPublishersByRoom, deletePublisher, getPublisherById, updatePublisher } from '../db/models/publisher.js';
import { startRecording, stopRecording, getRecordingStatus, isRecording } from '../recording/recorder.js';
import { listRecordingsByRoomId } from '../db/models/recording.js';
import { registerTranscriptionRoutes } from './transcription-api.js';
import { modelDownloader, AVAILABLE_MODELS } from '../transcription/model-downloader.js';

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
      const { name, is_local_only, sfu_url, coturn_config_json } = request.body;

      // Validate required fields
      if (!name || is_local_only === undefined || !sfu_url || !coturn_config_json) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Missing required fields: name, is_local_only, sfu_url, coturn_config_json'
        });
      }

      // Validate coturn_config_json is valid JSON
      try {
        JSON.parse(coturn_config_json);
      } catch (e) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'coturn_config_json must be valid JSON'
        });
      }

      try {
        const room = createRoom({
          tenant_id: request.tenant.id,
          name,
          is_local_only,
          sfu_url,
          coturn_config_json
        });

        return reply.code(201).send({
          id: room.id,
          name: room.name,
          slug: room.slug,
          is_local_only: room.is_local_only
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
      const { name, slug, is_local_only, sfu_url, coturn_config_json } = request.body;

      // Validate at least one field is provided
      if (!name && !slug && is_local_only === undefined && !sfu_url && !coturn_config_json) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'At least one field must be provided for update'
        });
      }

      // Validate coturn_config_json if provided
      if (coturn_config_json) {
        try {
          JSON.parse(coturn_config_json);
        } catch (e) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'coturn_config_json must be valid JSON'
          });
        }
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
        if (is_local_only !== undefined) updates.is_local_only = is_local_only;
        if (sfu_url !== undefined) updates.sfu_url = sfu_url;
        if (coturn_config_json !== undefined) updates.coturn_config_json = coturn_config_json;

        const updatedRoom = updateRoom(room_slug, updates);

        return reply.code(200).send({
          id: updatedRoom.id,
          name: updatedRoom.name,
          slug: updatedRoom.slug,
          is_local_only: updatedRoom.is_local_only,
          sfu_url: updatedRoom.sfu_url,
          coturn_config_json: updatedRoom.coturn_config_json
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
            is_local_only: room.is_local_only,
            sfu_url: room.sfu_url,
            coturn_config_json: room.coturn_config_json,
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
          is_local_only: room.is_local_only,
          sfu_url: room.sfu_url,
          coturn_config_json: room.coturn_config_json,
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
      const { name, channel_name, transcription_language = 'en' } = request.body;

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
          channel_name,
          transcription_language
        });

        return reply.code(201).send({
          id: publisher.id,
          room_slug: room.slug,
          name: publisher.name,
          channel_name: publisher.channel_name,
          join_token: publisher.join_token,
          transcription_language: publisher.transcription_language
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
      const { name, channel_name, transcription_language } = request.body;

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
          channel_name,
          transcription_language
        });

        return reply.code(200).send({
          id: updatedPublisher.id,
          room_slug: room.slug,
          name: updatedPublisher.name,
          channel_name: updatedPublisher.channel_name,
          transcription_language: updatedPublisher.transcription_language,
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

        const result = await startRecording(room_slug, room.id, request.tenant.id);

        return reply.code(200).send({
          message: 'Recording started',
          ...result
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

        return reply.code(200).send({
          message: 'Recording stopped',
          ...result
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

        if (!status) {
          return reply.code(200).send({
            isRecording: false
          });
        }

        return reply.code(200).send(status);
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

  // ============================================================================
  // Model Management Routes
  // ============================================================================

  // GET /api/models - List available and installed models
  fastify.get('/api/models', {
    preHandler: authenticateTenant,
    handler: async (request, reply) => {
      try {
        const available = Object.values(AVAILABLE_MODELS).map(model => ({
          id: model.name,
          name: model.name.includes('.en') ? model.name.replace('.en', '').charAt(0).toUpperCase() + model.name.replace('.en', '').slice(1) : model.name.charAt(0).toUpperCase() + model.name.slice(1),
          type: model.languages.includes('en') && model.languages.length === 1 ? 'English' : 'Multilingual',
          size: modelDownloader.formatBytes(model.size * 1024 * 1024),
          sizeFormatted: modelDownloader.formatBytes(model.size * 1024 * 1024),
          description: model.description,
          languages: model.languages
        }));

        const installed = modelDownloader.listInstalledModels();

        return {
          available,
          installed,
          modelDir: process.env.WHISPER_MODEL_DIR || './models'
        };
      } catch (err) {
        console.error('[API] Failed to list models:', err.message);
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to list models'
        });
      }
    }
  });

  // POST /api/models/download - Start model download
  fastify.post('/api/models/download', {
    preHandler: authenticateTenant,
    handler: async (request, reply) => {
      const { modelName } = request.body;

      if (!modelName) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Missing required field: modelName'
        });
      }

      if (!AVAILABLE_MODELS[modelName]) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: `Unknown model: ${modelName}`
        });
      }

      try {
        const downloadId = await modelDownloader.startDownload(modelName);
        return {
          downloadId,
          modelName,
          message: 'Download started'
        };
      } catch (err) {
        console.error('[API] Failed to start download:', err.message);

        if (err.message === 'Model already downloaded') {
          return reply.code(409).send({
            error: 'Conflict',
            message: 'Model already downloaded'
          });
        }

        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to start download'
        });
      }
    }
  });

  // GET /api/models/download/:id - Get download progress
  fastify.get('/api/models/download/:id', {
    preHandler: authenticateTenant,
    handler: async (request, reply) => {
      const { id } = request.params;

      const progress = modelDownloader.getProgress(id);

      if (!progress) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'Download not found or already completed'
        });
      }

      return progress;
    }
  });

  // GET /api/models/downloads - List all active downloads
  fastify.get('/api/models/downloads', {
    preHandler: authenticateTenant,
    handler: async (request, reply) => {
      const downloads = modelDownloader.listActiveDownloads();
      return { downloads };
    }
  });

  // DELETE /api/models/:filename - Delete installed model
  fastify.delete('/api/models/:filename', {
    preHandler: authenticateTenant,
    handler: async (request, reply) => {
      const { filename } = request.params;

      // Safety check
      if (!filename.endsWith('.bin')) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Invalid filename'
        });
      }

      try {
        modelDownloader.deleteModel(filename);
        return { message: 'Model deleted successfully' };
      } catch (err) {
        console.error('[API] Failed to delete model:', err.message);

        if (err.message === 'Model not found') {
          return reply.code(404).send({
            error: 'Not Found',
            message: 'Model not found'
          });
        }

        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to delete model'
        });
      }
    }
  });

  // Register transcription routes
  registerTranscriptionRoutes(fastify, authenticateTenant);
}

export default registerApiRoutes;
