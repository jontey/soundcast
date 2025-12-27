import { verifyTenantApiKey } from '../db/models/tenant.js';

/**
 * Middleware to authenticate tenant API key from Bearer token
 * Adds tenant object to request if authenticated
 */
export async function authenticateTenant(request, reply) {
  const authHeader = request.headers.authorization;

  if (!authHeader) {
    return reply.code(401).send({
      error: 'Unauthorized',
      message: 'Missing Authorization header'
    });
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return reply.code(401).send({
      error: 'Unauthorized',
      message: 'Invalid Authorization header format. Expected: Bearer <token>'
    });
  }

  const apiKey = parts[1];

  // Verify API key
  const tenant = verifyTenantApiKey(apiKey);

  if (!tenant) {
    return reply.code(401).send({
      error: 'Unauthorized',
      message: 'Invalid API key'
    });
  }

  // Add tenant to request object
  request.tenant = tenant;
}

/**
 * Verify tenant owns the room (for routes with room_slug parameter)
 */
export async function verifyRoomOwnership(request, reply) {
  // This assumes authenticateTenant has already run
  if (!request.tenant) {
    return reply.code(401).send({
      error: 'Unauthorized',
      message: 'Authentication required'
    });
  }

  // The room verification will be done in the route handler
  // This is just a placeholder for future extension
}

export default {
  authenticateTenant,
  verifyRoomOwnership
};
