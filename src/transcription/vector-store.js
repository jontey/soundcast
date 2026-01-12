import { getDatabase } from '../db/database.js';
import { embeddingService } from './embedder.js';
import { getTranscriptById } from '../db/models/transcript.js';

/**
 * Vector Store - Handles semantic search using embeddings
 * Supports both SQLite-vss (when available) and fallback text search
 */
class VectorStore {
  constructor() {
    this.db = null;
    this.vssAvailable = false;
  }

  /**
   * Initialize and check for SQLite-vss availability
   */
  initialize() {
    this.db = getDatabase();

    // Check if SQLite-vss virtual table exists
    try {
      const tables = this.db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name='transcript_embeddings'
      `).all();

      this.vssAvailable = tables.length > 0;

      if (this.vssAvailable) {
        console.log('[VectorStore] SQLite-vss available, semantic search enabled');
      } else {
        console.log('[VectorStore] SQLite-vss not available, using fallback text search');
      }
    } catch (err) {
      console.error('[VectorStore] Initialization error:', err.message);
      this.vssAvailable = false;
    }
  }

  /**
   * Search for similar transcripts using semantic similarity
   * @param {string} queryText - Query text
   * @param {number} roomId - Room ID to search within
   * @param {object} options - Search options
   * @param {number} [options.limit=10] - Maximum results
   * @param {number} [options.minScore=0.5] - Minimum similarity score (0-1)
   * @param {string} [options.channelName] - Optional channel filter
   * @returns {Promise<Array>} Search results with similarity scores
   */
  async searchSimilar(queryText, roomId, options = {}) {
    const { limit = 10, minScore = 0.5, channelName } = options;

    if (!this.db) {
      this.initialize();
    }

    // Generate embedding for query (FAIL HARD if embedding generation fails)
    const queryEmbedding = await embeddingService.generateEmbedding(queryText);

    // Use VSS only (FAIL HARD if VSS not available)
    return this.vssSearch(queryEmbedding, roomId, { limit, minScore, channelName });
  }

  /**
   * Vector similarity search using SQLite-vss
   * @private
   */
  vssSearch(queryEmbedding, roomId, options) {
    const { limit, minScore, channelName } = options;

    // Convert query embedding to Float32Array for sqlite-vec
    const floatArray = new Float32Array(queryEmbedding);
    const queryBuffer = Buffer.from(floatArray.buffer);

    // Build query with channel filter
    let query = `
      SELECT
        em.transcript_id as id,
        t.text_content,
        t.producer_name,
        t.channel_name,
        t.timestamp_start,
        t.timestamp_end,
        t.confidence_score,
        t.language,
        vec_distance_L2(ve.embedding, vec_f32(?)) as distance
      FROM embedding_metadata em
      JOIN transcripts t ON t.id = em.transcript_id
      JOIN transcript_embeddings ve ON ve.rowid = em.transcript_id
      WHERE t.room_id = ?
        AND vec_distance_L2(ve.embedding, vec_f32(?)) < ?
    `;

    const params = [queryBuffer, roomId, queryBuffer, 10.0]; // distance threshold

    if (channelName) {
      query += ' AND t.channel_name = ?';
      params.push(channelName);
    }

    query += ' ORDER BY distance ASC LIMIT ?';
    params.push(limit);

    const stmt = this.db.prepare(query);
    const results = stmt.all(...params);

    // Convert distance to similarity and filter by minScore
    return results
      .map(row => ({
        ...row,
        similarity: 1 / (1 + row.distance), // Convert distance to similarity (0-1)
        distance: row.distance
      }))
      .filter(row => row.similarity >= minScore);
  }



  /**
   * Compute cosine similarity between two vectors
   * @param {Array<number>} a - First vector
   * @param {Array<number>} b - Second vector
   * @returns {number} Similarity score (0-1)
   */
  cosineSimilarity(a, b) {
    if (a.length !== b.length) {
      throw new Error('Vectors must have same length');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);

    if (normA === 0 || normB === 0) {
      return 0;
    }

    return dotProduct / (normA * normB);
  }

  /**
   * Get transcripts by time range
   * @param {number} roomId - Room ID
   * @param {number} startTime - Start timestamp (Unix seconds)
   * @param {number} endTime - End timestamp (Unix seconds)
   * @param {string} [channelName] - Optional channel filter
   * @returns {Array} Transcripts in time range
   */
  getTranscriptsByTimeRange(roomId, startTime, endTime, channelName = null) {
    if (!this.db) {
      this.initialize();
    }

    let query = `
      SELECT * FROM transcripts
      WHERE room_id = ?
        AND timestamp_start >= ?
        AND timestamp_end <= ?
    `;

    const params = [roomId, startTime, endTime];

    if (channelName) {
      query += ' AND channel_name = ?';
      params.push(channelName);
    }

    query += ' ORDER BY timestamp_start ASC';

    const stmt = this.db.prepare(query);
    return stmt.all(...params);
  }

  /**
   * Get recent transcripts
   * @param {number} roomId - Room ID
   * @param {number} [minutes=60] - Number of minutes to look back
   * @param {string} [channelName] - Optional channel filter
   * @returns {Array} Recent transcripts
   */
  getRecentTranscripts(roomId, minutes = 60, channelName = null) {
    const cutoffTime = Date.now() / 1000 - (minutes * 60);
    const endTime = Date.now() / 1000;
    return this.getTranscriptsByTimeRange(roomId, cutoffTime, endTime, channelName);
  }

  /**
   * Check if VSS is available
   * @returns {boolean} True if SQLite-vss is available
   */
  isVssAvailable() {
    if (!this.db) {
      this.initialize();
    }
    return this.vssAvailable;
  }
}

// Singleton instance
export const vectorStore = new VectorStore();

export default vectorStore;
