-- Migration: Remove tenants table and tenant_id column from rooms
-- This is a destructive migration and drops multi-tenant scoping.
-- Run manually after backing up the database.

PRAGMA foreign_keys = OFF;
BEGIN TRANSACTION;

-- Drop the rooms table and recreate it without tenant_id.
CREATE TABLE IF NOT EXISTS rooms_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    slug TEXT NOT NULL UNIQUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO rooms_new (id, name, slug, created_at)
SELECT id, name, slug, created_at
FROM rooms;

DROP TABLE rooms;
ALTER TABLE rooms_new RENAME TO rooms;

-- Drop tenant-scoped indexes.
DROP INDEX IF EXISTS idx_rooms_tenant_id;

-- Recreate room indexes after the table swap.
CREATE INDEX IF NOT EXISTS idx_rooms_slug ON rooms(slug);

-- Drop tenants table.
DROP TABLE IF EXISTS tenants;

COMMIT;
PRAGMA foreign_keys = ON;