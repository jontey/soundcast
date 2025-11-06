import { getDatabase } from '../database.js';
import bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';

const SALT_ROUNDS = 10;

/**
 * Generate a secure random token
 * @param {number} length - Token length in bytes (default 16 = 32 hex chars)
 * @returns {string} Random token
 */
function generateToken(length = 16) {
  return randomBytes(length).toString('hex');
}

/**
 * Create a new interpreter
 * @param {object} interpreterData - Interpreter data
 * @param {number} interpreterData.room_id - Room ID
 * @param {string} interpreterData.name - Interpreter name
 * @param {string} interpreterData.target_language - Target language code
 * @returns {object} Created interpreter with join_token
 */
export function createInterpreter({ room_id, name, target_language }) {
  const db = getDatabase();

  // Generate unique join token
  const joinToken = generateToken(16); // 32 character hex string
  const joinTokenHash = bcrypt.hashSync(joinToken, SALT_ROUNDS);

  const stmt = db.prepare(
    'INSERT INTO interpreters (room_id, name, target_language, join_token_hash) VALUES (?, ?, ?, ?)'
  );

  const result = stmt.run(room_id, name, target_language, joinTokenHash);

  return {
    id: result.lastInsertRowid,
    room_id,
    name,
    target_language,
    join_token: joinToken, // Return unhashed token (only time it's available)
    created_at: new Date().toISOString()
  };
}

/**
 * Get interpreter by ID
 * @param {number} id - Interpreter ID
 * @returns {object|null} Interpreter object (without join_token_hash) or null
 */
export function getInterpreterById(id) {
  const db = getDatabase();
  const stmt = db.prepare(
    'SELECT id, room_id, name, target_language, created_at FROM interpreters WHERE id = ?'
  );
  return stmt.get(id);
}

/**
 * Verify interpreter join token
 * @param {string} joinToken - Plain text join token
 * @returns {object|null} Interpreter object if valid, null otherwise
 */
export function verifyInterpreterToken(joinToken) {
  const db = getDatabase();
  const stmt = db.prepare(
    'SELECT id, room_id, name, target_language, join_token_hash, created_at FROM interpreters'
  );
  const interpreters = stmt.all();

  for (const interpreter of interpreters) {
    if (bcrypt.compareSync(joinToken, interpreter.join_token_hash)) {
      // Return interpreter without hash
      const { join_token_hash, ...interpreterWithoutHash } = interpreter;
      return interpreterWithoutHash;
    }
  }

  return null;
}

/**
 * List interpreters by room ID
 * @param {number} room_id - Room ID
 * @returns {array} Array of interpreter objects
 */
export function listInterpretersByRoom(room_id) {
  const db = getDatabase();
  const stmt = db.prepare(
    'SELECT id, room_id, name, target_language, created_at FROM interpreters WHERE room_id = ? ORDER BY created_at DESC'
  );
  return stmt.all(room_id);
}

/**
 * Delete interpreter by ID
 * @param {number} id - Interpreter ID
 * @returns {boolean} True if deleted, false otherwise
 */
export function deleteInterpreter(id) {
  const db = getDatabase();
  const stmt = db.prepare('DELETE FROM interpreters WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

/**
 * Delete all interpreters for a room
 * @param {number} room_id - Room ID
 * @returns {number} Number of interpreters deleted
 */
export function deleteInterpretersByRoom(room_id) {
  const db = getDatabase();
  const stmt = db.prepare('DELETE FROM interpreters WHERE room_id = ?');
  const result = stmt.run(room_id);
  return result.changes;
}

export default {
  createInterpreter,
  getInterpreterById,
  verifyInterpreterToken,
  listInterpretersByRoom,
  deleteInterpreter,
  deleteInterpretersByRoom
};
