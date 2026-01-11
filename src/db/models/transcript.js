import { getDatabase } from '../database.js';

/**
 * Create a new transcript
 * @param {object} data - Transcript data
 * @param {number} data.room_id - Room ID
 * @param {string} data.channel_name - Channel name
 * @param {string} data.producer_id - mediasoup producer ID
 * @param {string} data.producer_name - Publisher name
 * @param {string} data.text_content - Transcribed text
 * @param {number} data.timestamp_start - Start timestamp (Unix seconds)
 * @param {number} data.timestamp_end - End timestamp (Unix seconds)
 * @param {number} [data.confidence_score] - Confidence score (0.0-1.0)
 * @param {string} [data.language] - Language code
 * @returns {object} Created transcript
 */
export function createTranscript(data) {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO transcripts
    (room_id, channel_name, producer_id, producer_name, text_content,
     timestamp_start, timestamp_end, confidence_score, language)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    data.room_id,
    data.channel_name,
    data.producer_id,
    data.producer_name || null,
    data.text_content,
    data.timestamp_start,
    data.timestamp_end,
    data.confidence_score || null,
    data.language || null
  );

  return getTranscriptById(result.lastInsertRowid);
}

/**
 * Get transcript by ID
 * @param {number} id - Transcript ID
 * @returns {object|null} Transcript object or null
 */
export function getTranscriptById(id) {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM transcripts WHERE id = ?');
  return stmt.get(id);
}

/**
 * Get transcripts by room ID
 * @param {number} roomId - Room ID
 * @param {object} [options] - Query options
 * @param {number} [options.limit=100] - Maximum number of results
 * @param {number} [options.offset=0] - Offset for pagination
 * @param {string} [options.channelName] - Filter by channel name
 * @param {number} [options.startTime] - Filter by start timestamp
 * @param {number} [options.endTime] - Filter by end timestamp
 * @returns {array} Array of transcript objects
 */
export function getTranscriptsByRoom(roomId, options = {}) {
  const db = getDatabase();
  const { limit = 100, offset = 0, channelName, startTime, endTime } = options;

  let query = 'SELECT * FROM transcripts WHERE room_id = ?';
  const params = [roomId];

  if (channelName) {
    query += ' AND channel_name = ?';
    params.push(channelName);
  }

  if (startTime !== undefined) {
    query += ' AND timestamp_start >= ?';
    params.push(startTime);
  }

  if (endTime !== undefined) {
    query += ' AND timestamp_end <= ?';
    params.push(endTime);
  }

  query += ' ORDER BY timestamp_start DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const stmt = db.prepare(query);
  return stmt.all(...params);
}

/**
 * Get transcripts by producer ID
 * @param {string} producerId - mediasoup producer ID
 * @param {number} [limit=100] - Maximum number of results
 * @returns {array} Array of transcript objects
 */
export function getTranscriptsByProducer(producerId, limit = 100) {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT * FROM transcripts
    WHERE producer_id = ?
    ORDER BY timestamp_start DESC
    LIMIT ?
  `);
  return stmt.all(producerId, limit);
}

/**
 * Get transcripts by time range
 * @param {number} roomId - Room ID
 * @param {number} startTime - Start timestamp (Unix seconds)
 * @param {number} endTime - End timestamp (Unix seconds)
 * @param {string} [channelName] - Optional channel name filter
 * @returns {array} Array of transcript objects
 */
export function getTranscriptsByTimeRange(roomId, startTime, endTime, channelName = null) {
  const db = getDatabase();
  let query = `
    SELECT * FROM transcripts
    WHERE room_id = ?
      AND timestamp_start >= ?
      AND timestamp_end <= ?
  `;
  const params = [roomId, startTime, endTime];

  if (channelName) {
    query += ' AND channel_name = ?';
    params.push(channelName);
  }

  query += ' ORDER BY timestamp_start ASC';

  const stmt = db.prepare(query);
  return stmt.all(...params);
}

/**
 * Get recent transcripts for a room
 * @param {number} roomId - Room ID
 * @param {number} [minutes=60] - Number of minutes to look back
 * @param {string} [channelName] - Optional channel name filter
 * @returns {array} Array of recent transcript objects
 */
export function getRecentTranscripts(roomId, minutes = 60, channelName = null) {
  const cutoffTime = Date.now() / 1000 - (minutes * 60);
  return getTranscriptsByTimeRange(roomId, cutoffTime, Date.now() / 1000, channelName);
}

/**
 * Count transcripts for a room
 * @param {number} roomId - Room ID
 * @param {string} [channelName] - Optional channel name filter
 * @returns {number} Count of transcripts
 */
export function countTranscripts(roomId, channelName = null) {
  const db = getDatabase();
  let query = 'SELECT COUNT(*) as count FROM transcripts WHERE room_id = ?';
  const params = [roomId];

  if (channelName) {
    query += ' AND channel_name = ?';
    params.push(channelName);
  }

  const stmt = db.prepare(query);
  const result = stmt.get(...params);
  return result.count;
}

/**
 * Delete transcripts older than specified days
 * @param {number} daysToKeep - Number of days to retain transcripts
 * @returns {number} Number of transcripts deleted
 */
export function deleteOldTranscripts(daysToKeep) {
  const db = getDatabase();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

  const stmt = db.prepare(`
    DELETE FROM transcripts
    WHERE created_at < ?
  `);

  const result = stmt.run(cutoffDate.toISOString());
  return result.changes;
}

/**
 * Delete all transcripts for a room
 * @param {number} roomId - Room ID
 * @returns {number} Number of transcripts deleted
 */
export function deleteTranscriptsByRoom(roomId) {
  const db = getDatabase();
  const stmt = db.prepare('DELETE FROM transcripts WHERE room_id = ?');
  const result = stmt.run(roomId);
  return result.changes;
}

/**
 * Delete a single transcript by ID
 * @param {number} id - Transcript ID
 * @returns {boolean} True if deleted, false otherwise
 */
export function deleteTranscript(id) {
  const db = getDatabase();
  const stmt = db.prepare('DELETE FROM transcripts WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

export default {
  createTranscript,
  getTranscriptById,
  getTranscriptsByRoom,
  getTranscriptsByProducer,
  getTranscriptsByTimeRange,
  getRecentTranscripts,
  countTranscripts,
  deleteOldTranscripts,
  deleteTranscriptsByRoom,
  deleteTranscript
};
