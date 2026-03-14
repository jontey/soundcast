-- Migration: Remove tenant-scoped SFU schema and room SFU fields
-- This is a destructive migration and removes obsolete SFU objects.

PRAGMA foreign_keys = OFF;
BEGIN TRANSACTION;

-- Recreate rooms table without is_local_only and sfu_url.
CREATE TABLE IF NOT EXISTS rooms_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    coturn_config_json TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    UNIQUE (tenant_id, name)
);

INSERT INTO rooms_new (id, tenant_id, name, slug, coturn_config_json, created_at)
SELECT id, tenant_id, name, slug, coturn_config_json, created_at
FROM rooms;

DROP TABLE rooms;
ALTER TABLE rooms_new RENAME TO rooms;

-- Remove tenant-scoped SFU table and indexes.
DROP INDEX IF EXISTS idx_sfus_tenant_id;
DROP INDEX IF EXISTS idx_sfus_status;
DROP INDEX IF EXISTS idx_sfus_last_heartbeat;
DROP TABLE IF EXISTS sfus;

-- Recreate room indexes after table swap.
CREATE INDEX IF NOT EXISTS idx_rooms_tenant_id ON rooms(tenant_id);
CREATE INDEX IF NOT EXISTS idx_rooms_slug ON rooms(slug);

COMMIT;
PRAGMA foreign_keys = ON;
