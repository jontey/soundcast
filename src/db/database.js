import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let db = null;

/**
 * Initialize the SQLite database connection and create tables
 */
export function initDatabase(dbPath = './soundcast.db') {
  if (db) {
    return db;
  }

  // Create database connection
  db = new Database(dbPath);

  // Enable foreign keys
  db.pragma('foreign_keys = ON');

  // Read and execute schema
  const schemaPath = join(__dirname, 'schema.sql');
  const schema = readFileSync(schemaPath, 'utf8');

  // Execute schema (split by semicolons and execute each statement)
  const statements = schema.split(';').filter(stmt => stmt.trim());
  for (const statement of statements) {
    if (statement.trim()) {
      db.exec(statement);
    }
  }

  console.log('Database initialized successfully');
  return db;
}

/**
 * Get the database instance
 */
export function getDatabase() {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

/**
 * Close the database connection
 */
export function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}

export default {
  initDatabase,
  getDatabase,
  closeDatabase
};
