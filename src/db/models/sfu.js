import { getDatabase } from '../database.js';
import bcrypt from 'bcrypt';

const SALT_ROUNDS = 10;

/**
 * Register a new SFU instance
 * @param {object} sfuData - SFU data
 * @returns {object} Created SFU instance
 */
export function registerSfu({ name, url, announced_ip, port, secret_key }) {
  const db = getDatabase();
  const secretKeyHash = bcrypt.hashSync(secret_key, SALT_ROUNDS);

  const stmt = db.prepare(
    'INSERT INTO sfus (name, url, announced_ip, port, secret_key_hash, status, last_heartbeat) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );

  const result = stmt.run(
    name,
    url,
    announced_ip,
    port,
    secretKeyHash,
    'online',
    new Date().toISOString()
  );

  return {
    id: result.lastInsertRowid,
    name,
    url,
    announced_ip,
    port,
    status: 'online',
    created_at: new Date().toISOString()
  };
}

/**
 * Verify SFU secret key
 * @param {string} secretKey - Plain text secret key
 * @returns {object|null} SFU instance if valid
 */
export function verifySfuSecretKey(secretKey) {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM sfus');
  const sfus = stmt.all();

  for (const sfu of sfus) {
    if (bcrypt.compareSync(secretKey, sfu.secret_key_hash)) {
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
    'SELECT id, name, url, announced_ip, port, status, last_heartbeat, created_at FROM sfus WHERE id = ?'
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
    'SELECT id, name, url, announced_ip, port, status, last_heartbeat, created_at FROM sfus ORDER BY created_at DESC'
  );
  return stmt.all();
}

/**
 * List online SFUs (heartbeat within last 2 minutes)
 * @returns {array} Array of online SFU instances
 */
export function listOnlineSfus() {
  const db = getDatabase();

  // Consider SFU offline if no heartbeat in last 2 minutes
  const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();

  const stmt = db.prepare(
    `SELECT id, name, url, announced_ip, port, status, last_heartbeat, created_at
     FROM sfus
     WHERE last_heartbeat >= ?
     ORDER BY name ASC`
  );

  return stmt.all(twoMinutesAgo);
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
 * @param {string} status - Status (online, offline, error)
 * @returns {boolean} Success
 */
export function updateSfuStatus(id, status) {
  const db = getDatabase();
  const stmt = db.prepare('UPDATE sfus SET status = ? WHERE id = ?');
  const result = stmt.run(status, id);
  return result.changes > 0;
}

export default {
  registerSfu,
  verifySfuSecretKey,
  updateSfuHeartbeat,
  getSfuById,
  listSfus,
  listOnlineSfus,
  deleteSfu,
  updateSfuStatus
};
