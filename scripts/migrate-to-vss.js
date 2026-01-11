#!/usr/bin/env node

/**
 * Migration script: Convert JSON embeddings to sqlite-vec format
 *
 * This script migrates existing embeddings from the JSON fallback storage
 * (embedding_metadata.embedding_vector) to the new sqlite-vec virtual table
 * (transcript_embeddings).
 *
 * Run: node scripts/migrate-to-vss.js
 */

import { initDatabase, getDatabase } from '../src/db/database.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('🔄 Starting migration to sqlite-vec...\n');

// Initialize database (will load sqlite-vec extension)
const dbPath = process.env.DB_PATH || join(__dirname, '../soundcast.db');
console.log(`📂 Database path: ${dbPath}\n`);

try {
  initDatabase(dbPath);
} catch (err) {
  console.error('❌ Failed to initialize database:');
  console.error(err.message);
  console.error('\nMake sure sqlite-vec extension is installed:');
  console.error('  chmod +x scripts/setup-sqlite-vec.sh && ./scripts/setup-sqlite-vec.sh');
  process.exit(1);
}

const db = getDatabase();

// Check if embedding_vector column exists (old fallback storage)
let hasOldColumn = false;
try {
  const tableInfo = db.prepare("PRAGMA table_info(embedding_metadata)").all();
  hasOldColumn = tableInfo.some(col => col.name === 'embedding_vector');
} catch (err) {
  console.error('❌ Failed to check table structure:', err.message);
  process.exit(1);
}

if (!hasOldColumn) {
  console.log('ℹ️  No old embedding_vector column found.');
  console.log('✅ Database is already using sqlite-vec or has no embeddings yet.');
  process.exit(0);
}

// Count old embeddings
const oldEmbeddings = db.prepare(`
  SELECT COUNT(*) as count
  FROM embedding_metadata
  WHERE embedding_vector IS NOT NULL
`).get();

if (oldEmbeddings.count === 0) {
  console.log('ℹ️  No JSON embeddings found to migrate.');
  console.log('✅ Database is ready for sqlite-vec.');
  process.exit(0);
}

console.log(`📊 Found ${oldEmbeddings.count} embeddings to migrate\n`);

// Migrate embeddings
console.log('🔄 Migrating embeddings to sqlite-vec...');

let migrated = 0;
let failed = 0;
let skipped = 0;

try {
  // Get all embeddings with JSON data
  const rows = db.prepare(`
    SELECT transcript_id, embedding_vector
    FROM embedding_metadata
    WHERE embedding_vector IS NOT NULL
    ORDER BY transcript_id
  `).all();

  // Prepare insert statement for vec0
  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO transcript_embeddings (rowid, embedding)
    VALUES (?, ?)
  `);

  // Migrate each embedding
  for (const row of rows) {
    try {
      // Parse JSON embedding
      const embedding = JSON.parse(row.embedding_vector);

      // Validate dimensions
      if (!Array.isArray(embedding) || embedding.length !== 384) {
        console.warn(`⚠️  Skipping transcript ${row.transcript_id}: Invalid dimensions (expected 384, got ${embedding.length})`);
        skipped++;
        continue;
      }

      // Convert to Float32Array (required by sqlite-vec)
      const floatArray = new Float32Array(embedding);

      // Insert into vec0 table
      // rowid = transcript_id for easy lookups
      insertStmt.run(row.transcript_id, floatArray);

      migrated++;

      // Progress indicator
      if (migrated % 100 === 0) {
        process.stdout.write(`\r✅ Migrated: ${migrated}/${oldEmbeddings.count}`);
      }
    } catch (err) {
      console.error(`\n❌ Failed to migrate transcript ${row.transcript_id}:`, err.message);
      failed++;
    }
  }

  process.stdout.write(`\r✅ Migrated: ${migrated}/${oldEmbeddings.count}\n`);

  if (skipped > 0) {
    console.log(`⚠️  Skipped: ${skipped} (invalid dimensions)`);
  }

  if (failed > 0) {
    console.log(`❌ Failed: ${failed}`);
  }

} catch (err) {
  console.error('\n❌ Migration failed:', err.message);
  console.error(err.stack);
  process.exit(1);
}

// Verify migration
console.log('\n🔍 Verifying migration...');

try {
  const vssCount = db.prepare('SELECT COUNT(*) as count FROM transcript_embeddings').get();
  console.log(`✅ Vector table contains: ${vssCount.count} embeddings`);

  if (vssCount.count !== migrated) {
    console.warn(`⚠️  Warning: Expected ${migrated} but found ${vssCount.count}`);
  }
} catch (err) {
  console.error('❌ Verification failed:', err.message);
}

// Optional: Clean up old JSON column
console.log('\n🧹 Cleanup options:');
console.log('   To remove old embedding_vector column (OPTIONAL):');
console.log('   1. Backup database: cp soundcast.db soundcast.db.backup');
console.log('   2. Run: sqlite3 soundcast.db "ALTER TABLE embedding_metadata DROP COLUMN embedding_vector;"');
console.log('   Note: This step is optional. The column can remain for rollback safety.');

console.log('\n🎉 Migration complete!');
console.log(`\n📊 Summary:`);
console.log(`   - Migrated: ${migrated}`);
console.log(`   - Skipped:  ${skipped}`);
console.log(`   - Failed:   ${failed}`);
console.log(`   - Total:    ${oldEmbeddings.count}`);
