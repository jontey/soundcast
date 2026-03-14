import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, existsSync } from 'fs';

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

  // Create database connection with optional custom native binding
  // (used when running as a packaged executable)
  const dbOptions = {};
  if (process.env.BETTER_SQLITE3_BINDING && existsSync(process.env.BETTER_SQLITE3_BINDING)) {
    dbOptions.nativeBinding = process.env.BETTER_SQLITE3_BINDING;
    console.log('Using custom SQLite binding:', process.env.BETTER_SQLITE3_BINDING);
  }

  db = new Database(dbPath, dbOptions);

  // Load sqlite-vec extension if available.
  const vectorExtensionPath = join(__dirname, '../../lib/vec0.so');
  const vectorExtensionPathDylib = join(__dirname, '../../lib/vec0.dylib');

  // Try both .so (Linux) and .dylib (macOS) extensions
  let extensionLoaded = false;

  if (existsSync(vectorExtensionPath)) {
    try {
      db.loadExtension(vectorExtensionPath);
      extensionLoaded = true;
      console.log('[Database] Vector extension loaded:', vectorExtensionPath);
    } catch (err) {
      console.warn('[Database] Failed to load vector extension from', vectorExtensionPath);
      console.warn('[Database] Error:', err.message);
    }
  } else if (existsSync(vectorExtensionPathDylib)) {
    try {
      db.loadExtension(vectorExtensionPathDylib);
      extensionLoaded = true;
      console.log('[Database] Vector extension loaded:', vectorExtensionPathDylib);
    } catch (err) {
      console.warn('[Database] Failed to load vector extension from', vectorExtensionPathDylib);
      console.warn('[Database] Error:', err.message);
    }
  }

  if (!extensionLoaded) {
    console.warn('[Database] sqlite-vec extension not loaded (continuing without vector search support).');
  }

  // Enable foreign keys
  db.pragma('foreign_keys = ON');

  // Read and execute schema
  // Try multiple locations for schema file (for packaged executable support)
  let schemaPath = join(__dirname, 'schema.sql');
  if (!existsSync(schemaPath)) {
    // When packaged, schema might be next to executable
    const exeDir = dirname(process.execPath);
    schemaPath = join(exeDir, 'schema.sql');
  }
  if (!existsSync(schemaPath)) {
    // Also try current working directory
    schemaPath = join(process.cwd(), 'schema.sql');
  }

  const schema = readFileSync(schemaPath, 'utf8');

  // Execute schema (split by semicolons and execute each statement).
  // vec0 table creation is skipped when sqlite-vec extension is unavailable.
  const statements = schema.split(';').filter(stmt => stmt.trim());
  for (const statement of statements) {
    const trimmed = statement.trim();
    if (!trimmed) continue;

    const isVec0Statement = /CREATE\s+VIRTUAL\s+TABLE\s+IF\s+NOT\s+EXISTS\s+transcript_embeddings\s+USING\s+vec0/i.test(trimmed);
    if (isVec0Statement && !extensionLoaded) {
      console.warn('[Database] Skipping vec0 virtual table creation because sqlite-vec is unavailable.');
      continue;
    }

    db.exec(statement);
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
