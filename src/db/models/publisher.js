import { getDatabase } from '../database.js';
import bcryptjs from 'bcryptjs';
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
 * Create a new publisher
 * @param {object} publisherData - Publisher data
 * @param {number} publisherData.room_id - Room ID
 * @param {string} publisherData.name - Publisher name
 * @param {string} publisherData.channel_name - Channel to broadcast to
 * @param {string} [publisherData.transcription_language='en'] - Language for transcription
 * @returns {object} Created publisher with join_token
 */
export function createPublisher({ room_id, name, channel_name, transcription_language = 'en' }) {
  const db = getDatabase();

  // Generate unique join token
  const joinToken = generateToken(16); // 32 character hex string
  const joinTokenHash = bcryptjs.hashSync(joinToken, SALT_ROUNDS);

  const stmt = db.prepare(
    'INSERT INTO publishers (room_id, name, channel_name, join_token, join_token_hash, transcription_language) VALUES (?, ?, ?, ?, ?, ?)'
  );

  const result = stmt.run(room_id, name, channel_name, joinToken, joinTokenHash, transcription_language);

  return {
    id: result.lastInsertRowid,
    room_id,
    name,
    channel_name,
    join_token: joinToken,
    transcription_language,
    created_at: new Date().toISOString()
  };
}

/**
 * Get publisher by ID
 * @param {number} id - Publisher ID
 * @returns {object|null} Publisher object (without join_token_hash) or null
 */
export function getPublisherById(id) {
  const db = getDatabase();
  const stmt = db.prepare(
    'SELECT id, room_id, name, channel_name, join_token, transcription_language, created_at FROM publishers WHERE id = ?'
  );
  return stmt.get(id);
}

/**
 * Verify publisher join token
 * @param {string} joinToken - Plain text join token
 * @returns {object|null} Publisher object if valid, null otherwise
 */
export function verifyPublisherToken(joinToken) {
  const db = getDatabase();
  const stmt = db.prepare(
    'SELECT id, room_id, name, channel_name, join_token_hash, transcription_language, created_at FROM publishers'
  );
  const publishers = stmt.all();

  for (const publisher of publishers) {
    if (bcryptjs.compareSync(joinToken, publisher.join_token_hash)) {
      // Return publisher without hash
      const { join_token_hash, ...publisherWithoutHash } = publisher;
      return publisherWithoutHash;
    }
  }

  return null;
}

/**
 * List publishers by room ID
 * @param {number} room_id - Room ID
 * @returns {array} Array of publisher objects (includes join_token for admin display)
 */
export function listPublishersByRoom(room_id) {
  const db = getDatabase();
  const stmt = db.prepare(
    'SELECT id, room_id, name, channel_name, join_token, transcription_language, created_at FROM publishers WHERE room_id = ? ORDER BY created_at DESC'
  );
  return stmt.all(room_id);
}

/**
 * Delete publisher by ID
 * @param {number} id - Publisher ID
 * @returns {boolean} True if deleted, false otherwise
 */
export function deletePublisher(id) {
  const db = getDatabase();
  const stmt = db.prepare('DELETE FROM publishers WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

/**
 * Update publisher details
 * @param {number} id - Publisher ID
 * @param {object} updates - Updates to apply
 * @param {string} updates.name - Publisher name
 * @param {string} updates.channel_name - Channel name
 * @param {string} updates.transcription_language - Transcription language code
 * @returns {object|null} Updated publisher object or null if not found
 */
export function updatePublisher(id, { name, channel_name, transcription_language }) {
  const db = getDatabase();

  const updates = [];
  const values = [];

  if (name !== undefined) {
    updates.push('name = ?');
    values.push(name);
  }

  if (channel_name !== undefined) {
    updates.push('channel_name = ?');
    values.push(channel_name);
  }

  if (transcription_language !== undefined) {
    updates.push('transcription_language = ?');
    values.push(transcription_language);
  }

  if (updates.length === 0) {
    return getPublisherById(id);
  }

  values.push(id);

  const stmt = db.prepare(`UPDATE publishers SET ${updates.join(', ')} WHERE id = ?`);
  stmt.run(...values);

  return getPublisherById(id);
}

/**
 * Delete all publishers for a room
 * @param {number} room_id - Room ID
 * @returns {number} Number of publishers deleted
 */
export function deletePublishersByRoom(room_id) {
  const db = getDatabase();
  const stmt = db.prepare('DELETE FROM publishers WHERE room_id = ?');
  const result = stmt.run(room_id);
  return result.changes;
}

/**
 * Get unique channel names for a room
 * @param {number} room_id - Room ID
 * @returns {array} Array of unique channel names
 */
export function getChannelsByRoom(room_id) {
  const db = getDatabase();
  const stmt = db.prepare(
    'SELECT DISTINCT channel_name FROM publishers WHERE room_id = ? ORDER BY channel_name'
  );
  const rows = stmt.all(room_id);
  return rows.map(row => row.channel_name);
}

export default {
  createPublisher,
  getPublisherById,
  verifyPublisherToken,
  listPublishersByRoom,
  getChannelsByRoom,
  deletePublisher,
  deletePublishersByRoom
};
