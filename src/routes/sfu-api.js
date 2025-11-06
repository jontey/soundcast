import { registerSfu, verifySfuSecretKey, updateSfuHeartbeat, getSfuById, listOnlineSfus } from '../db/models/sfu.js';

/**
 * Register SFU API routes
 */
export async function registerSfuRoutes(fastify) {
  // POST /api/sfu/register - Register a new SFU instance
  fastify.post('/api/sfu/register', async (request, reply) => {
    const { name, url, announced_ip, port, secret_key } = request.body;

    // Validate required fields
    if (!name || !url || !announced_ip || !port || !secret_key) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'Missing required fields: name, url, announced_ip, port, secret_key'
      });
    }

    try {
      const sfu = registerSfu({
        name,
        url,
        announced_ip,
        port,
        secret_key
      });

      fastify.log.info(`SFU registered: ${name} (${url})`);

      return reply.code(201).send({
        id: sfu.id,
        name: sfu.name,
        url: sfu.url,
        status: sfu.status,
        message: 'SFU registered successfully'
      });
    } catch (error) {
      fastify.log.error(`Error registering SFU: ${error.message}`);

      if (error.message.includes('UNIQUE constraint failed')) {
        return reply.code(409).send({
          error: 'Conflict',
          message: 'An SFU with this name already exists'
        });
      }

      return reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Failed to register SFU'
      });
    }
  });

  // POST /api/sfu/:id/heartbeat - Update SFU heartbeat
  fastify.post('/api/sfu/:id/heartbeat', async (request, reply) => {
    const { id } = request.params;
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Missing or invalid Authorization header'
      });
    }

    const secretKey = authHeader.substring(7);
    const sfu = verifySfuSecretKey(secretKey);

    if (!sfu || sfu.id !== parseInt(id)) {
      return reply.code(403).send({
        error: 'Forbidden',
        message: 'Invalid secret key or SFU ID mismatch'
      });
    }

    try {
      const updated = updateSfuHeartbeat(parseInt(id));

      if (!updated) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'SFU not found'
        });
      }

      return reply.code(200).send({
        success: true,
        message: 'Heartbeat updated'
      });
    } catch (error) {
      fastify.log.error(`Error updating heartbeat: ${error.message}`);
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Failed to update heartbeat'
      });
    }
  });

  // GET /api/sfu/list - List all online SFUs (public endpoint for admins)
  fastify.get('/api/sfu/list', async (request, reply) => {
    try {
      const sfus = listOnlineSfus();

      return reply.code(200).send({
        sfus: sfus.map(sfu => ({
          id: sfu.id,
          name: sfu.name,
          url: sfu.url,
          status: sfu.status,
          last_heartbeat: sfu.last_heartbeat
        }))
      });
    } catch (error) {
      fastify.log.error(`Error listing SFUs: ${error.message}`);
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Failed to list SFUs'
      });
    }
  });

  // GET /api/sfu/:id - Get SFU details
  fastify.get('/api/sfu/:id', async (request, reply) => {
    const { id } = request.params;

    try {
      const sfu = getSfuById(parseInt(id));

      if (!sfu) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'SFU not found'
        });
      }

      return reply.code(200).send(sfu);
    } catch (error) {
      fastify.log.error(`Error getting SFU: ${error.message}`);
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Failed to get SFU'
      });
    }
  });
}

export default registerSfuRoutes;
