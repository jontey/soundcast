import { getDatabase } from '../database.js';
import { deletePublishersByRoom } from './publisher.js';

/**
 * Generate a URL-friendly slug from room name and ID
 * @param {string} name - Room name
 * @param {number} id - Room ID
 * @returns {string} Slug
 */
function generateSlug(name, id) {
  const baseSlug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${baseSlug}-${id}`;
}

/**
 * Create a new room
 * @param {object} roomData - Room data
 * @param {number} roomData.tenant_id - Tenant ID
 * @param {string} roomData.name - Room name
 * @returns {object} Created room
 */
export function createRoom({ tenant_id, name, slug }) {
  const db = getDatabase();

  // First insert without slug to get the ID
  const stmt = db.prepare(
    'INSERT INTO rooms (tenant_id, name, slug) VALUES (?, ?, ?)'
  );

  // Temporary slug (will be updated)
  const tempSlug = `temp-${Date.now()}`;

  const result = stmt.run(
    tenant_id,
    name,
    tempSlug
  );

  const roomId = result.lastInsertRowid;

  // Generate final slug with ID
  const finalSlug = slug || generateSlug(name, roomId);

  // Update with final slug
  const updateStmt = db.prepare('UPDATE rooms SET slug = ? WHERE id = ?');
  updateStmt.run(finalSlug, roomId);

  // Return the created room
  return getRoomById(roomId);
}

/**
 * Get room by ID
 * @param {number} id - Room ID
 * @returns {object|null} Room object or null
 */
export function getRoomById(id) {
  const db = getDatabase();
  const stmt = db.prepare(
    'SELECT id, tenant_id, name, slug, created_at FROM rooms WHERE id = ?'
  );
  return stmt.get(id);
}

/**
 * Get room by slug
 * @param {string} slug - Room slug
 * @returns {object|null} Room object or null
 */
export function getRoomBySlug(slug) {
  const db = getDatabase();
  const stmt = db.prepare(
    'SELECT id, tenant_id, name, slug, created_at FROM rooms WHERE slug = ?'
  );
  return stmt.get(slug);
}

/**
 * Update room by slug
 * @param {string} slug - Room slug
 * @param {object} updates - Fields to update
 * @returns {object|null} Updated room or null
 */
export function updateRoom(slug, updates) {
  const db = getDatabase();
  const room = getRoomBySlug(slug);

  if (!room) {
    return null;
  }

  const allowedFields = ['name', 'slug'];
  const updateFields = [];
  const values = [];

  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      if (field === 'slug') {
        // Validate slug format
        const slugValue = updates[field].toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
        if (!slugValue) {
          throw new Error('Invalid slug format');
        }
        // Check if slug already exists (for a different room)
        const existingRoom = getRoomBySlug(slugValue);
        if (existingRoom && existingRoom.id !== room.id) {
          throw new Error('Slug already in use');
        }
        updateFields.push(`${field} = ?`);
        values.push(slugValue);
      } else {
        updateFields.push(`${field} = ?`);
        values.push(updates[field]);
      }
    }
  }

  if (updateFields.length === 0) {
    return room;
  }

  values.push(room.id);

  const stmt = db.prepare(
    `UPDATE rooms SET ${updateFields.join(', ')} WHERE id = ?`
  );
  stmt.run(...values);

  return getRoomById(room.id);
}

/**
 * List rooms by tenant ID
 * @param {number} tenant_id - Tenant ID
 * @returns {array} Array of room objects
 */
export function listRoomsByTenant(tenant_id) {
  const db = getDatabase();
  const stmt = db.prepare(
    'SELECT id, tenant_id, name, slug, created_at FROM rooms WHERE tenant_id = ? ORDER BY created_at DESC'
  );
  return stmt.all(tenant_id);
}

/**
 * Delete room by slug
 * @param {string} slug - Room slug
 * @returns {boolean} True if deleted, false otherwise
 */
export function deleteRoom(slug) {
  const db = getDatabase();

  // Get room first to get its ID
  const room = getRoomBySlug(slug);
  if (!room) {
    return false;
  }

  // Delete related rows first (some legacy FKs are non-cascading).
  const deleteTxn = db.transaction(() => {
    // Publishers table has room_id FK without ON DELETE CASCADE.
    deletePublishersByRoom(room.id);

    // Recordings table has room_id FK without ON DELETE CASCADE.
    db.prepare(`
      DELETE FROM recording_tracks
      WHERE recording_id IN (SELECT id FROM recordings WHERE room_id = ?)
    `).run(room.id);
    db.prepare('DELETE FROM recordings WHERE room_id = ?').run(room.id);

    // Finally delete the room.
    const result = db.prepare('DELETE FROM rooms WHERE slug = ?').run(slug);
    return result.changes > 0;
  });

  return deleteTxn();
}

export default {
  createRoom,
  getRoomById,
  getRoomBySlug,
  updateRoom,
  listRoomsByTenant,
  deleteRoom
};
