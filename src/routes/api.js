import { authenticateTenant } from '../middleware/auth.js';
import { createRoom, getRoomBySlug, updateRoom, listRoomsByTenant } from '../db/models/room.js';
import { createInterpreter, listInterpretersByRoom } from '../db/models/interpreter.js';

/**
 * Register REST API routes
 */
export async function registerApiRoutes(fastify) {
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
      const { name, is_local_only, sfu_url, coturn_config_json } = request.body;

      // Validate at least one field is provided
      if (!name && is_local_only === undefined && !sfu_url && !coturn_config_json) {
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

  // POST /api/rooms/:room_slug/interpreters - Add interpreter to room
  fastify.post('/api/rooms/:room_slug/interpreters', {
    preHandler: authenticateTenant,
    handler: async (request, reply) => {
      const { room_slug } = request.params;
      const { name, target_language } = request.body;

      // Validate required fields
      if (!name || !target_language) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Missing required fields: name, target_language'
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
            message: 'You do not have permission to add interpreters to this room'
          });
        }

        // Create interpreter
        const interpreter = createInterpreter({
          room_id: room.id,
          name,
          target_language
        });

        return reply.code(201).send({
          id: interpreter.id,
          room_slug: room.slug,
          name: interpreter.name,
          target_language: interpreter.target_language,
          join_token: interpreter.join_token // Only returned here, never again
        });
      } catch (error) {
        console.error('Error creating interpreter:', error);
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to create interpreter'
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

  // GET /api/rooms/:room_slug/interpreters - List interpreters for room
  fastify.get('/api/rooms/:room_slug/interpreters', {
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

        const interpreters = listInterpretersByRoom(room.id);

        return reply.code(200).send({
          interpreters: interpreters.map(interpreter => ({
            id: interpreter.id,
            name: interpreter.name,
            target_language: interpreter.target_language,
            created_at: interpreter.created_at
          }))
        });
      } catch (error) {
        console.error('Error listing interpreters:', error);
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to list interpreters'
        });
      }
    }
  });
}

export default registerApiRoutes;
