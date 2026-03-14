import { getDatabase } from '../database.js';

function nowIso() {
  return new Date().toISOString();
}

export function createTranscriptionSession({ room_id, recording_id, event_name, model_name }) {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO transcription_sessions_v2
      (room_id, recording_id, event_name, model_name, status, started_at)
    VALUES (?, ?, ?, ?, 'active', ?)
  `);
  const result = stmt.run(room_id, recording_id, event_name, model_name, nowIso());
  return getTranscriptionSessionById(result.lastInsertRowid);
}

export function getTranscriptionSessionById(id) {
  const db = getDatabase();
  return db.prepare(`
    SELECT id, room_id, recording_id, event_name, model_name, status, started_at, stopped_at, error_message
    FROM transcription_sessions_v2
    WHERE id = ?
  `).get(id);
}

export function getTranscriptionSessionByRoomAndId(room_id, session_id) {
  const db = getDatabase();
  return db.prepare(`
    SELECT id, room_id, recording_id, event_name, model_name, status, started_at, stopped_at, error_message
    FROM transcription_sessions_v2
    WHERE room_id = ? AND id = ?
    LIMIT 1
  `).get(room_id, session_id);
}

export function listTranscriptionSessionsByRoom(room_id, limit = 20, offset = 0) {
  const db = getDatabase();
  return db.prepare(`
    SELECT id, room_id, recording_id, event_name, model_name, status, started_at, stopped_at, error_message
    FROM transcription_sessions_v2
    WHERE room_id = ?
    ORDER BY started_at DESC
    LIMIT ? OFFSET ?
  `).all(room_id, limit, offset);
}

export function countTranscriptionSessionsByRoom(room_id) {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT COUNT(*) as total
    FROM transcription_sessions_v2
    WHERE room_id = ?
  `).get(room_id);
  return row?.total || 0;
}

export function getActiveTranscriptionSessionByRoomId(room_id) {
  const db = getDatabase();
  return db.prepare(`
    SELECT id, room_id, recording_id, event_name, model_name, status, started_at, stopped_at, error_message
    FROM transcription_sessions_v2
    WHERE room_id = ? AND status = 'active'
    ORDER BY started_at DESC
    LIMIT 1
  `).get(room_id);
}

export function listActiveTranscriptionSessions() {
  const db = getDatabase();
  return db.prepare(`
    SELECT id, room_id, recording_id, event_name, model_name, status, started_at, stopped_at, error_message
    FROM transcription_sessions_v2
    WHERE status = 'active'
    ORDER BY started_at ASC
  `).all();
}

export function stopTranscriptionSession(session_id, status = 'stopped', error_message = null) {
  const db = getDatabase();
  db.prepare(`
    UPDATE transcription_sessions_v2
    SET status = ?, stopped_at = ?, error_message = ?
    WHERE id = ?
  `).run(status, nowIso(), error_message, session_id);
  return getTranscriptionSessionById(session_id);
}

export function upsertTranscriptionStream({
  session_id,
  room_id,
  channel_name,
  producer_id,
  publisher_id = null,
  producer_name = null
}) {
  const db = getDatabase();
  const existing = db.prepare(`
    SELECT id FROM transcription_streams_v2
    WHERE session_id = ? AND producer_id = ?
  `).get(session_id, producer_id);

  if (existing) {
    db.prepare(`
      UPDATE transcription_streams_v2
      SET room_id = ?, channel_name = ?, publisher_id = ?, producer_name = ?, status = 'active', stopped_at = NULL
      WHERE id = ?
    `).run(room_id, channel_name, publisher_id, producer_name, existing.id);
    return getTranscriptionStreamById(existing.id);
  }

  const result = db.prepare(`
    INSERT INTO transcription_streams_v2
      (session_id, room_id, channel_name, producer_id, publisher_id, producer_name, status, started_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
  `).run(session_id, room_id, channel_name, producer_id, publisher_id, producer_name, nowIso());
  return getTranscriptionStreamById(result.lastInsertRowid);
}

export function getTranscriptionStreamById(id) {
  const db = getDatabase();
  return db.prepare(`
    SELECT id, session_id, room_id, channel_name, producer_id, publisher_id, producer_name, status, started_at, stopped_at
    FROM transcription_streams_v2
    WHERE id = ?
  `).get(id);
}

export function getActiveTranscriptionStreamsBySession(session_id) {
  const db = getDatabase();
  return db.prepare(`
    SELECT id, session_id, room_id, channel_name, producer_id, publisher_id, producer_name, status, started_at, stopped_at
    FROM transcription_streams_v2
    WHERE session_id = ? AND status = 'active'
    ORDER BY started_at ASC
  `).all(session_id);
}

export function stopTranscriptionStream(session_id, producer_id, status = 'stopped') {
  const db = getDatabase();
  db.prepare(`
    UPDATE transcription_streams_v2
    SET status = ?, stopped_at = ?
    WHERE session_id = ? AND producer_id = ?
  `).run(status, nowIso(), session_id, producer_id);
}

export function stopAllTranscriptionStreamsBySession(session_id, status = 'stopped') {
  const db = getDatabase();
  db.prepare(`
    UPDATE transcription_streams_v2
    SET status = ?, stopped_at = ?
    WHERE session_id = ? AND status = 'active'
  `).run(status, nowIso(), session_id);
}

export function createTranscriptSegment({
  session_id,
  stream_id,
  room_id,
  channel_name,
  producer_id,
  publisher_id = null,
  segment_file = null,
  text_content,
  timestamp_start_ms = null,
  timestamp_end_ms = null,
  confidence_score = null,
  language = null
}) {
  const db = getDatabase();
  const result = db.prepare(`
    INSERT INTO transcript_segments_v2
      (session_id, stream_id, room_id, channel_name, producer_id, publisher_id, segment_file, text_content, timestamp_start_ms, timestamp_end_ms, confidence_score, language, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    session_id,
    stream_id,
    room_id,
    channel_name,
    producer_id,
    publisher_id,
    segment_file,
    text_content,
    timestamp_start_ms,
    timestamp_end_ms,
    confidence_score,
    language,
    nowIso()
  );
  return db.prepare(`
    SELECT id, session_id, stream_id, room_id, channel_name, producer_id, publisher_id, segment_file, text_content, timestamp_start_ms, timestamp_end_ms, confidence_score, language, created_at
    FROM transcript_segments_v2
    WHERE id = ?
  `).get(result.lastInsertRowid);
}

export function listTranscriptDocsByRoom(room_id) {
  const db = getDatabase();
  return db.prepare(`
    SELECT d.id, d.session_id, d.room_id, d.channel_name, d.text_content, d.revision, d.updated_at, d.created_at
    FROM transcript_docs_v2 d
    JOIN transcription_sessions_v2 s ON s.id = d.session_id
    WHERE d.room_id = ? AND s.status = 'active'
    ORDER BY d.channel_name ASC
  `).all(room_id);
}

export function listTranscriptDocsBySession(room_id, session_id) {
  const db = getDatabase();
  return db.prepare(`
    SELECT d.id, d.session_id, d.room_id, d.channel_name, d.text_content, d.revision, d.updated_at, d.created_at
    FROM transcript_docs_v2 d
    WHERE d.room_id = ? AND d.session_id = ?
    ORDER BY d.channel_name ASC
  `).all(room_id, session_id);
}

export function getTranscriptDocByRoomChannel(room_id, channel_name) {
  const db = getDatabase();
  return db.prepare(`
    SELECT d.id, d.session_id, d.room_id, d.channel_name, d.text_content, d.revision, d.updated_at, d.created_at
    FROM transcript_docs_v2 d
    JOIN transcription_sessions_v2 s ON s.id = d.session_id
    WHERE d.room_id = ? AND d.channel_name = ? AND s.status = 'active'
    ORDER BY d.updated_at DESC
    LIMIT 1
  `).get(room_id, channel_name);
}

export function getTranscriptDocBySessionChannel(room_id, session_id, channel_name) {
  const db = getDatabase();
  return db.prepare(`
    SELECT d.id, d.session_id, d.room_id, d.channel_name, d.text_content, d.revision, d.updated_at, d.created_at
    FROM transcript_docs_v2 d
    WHERE d.room_id = ? AND d.session_id = ? AND d.channel_name = ?
    LIMIT 1
  `).get(room_id, session_id, channel_name);
}

export function getLatestTranscriptDocByRoomEventChannel(room_id, event_name, channel_name) {
  if (!event_name) return null;
  const db = getDatabase();
  return db.prepare(`
    SELECT d.id, d.session_id, d.room_id, d.channel_name, d.text_content, d.revision, d.updated_at, d.created_at
    FROM transcript_docs_v2 d
    JOIN transcription_sessions_v2 s ON s.id = d.session_id
    WHERE d.room_id = ? AND d.channel_name = ? AND s.event_name = ?
    ORDER BY d.updated_at DESC
    LIMIT 1
  `).get(room_id, channel_name, event_name);
}

export function upsertTranscriptDoc({
  session_id,
  room_id,
  channel_name,
  text_content,
  revision
}) {
  const db = getDatabase();
  const existing = db.prepare(`
    SELECT id, revision
    FROM transcript_docs_v2
    WHERE session_id = ? AND channel_name = ?
  `).get(session_id, channel_name);

  if (existing) {
    db.prepare(`
      UPDATE transcript_docs_v2
      SET text_content = ?, revision = ?, updated_at = ?
      WHERE id = ?
    `).run(text_content, revision, nowIso(), existing.id);
    return db.prepare(`
      SELECT id, session_id, room_id, channel_name, text_content, revision, updated_at, created_at
      FROM transcript_docs_v2
      WHERE id = ?
    `).get(existing.id);
  }

  const result = db.prepare(`
    INSERT INTO transcript_docs_v2
      (session_id, room_id, channel_name, text_content, revision, updated_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(session_id, room_id, channel_name, text_content, revision, nowIso(), nowIso());
  return db.prepare(`
    SELECT id, session_id, room_id, channel_name, text_content, revision, updated_at, created_at
    FROM transcript_docs_v2
    WHERE id = ?
  `).get(result.lastInsertRowid);
}

export function listTranscriptSegmentsByRoomChannel(room_id, channel_name, limit = 200) {
  const db = getDatabase();
  return db.prepare(`
    SELECT id, session_id, stream_id, room_id, channel_name, producer_id, publisher_id, segment_file, text_content, timestamp_start_ms, timestamp_end_ms, confidence_score, language, created_at
    FROM transcript_segments_v2
    WHERE room_id = ? AND channel_name = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(room_id, channel_name, limit);
}

export default {
  createTranscriptionSession,
  getTranscriptionSessionById,
  getTranscriptionSessionByRoomAndId,
  listTranscriptionSessionsByRoom,
  countTranscriptionSessionsByRoom,
  getActiveTranscriptionSessionByRoomId,
  listActiveTranscriptionSessions,
  stopTranscriptionSession,
  upsertTranscriptionStream,
  getTranscriptionStreamById,
  getActiveTranscriptionStreamsBySession,
  stopTranscriptionStream,
  stopAllTranscriptionStreamsBySession,
  createTranscriptSegment,
  listTranscriptDocsByRoom,
  listTranscriptDocsBySession,
  getTranscriptDocByRoomChannel,
  getTranscriptDocBySessionChannel,
  getLatestTranscriptDocByRoomEventChannel,
  upsertTranscriptDoc,
  listTranscriptSegmentsByRoomChannel
};
