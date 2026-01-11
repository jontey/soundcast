import { pipeline } from '@xenova/transformers';
import { getDatabase } from '../db/database.js';
import { EventEmitter } from 'events';

// Configuration
const EMBEDDING_ENABLED = process.env.EMBEDDING_ENABLED !== 'false'; // Enabled by default if transcription is enabled
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2';
const EMBEDDING_BATCH_SIZE = parseInt(process.env.EMBEDDING_BATCH_SIZE || '10');
const EMBEDDING_VECTOR_DIMS = 384; // all-MiniLM-L6-v2 produces 384-dimensional vectors

/**
 * Embedding Service - Generates and stores vector embeddings for transcripts
 * Uses sentence-transformers via @xenova/transformers (ONNX runtime)
 */
class EmbeddingService extends EventEmitter {
  constructor() {
    super();
    this.model = null;
    this.queue = [];
    this.processing = false;
    this.batchSize = EMBEDDING_BATCH_SIZE;
    this.initialized = false;
    this.initializationPromise = null;
    this.stats = {
      totalProcessed: 0,
      totalErrors: 0,
      queuePeak: 0
    };
  }

  /**
   * Initialize the embedding model
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this.initialized) {
      return;
    }

    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    if (!EMBEDDING_ENABLED) {
      console.log('[Embedder] Embedding service disabled');
      return;
    }

    this.initializationPromise = (async () => {
      try {
        console.log(`[Embedder] Loading embedding model: ${EMBEDDING_MODEL}`);
        console.log('[Embedder] This may take a minute on first run (downloading model)...');

        this.model = await pipeline(
          'feature-extraction',
          EMBEDDING_MODEL,
          {
            quantized: true // Use quantized model for faster inference
          }
        );

        this.initialized = true;
        console.log('[Embedder] Embedding model loaded successfully');
        console.log(`[Embedder] Vector dimensions: ${EMBEDDING_VECTOR_DIMS}`);
        this.emit('ready');
      } catch (err) {
        console.error('[Embedder] Failed to load embedding model:', err.message);
        this.emit('error', err);
        throw err;
      }
    })();

    return this.initializationPromise;
  }

  /**
   * Generate embedding vector for text
   * @param {string} text - Text to embed
   * @returns {Promise<Array<number>>} Embedding vector
   */
  async generateEmbedding(text) {
    if (!this.initialized) {
      await this.initialize();
    }

    if (!EMBEDDING_ENABLED || !this.model) {
      throw new Error('Embedding service not available');
    }

    try {
      const output = await this.model(text, {
        pooling: 'mean',
        normalize: true
      });

      // Convert tensor to array
      const embedding = Array.from(output.data);

      if (embedding.length !== EMBEDDING_VECTOR_DIMS) {
        console.warn(`[Embedder] Expected ${EMBEDDING_VECTOR_DIMS} dimensions, got ${embedding.length}`);
      }

      return embedding;
    } catch (err) {
      console.error('[Embedder] Failed to generate embedding:', err.message);
      throw err;
    }
  }

  /**
   * Add transcript to embedding queue
   * @param {object} segment - Transcript segment
   * @param {number} segment.transcriptId - Transcript ID
   * @param {string} segment.text - Text content
   * @param {number} segment.roomId - Room ID
   */
  enqueue(segment) {
    if (!EMBEDDING_ENABLED) {
      return;
    }

    this.queue.push(segment);

    // Track peak queue size
    if (this.queue.length > this.stats.queuePeak) {
      this.stats.queuePeak = this.queue.length;
    }

    // Log warning if queue is getting large
    if (this.queue.length > 100) {
      console.warn(`[Embedder] Queue size is large: ${this.queue.length} items`);
    }

    // Start processing if not already running
    this.processQueue();
  }

  /**
   * Process queued transcripts
   * @returns {Promise<void>}
   */
  async processQueue() {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    // Ensure model is initialized
    if (!this.initialized) {
      try {
        await this.initialize();
      } catch (err) {
        console.error('[Embedder] Cannot process queue: model initialization failed');
        return;
      }
    }

    this.processing = true;

    while (this.queue.length > 0) {
      // Process in batches
      const batch = this.queue.splice(0, this.batchSize);

      for (const segment of batch) {
        try {
          // Generate embedding
          const embedding = await this.generateEmbedding(segment.text);

          // Save to database
          this.saveEmbedding(segment.transcriptId, embedding, segment.roomId);

          this.stats.totalProcessed++;

          this.emit('embedded', {
            transcriptId: segment.transcriptId,
            dimensions: embedding.length
          });
        } catch (err) {
          console.error(`[Embedder] Error processing transcript ${segment.transcriptId}: ${err.message}`);
          this.stats.totalErrors++;
          this.emit('error', err);
        }
      }

      // Small delay between batches to avoid blocking
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    this.processing = false;

    // Emit idle event
    this.emit('idle');
  }

  /**
   * Save embedding to database
   * Note: This will use SQLite-vss in Step 5. For now, we store in JSON format.
   * @param {number} transcriptId - Transcript ID
   * @param {Array<number>} embedding - Embedding vector
   * @param {number} roomId - Room ID
   */
  saveEmbedding(transcriptId, embedding, roomId) {
    try {
      const db = getDatabase();

      // Check if SQLite-vss is available (will be set up in Step 5)
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='transcript_embeddings'").all();

      if (tables.length > 0) {
        // SQLite-vss virtual table exists
        this.saveToVss(transcriptId, embedding, roomId);
      } else {
        // Fallback: store in embedding_metadata as JSON
        this.saveToMetadata(transcriptId, embedding, roomId);
      }
    } catch (err) {
      console.error(`[Embedder] Failed to save embedding: ${err.message}`);
      throw err;
    }
  }

  /**
   * Save to SQLite-vss virtual table
   * @param {number} transcriptId - Transcript ID
   * @param {Array<number>} embedding - Embedding vector
   * @param {number} roomId - Room ID
   */
  saveToVss(transcriptId, embedding, roomId) {
    const db = getDatabase();

    // Convert to Float32Array for sqlite-vec
    const floatArray = new Float32Array(embedding);
    const buffer = Buffer.from(floatArray.buffer);

    // Check if embedding already exists for this transcript
    const existing = db.prepare(`
      SELECT id FROM embedding_metadata WHERE transcript_id = ?
    `).get(transcriptId);

    let vectorRowid;

    if (existing) {
      // Update existing embedding
      db.prepare(`
        UPDATE transcript_embeddings SET embedding = ? WHERE rowid = ?
      `).run(buffer, existing.id);
      vectorRowid = existing.id;
      console.log(`[Embedder] Updated embedding for transcript ${transcriptId} (vector rowid: ${vectorRowid})`);
    } else {
      // Insert new embedding into vec0 virtual table (auto-assign rowid)
      const stmt = db.prepare(`
        INSERT INTO transcript_embeddings (embedding)
        VALUES (?)
      `);
      const info = stmt.run(buffer);
      vectorRowid = info.lastInsertRowid;

      // Insert metadata with matching id (NOT auto-increment, manually set to match vector rowid)
      const metaStmt = db.prepare(`
        INSERT INTO embedding_metadata (id, transcript_id, room_id)
        VALUES (?, ?, ?)
      `);
      metaStmt.run(vectorRowid, transcriptId, roomId);

      console.log(`[Embedder] Saved embedding for transcript ${transcriptId} to VSS (vector rowid: ${vectorRowid})`);
    }
  }


  /**
   * Get embedding by transcript ID
   * @param {number} transcriptId - Transcript ID
   * @returns {Array<number>|null} Embedding vector or null
   */
  getEmbedding(transcriptId) {
    const db = getDatabase();

    try {
      // Try VSS table first
      const vssStmt = db.prepare(`
        SELECT embedding FROM transcript_embeddings WHERE transcript_id = ?
      `);
      const vssResult = vssStmt.get(transcriptId);

      if (vssResult) {
        return JSON.parse(vssResult.embedding);
      }

      // Fallback to metadata
      const metaStmt = db.prepare(`
        SELECT embedding_vector FROM embedding_metadata WHERE transcript_id = ?
      `);
      const metaResult = metaStmt.get(transcriptId);

      if (metaResult && metaResult.embedding_vector) {
        return JSON.parse(metaResult.embedding_vector);
      }

      return null;
    } catch (err) {
      console.error(`[Embedder] Failed to get embedding: ${err.message}`);
      return null;
    }
  }

  /**
   * Get queue status
   * @returns {object} Queue stats
   */
  getStatus() {
    return {
      enabled: EMBEDDING_ENABLED,
      initialized: this.initialized,
      processing: this.processing,
      queueSize: this.queue.length,
      stats: {
        totalProcessed: this.stats.totalProcessed,
        totalErrors: this.stats.totalErrors,
        queuePeak: this.stats.queuePeak
      }
    };
  }

  /**
   * Clear the queue (for testing/shutdown)
   */
  clearQueue() {
    this.queue = [];
  }

  /**
   * Shutdown the service
   */
  async shutdown() {
    console.log('[Embedder] Shutting down...');

    // Process remaining items
    if (this.queue.length > 0) {
      console.log(`[Embedder] Processing ${this.queue.length} remaining items...`);
      await this.processQueue();
    }

    this.model = null;
    this.initialized = false;
    console.log('[Embedder] Shutdown complete');
  }
}

// Singleton instance
export const embeddingService = new EmbeddingService();

// Auto-initialize on import if enabled
if (EMBEDDING_ENABLED) {
  embeddingService.initialize().catch(err => {
    console.error('[Embedder] Auto-initialization failed:', err.message);
  });
}

export default embeddingService;
