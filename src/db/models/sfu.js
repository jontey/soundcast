import { getDatabase } from '../database.js';
import bcryptjs from 'bcryptjs';

const SALT_ROUNDS = 10;

/**
 * Create a new SFU key for a tenant
 * @param {number} tenant_id - Tenant ID
 * @param {string} secret_key - Plain text secret key
 * @returns {object} Created SFU key entry
 */
export function createSfuKey(tenant_id, secret_key) {
  const db = getDatabase();
  const secretKeyHash = bcryptjs.hashSync(secret_key, SALT_ROUNDS);
  const now = new Date().toISOString();

  const stmt = db.prepare(
    'INSERT INTO sfus (tenant_id, secret_key, secret_key_hash, status, created_at) VALUES (?, ?, ?, ?, ?)'
  );

  const result = stmt.run(tenant_id, secret_key, secretKeyHash, 'pending', now);

  return {
    id: result.lastInsertRowid,
    tenant_id,
    secret_key,
    status: 'pending',
    created_at: now
  };
}

/**
 * Register an SFU instance using an existing key
 * Finds the SFU entry by secret_key and updates it with SFU details
 * @param {object} sfuData - SFU data
 * @returns {object|null} Updated SFU instance or null if key not found
 */
export function registerSfu({ name, url, announced_ip, port, secret_key }) {
  const db = getDatabase();
  const now = new Date().toISOString();

  // Find SFU entry by verifying secret_key
  const sfus = db.prepare('SELECT * FROM sfus').all();
  let matchingSfu = null;

  for (const sfu of sfus) {
    if (bcryptjs.compareSync(secret_key, sfu.secret_key_hash)) {
      matchingSfu = sfu;
      break;
    }
  }

  if (!matchingSfu) {
    return null; // Key not found
  }

  // Update the SFU entry with registration details
  const stmt = db.prepare(
    'UPDATE sfus SET name = ?, url = ?, announced_ip = ?, port = ?, status = ?, last_heartbeat = ? WHERE id = ?'
  );
  stmt.run(name, url, announced_ip, port, 'online', now, matchingSfu.id);

  return {
    id: matchingSfu.id,
    tenant_id: matchingSfu.tenant_id,
    name,
    url,
    announced_ip,
    port,
    status: 'online',
    updated: matchingSfu.name !== null // true if re-registering
  };
}

/**
 * List all SFU keys for a tenant
 * @param {number} tenant_id - Tenant ID
 * @returns {array} Array of SFU entries
 */
export function listSfuKeysByTenant(tenant_id) {
  const db = getDatabase();
  const stmt = db.prepare(
    `SELECT id, tenant_id, secret_key, name, url, announced_ip, port, status, last_heartbeat, created_at
     FROM sfus
     WHERE tenant_id = ?
     ORDER BY created_at DESC`
  );
  return stmt.all(tenant_id);
}

/**
 * Verify SFU secret key
 * @param {string} secretKey - Plain text secret key
 * @returns {object|null} SFU instance if valid (includes tenant_id)
 */
export function verifySfuSecretKey(secretKey) {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM sfus');
  const sfus = stmt.all();

  for (const sfu of sfus) {
    if (bcryptjs.compareSync(secretKey, sfu.secret_key_hash)) {
      const { secret_key_hash, ...sfuWithoutHash } = sfu;
      return sfuWithoutHash;
    }
  }

  return null;
}

/**
 * Update SFU heartbeat
 * @param {number} id - SFU ID
 * @returns {boolean} Success
 */
export function updateSfuHeartbeat(id) {
  const db = getDatabase();
  const stmt = db.prepare(
    'UPDATE sfus SET last_heartbeat = ?, status = ? WHERE id = ?'
  );

  const result = stmt.run(new Date().toISOString(), 'online', id);
  return result.changes > 0;
}

/**
 * Get SFU by ID
 * @param {number} id - SFU ID
 * @returns {object|null} SFU instance
 */
export function getSfuById(id) {
  const db = getDatabase();
  const stmt = db.prepare(
    'SELECT id, tenant_id, secret_key, name, url, announced_ip, port, status, last_heartbeat, created_at FROM sfus WHERE id = ?'
  );
  return stmt.get(id);
}

/**
 * List all SFUs
 * @returns {array} Array of SFU instances
 */
export function listSfus() {
  const db = getDatabase();
  const stmt = db.prepare(
    'SELECT id, tenant_id, name, url, announced_ip, port, status, last_heartbeat, created_at FROM sfus ORDER BY created_at DESC'
  );
  return stmt.all();
}

/**
 * List online SFUs for a tenant (heartbeat within last 2 minutes)
 * @param {number} tenant_id - Tenant ID (optional, if not provided returns all)
 * @returns {array} Array of online SFU instances
 */
export function listOnlineSfus(tenant_id = null) {
  const db = getDatabase();

  // Consider SFU offline if no heartbeat in last 2 minutes
  const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();

  if (tenant_id) {
    const stmt = db.prepare(
      `SELECT id, tenant_id, name, url, announced_ip, port, status, last_heartbeat, created_at
       FROM sfus
       WHERE tenant_id = ? AND last_heartbeat >= ?
       ORDER BY name ASC`
    );
    return stmt.all(tenant_id, twoMinutesAgo);
  } else {
    const stmt = db.prepare(
      `SELECT id, tenant_id, name, url, announced_ip, port, status, last_heartbeat, created_at
       FROM sfus
       WHERE last_heartbeat >= ?
       ORDER BY name ASC`
    );
    return stmt.all(twoMinutesAgo);
  }
}

/**
 * Delete SFU by ID
 * @param {number} id - SFU ID
 * @returns {boolean} Success
 */
export function deleteSfu(id) {
  const db = getDatabase();
  const stmt = db.prepare('DELETE FROM sfus WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

/**
 * Update SFU status
 * @param {number} id - SFU ID
 * @param {string} status - Status (pending, online, offline)
 * @returns {boolean} Success
 */
export function updateSfuStatus(id, status) {
  const db = getDatabase();
  const stmt = db.prepare('UPDATE sfus SET status = ? WHERE id = ?');
  const result = stmt.run(status, id);
  return result.changes > 0;
}

export default {
  createSfuKey,
  registerSfu,
  listSfuKeysByTenant,
  verifySfuSecretKey,
  updateSfuHeartbeat,
  getSfuById,
  listSfus,
  listOnlineSfus,
  deleteSfu,
  updateSfuStatus
};
