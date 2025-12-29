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
 * @param {boolean} roomData.is_local_only - Is local only flag
 * @param {string} roomData.sfu_url - SFU WebSocket URL
 * @param {string} roomData.coturn_config_json - COTURN config JSON string
 * @returns {object} Created room
 */
export function createRoom({ tenant_id, name, slug, is_local_only, sfu_url, coturn_config_json }) {
  const db = getDatabase();

  // Validate coturn_config_json is valid JSON
  try {
    JSON.parse(coturn_config_json);
  } catch (e) {
    throw new Error('coturn_config_json must be valid JSON');
  }

  // First insert without slug to get the ID
  const stmt = db.prepare(
    'INSERT INTO rooms (tenant_id, name, slug, is_local_only, sfu_url, coturn_config_json) VALUES (?, ?, ?, ?, ?, ?)'
  );

  // Temporary slug (will be updated)
  const tempSlug = `temp-${Date.now()}`;

  const result = stmt.run(
    tenant_id,
    name,
    tempSlug,
    is_local_only ? 1 : 0,
    sfu_url,
    coturn_config_json
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
    'SELECT id, tenant_id, name, slug, is_local_only, sfu_url, coturn_config_json, created_at FROM rooms WHERE id = ?'
  );
  const room = stmt.get(id);
  if (room) {
    room.is_local_only = Boolean(room.is_local_only);
  }
  return room;
}

/**
 * Get room by slug
 * @param {string} slug - Room slug
 * @returns {object|null} Room object or null
 */
export function getRoomBySlug(slug) {
  const db = getDatabase();
  const stmt = db.prepare(
    'SELECT id, tenant_id, name, slug, is_local_only, sfu_url, coturn_config_json, created_at FROM rooms WHERE slug = ?'
  );
  const room = stmt.get(slug);
  if (room) {
    room.is_local_only = Boolean(room.is_local_only);
  }
  return room;
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

  const allowedFields = ['name', 'slug', 'is_local_only', 'sfu_url', 'coturn_config_json'];
  const updateFields = [];
  const values = [];

  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      if (field === 'coturn_config_json') {
        // Validate JSON
        try {
          JSON.parse(updates[field]);
        } catch (e) {
          throw new Error('coturn_config_json must be valid JSON');
        }
      }
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
        values.push(field === 'is_local_only' ? (updates[field] ? 1 : 0) : updates[field]);
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
    'SELECT id, tenant_id, name, slug, is_local_only, sfu_url, coturn_config_json, created_at FROM rooms WHERE tenant_id = ? ORDER BY created_at DESC'
  );
  const rooms = stmt.all(tenant_id);
  return rooms.map(room => ({
    ...room,
    is_local_only: Boolean(room.is_local_only)
  }));
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

  // Delete related publishers first
  deletePublishersByRoom(room.id);

  // Now delete the room
  const stmt = db.prepare('DELETE FROM rooms WHERE slug = ?');
  const result = stmt.run(slug);
  return result.changes > 0;
}

export default {
  createRoom,
  getRoomById,
  getRoomBySlug,
  updateRoom,
  listRoomsByTenant,
  deleteRoom
};
