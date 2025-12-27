import { authenticateTenant } from '../middleware/auth.js';
import { createSfuKey, registerSfu, listSfuKeysByTenant, verifySfuSecretKey, updateSfuHeartbeat, updateSfuStatus, getSfuById, deleteSfu } from '../db/models/sfu.js';

/**
 * Register SFU API routes
 */
export async function registerSfuRoutes(fastify) {
  // POST /api/sfu/keys - Create a new SFU key for the tenant
  fastify.post('/api/sfu/keys', {
    preHandler: authenticateTenant,
    handler: async (request, reply) => {
      try {
        // Generate a random 32-character key
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let secretKey = '';
        for (let i = 0; i < 32; i++) {
          secretKey += chars.charAt(Math.floor(Math.random() * chars.length));
        }

        const sfuKey = createSfuKey(request.tenant.id, secretKey);

        fastify.log.info(`SFU key created for tenant ${request.tenant.id}`);

        return reply.code(201).send({
          id: sfuKey.id,
          secret_key: sfuKey.secret_key,
          status: sfuKey.status,
          created_at: sfuKey.created_at,
          message: 'SFU key created successfully'
        });
      } catch (error) {
        fastify.log.error(`Error creating SFU key: ${error.message}`);
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to create SFU key'
        });
      }
    }
  });

  // GET /api/sfu/list - List all SFU keys for the tenant
  fastify.get('/api/sfu/list', {
    preHandler: authenticateTenant,
    handler: async (request, reply) => {
      try {
        const sfus = listSfuKeysByTenant(request.tenant.id);

        return reply.code(200).send({
          sfus: sfus.map(sfu => ({
            id: sfu.id,
            secret_key: sfu.secret_key,
            name: sfu.name,
            url: sfu.url,
            status: sfu.status,
            last_heartbeat: sfu.last_heartbeat,
            created_at: sfu.created_at
          }))
        });
      } catch (error) {
        fastify.log.error(`Error listing SFUs: ${error.message}`);
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to list SFUs'
        });
      }
    }
  });

  // POST /api/sfu/register - Register an SFU instance using an existing key
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

      if (!sfu) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'Invalid secret key. Please generate a key in the tenant admin first.'
        });
      }

      const action = sfu.updated ? 'updated' : 'registered';
      fastify.log.info(`SFU ${action}: ${name} (${url})`);

      return reply.code(sfu.updated ? 200 : 201).send({
        id: sfu.id,
        name: sfu.name,
        url: sfu.url,
        status: sfu.status,
        message: `SFU ${action} successfully`
      });
    } catch (error) {
      fastify.log.error(`Error registering SFU: ${error.message}`);

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

  // POST /api/sfu/:id/disconnect - Mark SFU as offline
  fastify.post('/api/sfu/:id/disconnect', async (request, reply) => {
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
      const updated = updateSfuStatus(parseInt(id), 'offline');

      if (!updated) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'SFU not found'
        });
      }

      fastify.log.info(`SFU ${id} disconnected`);
      return reply.code(200).send({
        success: true,
        message: 'SFU marked as offline'
      });
    } catch (error) {
      fastify.log.error(`Error disconnecting SFU: ${error.message}`);
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Failed to disconnect SFU'
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

      return reply.code(200).send({
        id: sfu.id,
        name: sfu.name,
        url: sfu.url,
        status: sfu.status,
        last_heartbeat: sfu.last_heartbeat
      });
    } catch (error) {
      fastify.log.error(`Error getting SFU: ${error.message}`);
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Failed to get SFU'
      });
    }
  });

  // DELETE /api/sfu/keys/:id - Delete an SFU key
  fastify.delete('/api/sfu/keys/:id', {
    preHandler: authenticateTenant,
    handler: async (request, reply) => {
      const { id } = request.params;

      try {
        const sfu = getSfuById(parseInt(id));

        if (!sfu) {
          return reply.code(404).send({
            error: 'Not Found',
            message: 'SFU key not found'
          });
        }

        // Verify the SFU belongs to this tenant
        if (sfu.tenant_id !== request.tenant.id) {
          return reply.code(403).send({
            error: 'Forbidden',
            message: 'You do not have permission to delete this SFU key'
          });
        }

        const deleted = deleteSfu(parseInt(id));

        if (!deleted) {
          return reply.code(500).send({
            error: 'Internal Server Error',
            message: 'Failed to delete SFU key'
          });
        }

        fastify.log.info(`SFU key deleted: ${id}`);

        return reply.code(200).send({
          message: 'SFU key deleted successfully'
        });
      } catch (error) {
        fastify.log.error(`Error deleting SFU key: ${error.message}`);
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to delete SFU key'
        });
      }
    }
  });
}

export default registerSfuRoutes;
