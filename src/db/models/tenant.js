import { getDatabase } from '../database.js';
import bcrypt from 'bcrypt';

const SALT_ROUNDS = 10;

/**
 * Create a new tenant
 * @param {string} name - Tenant name
 * @param {string} apiKey - Plain text API key
 * @returns {object} Created tenant (without api_key_hash)
 */
export function createTenant(name, apiKey) {
  const db = getDatabase();
  const apiKeyHash = bcrypt.hashSync(apiKey, SALT_ROUNDS);

  const stmt = db.prepare(
    'INSERT INTO tenants (name, api_key_hash) VALUES (?, ?)'
  );

  const result = stmt.run(name, apiKeyHash);

  return {
    id: result.lastInsertRowid,
    name,
    created_at: new Date().toISOString()
  };
}

/**
 * Get tenant by ID
 * @param {number} id - Tenant ID
 * @returns {object|null} Tenant object or null
 */
export function getTenantById(id) {
  const db = getDatabase();
  const stmt = db.prepare('SELECT id, name, created_at FROM tenants WHERE id = ?');
  return stmt.get(id);
}

/**
 * Get tenant by name
 * @param {string} name - Tenant name
 * @returns {object|null} Tenant object or null
 */
export function getTenantByName(name) {
  const db = getDatabase();
  const stmt = db.prepare('SELECT id, name, created_at FROM tenants WHERE name = ?');
  return stmt.get(name);
}

/**
 * Verify tenant API key
 * @param {string} apiKey - Plain text API key
 * @returns {object|null} Tenant object if valid, null otherwise
 */
export function verifyTenantApiKey(apiKey) {
  const db = getDatabase();
  const stmt = db.prepare('SELECT id, name, api_key_hash, created_at FROM tenants');
  const tenants = stmt.all();

  for (const tenant of tenants) {
    if (bcrypt.compareSync(apiKey, tenant.api_key_hash)) {
      // Return tenant without hash
      const { api_key_hash, ...tenantWithoutHash } = tenant;
      return tenantWithoutHash;
    }
  }

  return null;
}

/**
 * List all tenants
 * @returns {array} Array of tenant objects
 */
export function listTenants() {
  const db = getDatabase();
  const stmt = db.prepare('SELECT id, name, created_at FROM tenants ORDER BY created_at DESC');
  return stmt.all();
}

/**
 * Delete tenant by ID
 * @param {number} id - Tenant ID
 * @returns {boolean} True if deleted, false otherwise
 */
export function deleteTenant(id) {
  const db = getDatabase();
  const stmt = db.prepare('DELETE FROM tenants WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

/**
 * Update tenant API key
 * @param {number} id - Tenant ID
 * @param {string} newApiKey - New plain text API key
 * @returns {boolean} True if updated, false otherwise
 */
export function updateTenantApiKey(id, newApiKey) {
  const db = getDatabase();
  const apiKeyHash = bcrypt.hashSync(newApiKey, SALT_ROUNDS);
  const stmt = db.prepare('UPDATE tenants SET api_key_hash = ? WHERE id = ?');
  const result = stmt.run(apiKeyHash, id);
  return result.changes > 0;
}

export default {
  createTenant,
  getTenantById,
  getTenantByName,
  verifyTenantApiKey,
  listTenants,
  deleteTenant,
  updateTenantApiKey
};
