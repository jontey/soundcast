import { EventEmitter } from 'events';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

// Import native addon
let whisperAddon;
try {
  whisperAddon = require('./build/Release/whisper_addon.node');
} catch (err) {
  console.error('[WhisperBinding] Failed to load native addon:', err.message);
  console.error('[WhisperBinding] Run: cd src/native && npm install && npm run build');
  process.exit(1);
}

const { WhisperSession: NativeWhisperSession } = whisperAddon;

/**
 * JavaScript wrapper for the native Whisper addon
 * Provides a clean Promise-based API with EventEmitter for streaming
 */
export class WhisperTranscriber extends EventEmitter {
  constructor(modelPath, options = {}) {
    super();

    this.modelPath = modelPath;
    this.options = {
      language: options.language || 'en',
      threads: options.threads || 4,
      ...options
    };

    this.session = new NativeWhisperSession(modelPath);
    this.loaded = false;
  }

  /**
   * Load the Whisper model
   * @returns {Promise<boolean>}
   */
  async loadModel() {
    try {
      this.loaded = this.session.loadModel();
      if (this.loaded) {
        this.emit('modelLoaded', { modelPath: this.modelPath });
      }
      return this.loaded;
    } catch (err) {
      this.emit('error', err);
      throw err;
    }
  }

  /**
   * Transcribe audio buffer
   * @param {Buffer|Float32Array} audioData - Audio samples (16kHz, mono, float32)
   * @returns {Promise<Array>} - Array of transcription segments
   */
  async transcribe(audioData) {
    if (!this.loaded) {
      throw new Error('Model not loaded. Call loadModel() first.');
    }

    try {
      // Convert to Float32Array if needed
      let floatBuffer;
      if (audioData instanceof Buffer) {
        floatBuffer = new Float32Array(audioData.buffer, audioData.byteOffset, audioData.byteLength / 4);
      } else if (audioData instanceof Float32Array) {
        floatBuffer = audioData;
      } else {
        throw new TypeError('audioData must be Buffer or Float32Array');
      }

      // Convert Float32Array to Node.js Buffer for N-API
      const nodeBuffer = Buffer.from(floatBuffer.buffer, floatBuffer.byteOffset, floatBuffer.byteLength);

      // Call native transcription
      const segments = this.session.transcribe(nodeBuffer);

      this.emit('transcription', { segments });

      return segments;
    } catch (err) {
      this.emit('error', err);
      throw err;
    }
  }

  /**
   * Create streaming transcription session
   * Returns an EventEmitter that emits 'segment' events
   * @returns {StreamingSession}
   */
  createStream() {
    if (!this.loaded) {
      throw new Error('Model not loaded. Call loadModel() first.');
    }

    return new StreamingSession(this);
  }

  /**
   * Destroy the session and free resources
   */
  destroy() {
    if (this.session) {
      this.session.destroy();
      this.session = null;
      this.loaded = false;
      this.emit('destroyed');
    }
  }
}

/**
 * Streaming transcription session
 * For Phase 3 implementation
 */
class StreamingSession extends EventEmitter {
  constructor(transcriber) {
    super();
    this.transcriber = transcriber;
    this.audioBuffer = [];
    this.sampleRate = 16000;
    this.chunkSize = 16000 * 3; // 3 seconds
  }

  /**
   * Write audio chunk to stream
   * @param {Buffer} chunk - Audio data
   */
  write(chunk) {
    // Convert to Float32Array
    const floatData = new Float32Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 4);

    // Add to buffer
    this.audioBuffer.push(...floatData);

    // Process when we have enough samples
    if (this.audioBuffer.length >= this.chunkSize) {
      this._processChunk();
    }
  }

  async _processChunk() {
    const chunk = new Float32Array(this.audioBuffer.splice(0, this.chunkSize));

    try {
      const segments = await this.transcriber.transcribe(chunk);

      for (const segment of segments) {
        this.emit('segment', segment);
      }
    } catch (err) {
      this.emit('error', err);
    }
  }

  /**
   * Flush remaining audio and close stream
   */
  async end() {
    if (this.audioBuffer.length > 0) {
      await this._processChunk();
    }
    this.emit('end');
  }
}

export default {
  WhisperTranscriber
};
