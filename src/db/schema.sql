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

-- 2.3. Interpreter Model
CREATE TABLE IF NOT EXISTS interpreters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    target_language TEXT NOT NULL, -- e.g., 'es', 'fr', 'zh'
    join_token_hash TEXT NOT NULL UNIQUE, -- Secure hash of the temporary join token
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (room_id) REFERENCES rooms(id)
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_rooms_tenant_id ON rooms(tenant_id);
CREATE INDEX IF NOT EXISTS idx_rooms_slug ON rooms(slug);
CREATE INDEX IF NOT EXISTS idx_interpreters_room_id ON interpreters(room_id);
CREATE INDEX IF NOT EXISTS idx_interpreters_join_token_hash ON interpreters(join_token_hash);
