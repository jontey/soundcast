-- Soundcast Multi-Tenant Database Schema
-- SQLite version

-- 2.1. Tenant Model
CREATE TABLE IF NOT EXISTS tenants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    api_key_hash TEXT NOT NULL, -- Hashed API key for tenant admin access
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 2.2. Room Model
-- CRITICAL fields: is_local_only, sfu_url, coturn_config_json
CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE, -- URL-friendly identifier
    is_local_only BOOLEAN NOT NULL DEFAULT 0, -- 1=Local SFU, 0=Public SFU
    sfu_url TEXT NOT NULL, -- The WebSocket URL for the target SFU (local or public)
    coturn_config_json TEXT NOT NULL, -- JSON array of WebRTC ICE servers
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    UNIQUE (tenant_id, name)
);

-- 2.3. Publisher Model (token-based authentication for broadcasters)
-- Each publisher broadcasts to a specific channel_name
CREATE TABLE IF NOT EXISTS publishers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    channel_name TEXT NOT NULL, -- Channel to broadcast to
    join_token TEXT NOT NULL, -- Plain text token for display in admin UI
    join_token_hash TEXT NOT NULL UNIQUE, -- Secure hash for verification
    transcription_language TEXT DEFAULT 'en', -- Language code for Whisper transcription
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (room_id) REFERENCES rooms(id)
);

-- 2.5. SFU Model (tenant-scoped SFU key registration)
-- Keys are created first (pending), then SFU registers with its details
CREATE TABLE IF NOT EXISTS sfus (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,              -- Associate with tenant
    secret_key TEXT NOT NULL,                -- Plain text for display in admin UI
    secret_key_hash TEXT NOT NULL UNIQUE,    -- Hashed secret key for verification
    name TEXT,                               -- Set when SFU registers (nullable)
    url TEXT,                                -- WebSocket URL, set when SFU registers
    announced_ip TEXT,                       -- Public/announced IP, set when SFU registers
    port INTEGER,                            -- WebSocket port, set when SFU registers
    status TEXT NOT NULL DEFAULT 'pending',  -- pending, online, offline
    last_heartbeat DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

-- 2.6. Recordings Model (room-level recording sessions)
CREATE TABLE IF NOT EXISTS recordings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL,
    folder_name TEXT NOT NULL,                   -- Unique folder: "roomSlug_YYYYMMDD_HHMMSS"
    status TEXT NOT NULL DEFAULT 'recording',    -- recording, stopped, error
    started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    stopped_at DATETIME,
    FOREIGN KEY (room_id) REFERENCES rooms(id)
);

-- 2.7. Recording Tracks Model (individual producer recordings within a session)
CREATE TABLE IF NOT EXISTS recording_tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recording_id INTEGER NOT NULL,
    channel_name TEXT NOT NULL,
    producer_id TEXT NOT NULL,                   -- mediasoup producer ID
    producer_name TEXT,                          -- Publisher name if available
    file_path TEXT NOT NULL,                     -- Relative path within recording folder
    status TEXT NOT NULL DEFAULT 'recording',    -- recording, stopped, error
    started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    stopped_at DATETIME,
    FOREIGN KEY (recording_id) REFERENCES recordings(id)
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_rooms_tenant_id ON rooms(tenant_id);
CREATE INDEX IF NOT EXISTS idx_rooms_slug ON rooms(slug);
CREATE INDEX IF NOT EXISTS idx_publishers_room_id ON publishers(room_id);
CREATE INDEX IF NOT EXISTS idx_publishers_join_token_hash ON publishers(join_token_hash);
CREATE INDEX IF NOT EXISTS idx_sfus_tenant_id ON sfus(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sfus_status ON sfus(status);
CREATE INDEX IF NOT EXISTS idx_sfus_last_heartbeat ON sfus(last_heartbeat);
CREATE INDEX IF NOT EXISTS idx_recordings_room_id ON recordings(room_id);
CREATE INDEX IF NOT EXISTS idx_recordings_status ON recordings(status);
CREATE INDEX IF NOT EXISTS idx_recording_tracks_recording_id ON recording_tracks(recording_id);

-- 2.8. Transcripts Model (real-time transcription with timestamps)
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

-- 2.9. Embedding Metadata Model (tracks vector embeddings for transcripts)
CREATE TABLE IF NOT EXISTS embedding_metadata (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transcript_id INTEGER NOT NULL UNIQUE,
    room_id INTEGER NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (transcript_id) REFERENCES transcripts(id) ON DELETE CASCADE
);

-- 2.10. Vector Embeddings (sqlite-vec virtual table for semantic search)
-- Note: Requires sqlite-vec extension to be loaded
-- Run: chmod +x scripts/setup-sqlite-vec.sh && ./scripts/setup-sqlite-vec.sh
CREATE VIRTUAL TABLE IF NOT EXISTS transcript_embeddings USING vec0(
  embedding float[384]
);

-- Index for efficient rowid lookups (transcript_id is stored as rowid)
-- The vec0 virtual table uses rowid as the primary key
