-- Migration: Add transcription v2 schema
-- Date: 2026-03-14

CREATE TABLE IF NOT EXISTS transcription_sessions_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL,
    recording_id INTEGER NOT NULL,
    event_name TEXT NOT NULL,
    model_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    stopped_at DATETIME,
    error_message TEXT,
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
    FOREIGN KEY (recording_id) REFERENCES recordings(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS transcription_streams_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    room_id INTEGER NOT NULL,
    channel_name TEXT NOT NULL,
    producer_id TEXT NOT NULL,
    publisher_id INTEGER,
    producer_name TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    stopped_at DATETIME,
    UNIQUE(session_id, producer_id),
    FOREIGN KEY (session_id) REFERENCES transcription_sessions_v2(id) ON DELETE CASCADE,
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS transcript_segments_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    stream_id INTEGER NOT NULL,
    room_id INTEGER NOT NULL,
    channel_name TEXT NOT NULL,
    producer_id TEXT NOT NULL,
    publisher_id INTEGER,
    segment_file TEXT,
    text_content TEXT NOT NULL,
    timestamp_start_ms INTEGER,
    timestamp_end_ms INTEGER,
    confidence_score REAL,
    language TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES transcription_sessions_v2(id) ON DELETE CASCADE,
    FOREIGN KEY (stream_id) REFERENCES transcription_streams_v2(id) ON DELETE CASCADE,
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS transcript_docs_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    room_id INTEGER NOT NULL,
    channel_name TEXT NOT NULL,
    text_content TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(session_id, channel_name),
    FOREIGN KEY (session_id) REFERENCES transcription_sessions_v2(id) ON DELETE CASCADE,
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_transcription_sessions_v2_room_status
ON transcription_sessions_v2(room_id, status);

CREATE INDEX IF NOT EXISTS idx_transcription_streams_v2_session
ON transcription_streams_v2(session_id);

CREATE INDEX IF NOT EXISTS idx_transcript_segments_v2_session_channel
ON transcript_segments_v2(session_id, channel_name, created_at);

CREATE INDEX IF NOT EXISTS idx_transcript_docs_v2_room_channel
ON transcript_docs_v2(room_id, channel_name);
