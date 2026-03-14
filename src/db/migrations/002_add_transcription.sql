-- Migration: Legacy transcription schema
-- Legacy only: retained for backward compatibility with existing databases.
-- Runtime no longer reads/writes these objects.

-- Add transcription_language to publishers table (legacy, currently unused)
ALTER TABLE publishers ADD COLUMN transcription_language TEXT DEFAULT 'en';

-- Create legacy transcripts table
CREATE TABLE IF NOT EXISTS transcripts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL,
    channel_name TEXT NOT NULL,
    producer_id TEXT NOT NULL,       -- mediasoup producer UUID
    producer_name TEXT,
    text_content TEXT NOT NULL,
    timestamp_start REAL NOT NULL,   -- Unix timestamp (seconds.milliseconds)
    timestamp_end REAL NOT NULL,
    confidence_score REAL,           -- 0.0 to 1.0
    language TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_transcripts_room_id ON transcripts(room_id);
CREATE INDEX IF NOT EXISTS idx_transcripts_producer_id ON transcripts(producer_id);
CREATE INDEX IF NOT EXISTS idx_transcripts_timestamp ON transcripts(timestamp_start);
CREATE INDEX IF NOT EXISTS idx_transcripts_channel ON transcripts(channel_name);

-- Create legacy embedding metadata table
CREATE TABLE IF NOT EXISTS embedding_metadata (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transcript_id INTEGER NOT NULL UNIQUE,
    room_id INTEGER NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (transcript_id) REFERENCES transcripts(id) ON DELETE CASCADE
);
