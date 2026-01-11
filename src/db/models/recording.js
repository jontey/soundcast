import { getDatabase } from '../database.js';

/**
 * Create a new recording session
 * @param {number} roomId - Room ID
 * @param {string} folderName - Unique folder name for this recording
 * @returns {object} Created recording
 */
export function createRecording(roomId, folderName) {
  const db = getDatabase();
  const stmt = db.prepare(
    'INSERT INTO recordings (room_id, folder_name, status, started_at) VALUES (?, ?, ?, ?)'
  );
  const now = new Date().toISOString();
  const result = stmt.run(roomId, folderName, 'recording', now);
  return getRecordingById(result.lastInsertRowid);
}

/**
 * Get recording by ID
 * @param {number} id - Recording ID
 * @returns {object|null} Recording object or null
 */
export function getRecordingById(id) {
  const db = getDatabase();
  const stmt = db.prepare(
    'SELECT id, room_id, folder_name, status, started_at, stopped_at FROM recordings WHERE id = ?'
  );
  return stmt.get(id);
}

/**
 * Get active recording for a room
 * @param {number} roomId - Room ID
 * @returns {object|null} Active recording or null
 */
export function getActiveRecordingByRoomId(roomId) {
  const db = getDatabase();
  const stmt = db.prepare(
    'SELECT id, room_id, folder_name, status, started_at, stopped_at FROM recordings WHERE room_id = ? AND status = ?'
  );
  return stmt.get(roomId, 'recording');
}

/**
 * Update recording status
 * @param {number} id - Recording ID
 * @param {string} status - New status (recording, stopped, error)
 * @param {string|null} stoppedAt - Stop timestamp (ISO string)
 * @returns {object|null} Updated recording or null
 */
export function updateRecordingStatus(id, status, stoppedAt = null) {
  const db = getDatabase();
  if (stoppedAt) {
    const stmt = db.prepare('UPDATE recordings SET status = ?, stopped_at = ? WHERE id = ?');
    stmt.run(status, stoppedAt, id);
  } else {
    const stmt = db.prepare('UPDATE recordings SET status = ? WHERE id = ?');
    stmt.run(status, id);
  }
  return getRecordingById(id);
}

/**
 * List recordings for a room
 * @param {number} roomId - Room ID
 * @returns {array} Array of recording objects
 */
export function listRecordingsByRoomId(roomId) {
  const db = getDatabase();
  const stmt = db.prepare(
    'SELECT id, room_id, folder_name, status, started_at, stopped_at FROM recordings WHERE room_id = ? ORDER BY started_at DESC'
  );
  return stmt.all(roomId);
}

/**
 * Mark all active recordings as error (for server restart recovery)
 * @returns {number} Number of recordings marked as error
 */
export function markActiveRecordingsAsError() {
  const db = getDatabase();
  const now = new Date().toISOString();
  const stmt = db.prepare('UPDATE recordings SET status = ?, stopped_at = ? WHERE status = ?');
  const result = stmt.run('error', now, 'recording');
  return result.changes;
}

// ============ Recording Tracks ============

/**
 * Create a new recording track
 * @param {number} recordingId - Recording ID
 * @param {string} channelName - Channel name
 * @param {string} producerId - Mediasoup producer ID
 * @param {string|null} producerName - Publisher name
 * @param {string} filePath - Relative file path within recording folder
 * @returns {object} Created track
 */
export function createRecordingTrack(recordingId, channelName, producerId, producerName, filePath) {
  const db = getDatabase();
  const stmt = db.prepare(
    'INSERT INTO recording_tracks (recording_id, channel_name, producer_id, producer_name, file_path, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const now = new Date().toISOString();
  const result = stmt.run(recordingId, channelName, producerId, producerName, filePath, 'recording', now);
  return getRecordingTrackById(result.lastInsertRowid);
}

/**
 * Get recording track by ID
 * @param {number} id - Track ID
 * @returns {object|null} Track object or null
 */
export function getRecordingTrackById(id) {
  const db = getDatabase();
  const stmt = db.prepare(
    'SELECT id, recording_id, channel_name, producer_id, producer_name, file_path, status, started_at, stopped_at FROM recording_tracks WHERE id = ?'
  );
  return stmt.get(id);
}

/**
 * Get recording track by producer ID
 * @param {number} recordingId - Recording ID
 * @param {string} producerId - Mediasoup producer ID
 * @returns {object|null} Track object or null
 */
export function getRecordingTrackByProducerId(recordingId, producerId) {
  const db = getDatabase();
  const stmt = db.prepare(
    'SELECT id, recording_id, channel_name, producer_id, producer_name, file_path, status, started_at, stopped_at FROM recording_tracks WHERE recording_id = ? AND producer_id = ?'
  );
  return stmt.get(recordingId, producerId);
}

/**
 * Update track status
 * @param {number} id - Track ID
 * @param {string} status - New status (recording, stopped, error)
 * @param {string|null} stoppedAt - Stop timestamp (ISO string)
 * @returns {object|null} Updated track or null
 */
export function updateRecordingTrackStatus(id, status, stoppedAt = null) {
  const db = getDatabase();
  if (stoppedAt) {
    const stmt = db.prepare('UPDATE recording_tracks SET status = ?, stopped_at = ? WHERE id = ?');
    stmt.run(status, stoppedAt, id);
  } else {
    const stmt = db.prepare('UPDATE recording_tracks SET status = ? WHERE id = ?');
    stmt.run(status, id);
  }
  return getRecordingTrackById(id);
}

/**
 * List tracks for a recording
 * @param {number} recordingId - Recording ID
 * @returns {array} Array of track objects
 */
export function listTracksByRecordingId(recordingId) {
  const db = getDatabase();
  const stmt = db.prepare(
    'SELECT id, recording_id, channel_name, producer_id, producer_name, file_path, status, started_at, stopped_at FROM recording_tracks WHERE recording_id = ? ORDER BY started_at ASC'
  );
  return stmt.all(recordingId);
}

/**
 * Mark all active tracks as stopped for a recording
 * @param {number} recordingId - Recording ID
 * @returns {number} Number of tracks marked as stopped
 */
export function stopAllTracksForRecording(recordingId) {
  const db = getDatabase();
  const now = new Date().toISOString();
  const stmt = db.prepare('UPDATE recording_tracks SET status = ?, stopped_at = ? WHERE recording_id = ? AND status = ?');
  const result = stmt.run('stopped', now, recordingId, 'recording');
  return result.changes;
}

export default {
  createRecording,
  getRecordingById,
  getActiveRecordingByRoomId,
  updateRecordingStatus,
  listRecordingsByRoomId,
  markActiveRecordingsAsError,
  createRecordingTrack,
  getRecordingTrackById,
  getRecordingTrackByProducerId,
  updateRecordingTrackStatus,
  listTracksByRecordingId,
  stopAllTracksForRecording
};
