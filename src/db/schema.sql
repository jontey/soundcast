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

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_rooms_tenant_id ON rooms(tenant_id);
CREATE INDEX IF NOT EXISTS idx_rooms_slug ON rooms(slug);
CREATE INDEX IF NOT EXISTS idx_publishers_room_id ON publishers(room_id);
CREATE INDEX IF NOT EXISTS idx_publishers_join_token_hash ON publishers(join_token_hash);
CREATE INDEX IF NOT EXISTS idx_sfus_tenant_id ON sfus(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sfus_status ON sfus(status);
CREATE INDEX IF NOT EXISTS idx_sfus_last_heartbeat ON sfus(last_heartbeat);
