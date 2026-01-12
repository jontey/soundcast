import { EventEmitter } from 'events';
import { createWriteStream, existsSync, statSync, unlinkSync, renameSync } from 'fs';
import { mkdir } from 'fs/promises';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import { createHash } from 'crypto';

/**
 * Available Whisper models from Hugging Face
 */
export const AVAILABLE_MODELS = {
  'tiny.en': {
    name: 'tiny.en',
    size: 75,
    description: 'Tiny English-only model (75MB)',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin',
    languages: ['en']
  },
  'tiny': {
    name: 'tiny',
    size: 75,
    description: 'Tiny multilingual model (75MB)',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin',
    languages: ['multilingual']
  },
  'base.en': {
    name: 'base.en',
    size: 142,
    description: 'Base English-only model (142MB)',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
    languages: ['en']
  },
  'base': {
    name: 'base',
    size: 142,
    description: 'Base multilingual model (142MB)',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
    languages: ['multilingual']
  },
  'small.en': {
    name: 'small.en',
    size: 466,
    description: 'Small English-only model (466MB)',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin',
    languages: ['en']
  },
  'small': {
    name: 'small',
    size: 466,
    description: 'Small multilingual model (466MB)',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
    languages: ['multilingual']
  },
  'medium.en': {
    name: 'medium.en',
    size: 1500,
    description: 'Medium English-only model (1.5GB)',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.en.bin',
    languages: ['en']
  },
  'medium': {
    name: 'medium',
    size: 1500,
    description: 'Medium multilingual model (1.5GB)',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin',
    languages: ['multilingual']
  },
  'large-v3': {
    name: 'large-v3',
    size: 3100,
    description: 'Large-v3 multilingual model (3.1GB)',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin',
    languages: ['multilingual']
  }
};

const WHISPER_MODEL_DIR = process.env.WHISPER_MODEL_DIR || './models';

/**
 * Model Download Manager
 */
export class ModelDownloader extends EventEmitter {
  constructor() {
    super();
    this.activeDownloads = new Map(); // downloadId -> DownloadSession
    this.downloadIdCounter = 1;
  }

  /**
   * Start downloading a model
   * @param {string} modelName - Model name (e.g., 'base.en')
   * @returns {string} Download ID
   */
  async startDownload(modelName) {
    const model = AVAILABLE_MODELS[modelName];
    if (!model) {
      throw new Error(`Unknown model: ${modelName}`);
    }

    const downloadId = `download-${this.downloadIdCounter++}`;
    const fileName = `ggml-${modelName}.bin`;
    const filePath = join(WHISPER_MODEL_DIR, fileName);
    const tempPath = `${filePath}.tmp`;

    // Check if already downloaded
    if (existsSync(filePath)) {
      const stats = statSync(filePath);
      // Rough validation: file size should be close to expected
      if (stats.size > model.size * 1024 * 1024 * 0.9) {
        throw new Error('Model already downloaded');
      }
    }

    // Ensure models directory exists
    await mkdir(WHISPER_MODEL_DIR, { recursive: true });

    const session = new DownloadSession(downloadId, model, filePath, tempPath);
    this.activeDownloads.set(downloadId, session);

    // Forward events
    session.on('progress', (data) => {
      this.emit('progress', { downloadId, ...data });
    });

    session.on('complete', (data) => {
      this.activeDownloads.delete(downloadId);
      this.emit('complete', { downloadId, ...data });
    });

    session.on('error', (error) => {
      this.activeDownloads.delete(downloadId);
      this.emit('error', { downloadId, error });
    });

    // Start download
    session.start().catch(err => {
      console.error(`[ModelDownloader] Download ${downloadId} failed:`, err.message);
    });

    return downloadId;
  }

  /**
   * Get download progress
   * @param {string} downloadId
   * @returns {object|null} Progress info
   */
  getProgress(downloadId) {
    const session = this.activeDownloads.get(downloadId);
    if (!session) return null;

    return session.getProgress();
  }

  /**
   * Cancel a download
   * @param {string} downloadId
   */
  cancelDownload(downloadId) {
    const session = this.activeDownloads.get(downloadId);
    if (session) {
      session.cancel();
      this.activeDownloads.delete(downloadId);
    }
  }

  /**
   * List all active downloads
   * @returns {Array}
   */
  listActiveDownloads() {
    return Array.from(this.activeDownloads.entries()).map(([id, session]) => ({
      downloadId: id,
      ...session.getProgress()
    }));
  }

  /**
   * List installed models
   * @returns {Array}
   */
  listInstalledModels() {
    if (!existsSync(WHISPER_MODEL_DIR)) {
      return [];
    }

    const models = [];
    for (const [key, model] of Object.entries(AVAILABLE_MODELS)) {
      const fileName = `ggml-${model.name}.bin`;
      const filePath = join(WHISPER_MODEL_DIR, fileName);

      if (existsSync(filePath)) {
        const stats = statSync(filePath);
        models.push({
          name: model.name,
          fileName,
          size: stats.size,
          sizeFormatted: this.formatBytes(stats.size),
          path: filePath,
          installedAt: stats.mtime
        });
      }
    }

    return models;
  }

  /**
   * Delete an installed model
   * @param {string} fileName - File name (e.g., 'ggml-base.en.bin')
   */
  deleteModel(fileName) {
    const filePath = join(WHISPER_MODEL_DIR, fileName);

    if (!existsSync(filePath)) {
      throw new Error('Model not found');
    }

    // Safety check: only delete .bin files
    if (!fileName.endsWith('.bin')) {
      throw new Error('Invalid file name');
    }

    unlinkSync(filePath);
    console.log(`[ModelDownloader] Deleted model: ${fileName}`);
  }

  /**
   * Format bytes to human-readable string
   * @private
   */
  formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }
}

/**
 * Download Session - manages a single model download
 */
class DownloadSession extends EventEmitter {
  constructor(downloadId, model, filePath, tempPath) {
    super();
    this.downloadId = downloadId;
    this.model = model;
    this.filePath = filePath;
    this.tempPath = tempPath;

    this.totalBytes = model.size * 1024 * 1024;
    this.downloadedBytes = 0;
    this.startTime = Date.now();
    this.cancelled = false;
    this.abortController = new AbortController();
  }

  /**
   * Start the download
   */
  async start() {
    try {
      // Check for existing partial download
      let startByte = 0;
      if (existsSync(this.tempPath)) {
        const stats = statSync(this.tempPath);
        startByte = stats.size;
        this.downloadedBytes = startByte;
        console.log(`[ModelDownloader] Resuming download from ${startByte} bytes`);
      }

      // Fetch with Range header for resumable download
      const headers = {};
      if (startByte > 0) {
        headers['Range'] = `bytes=${startByte}-`;
      }

      const response = await fetch(this.model.url, {
        headers,
        signal: this.abortController.signal
      });

      if (!response.ok && response.status !== 206) {
        throw new Error(`HTTP error ${response.status}`);
      }

      // Get total size from Content-Length or Content-Range
      const contentLength = response.headers.get('content-length');
      const contentRange = response.headers.get('content-range');

      if (contentRange) {
        // Format: "bytes start-end/total"
        const match = contentRange.match(/bytes \d+-\d+\/(\d+)/);
        if (match) {
          this.totalBytes = parseInt(match[1]);
        }
      } else if (contentLength) {
        this.totalBytes = startByte + parseInt(contentLength);
      }

      // Stream to file
      const fileStream = createWriteStream(this.tempPath, {
        flags: startByte > 0 ? 'a' : 'w'
      });

      const reader = response.body.getReader();
      let lastProgressUpdate = Date.now();

      while (true) {
        const { done, value } = await reader.read();

        if (done || this.cancelled) {
          break;
        }

        fileStream.write(value);
        this.downloadedBytes += value.length;

        // Emit progress every 500ms
        const now = Date.now();
        if (now - lastProgressUpdate > 500) {
          this.emitProgress();
          lastProgressUpdate = now;
        }
      }

      fileStream.end();

      if (this.cancelled) {
        throw new Error('Download cancelled');
      }

      // Move temp file to final location
      renameSync(this.tempPath, this.filePath);

      this.emit('complete', {
        filePath: this.filePath,
        size: this.downloadedBytes,
        duration: Date.now() - this.startTime
      });

      console.log(`[ModelDownloader] Download complete: ${this.model.name}`);
    } catch (err) {
      // Cleanup on error (but keep temp file for resume)
      if (err.name === 'AbortError' || this.cancelled) {
        console.log(`[ModelDownloader] Download cancelled: ${this.model.name}`);
      } else {
        console.error(`[ModelDownloader] Download error: ${err.message}`);
      }
      this.emit('error', err);
    }
  }

  /**
   * Emit progress update
   * @private
   */
  emitProgress() {
    const progress = {
      modelName: this.model.name,
      downloadedBytes: this.downloadedBytes,
      totalBytes: this.totalBytes,
      percentage: ((this.downloadedBytes / this.totalBytes) * 100).toFixed(1),
      speed: this.calculateSpeed(),
      eta: this.calculateEta()
    };

    this.emit('progress', progress);
  }

  /**
   * Calculate download speed (bytes/sec)
   * @private
   */
  calculateSpeed() {
    const elapsedSeconds = (Date.now() - this.startTime) / 1000;
    if (elapsedSeconds === 0) return 0;
    return Math.floor(this.downloadedBytes / elapsedSeconds);
  }

  /**
   * Calculate ETA in seconds
   * @private
   */
  calculateEta() {
    const speed = this.calculateSpeed();
    if (speed === 0) return null;

    const remainingBytes = this.totalBytes - this.downloadedBytes;
    return Math.floor(remainingBytes / speed);
  }

  /**
   * Get current progress
   */
  getProgress() {
    return {
      modelName: this.model.name,
      downloadedBytes: this.downloadedBytes,
      totalBytes: this.totalBytes,
      percentage: ((this.downloadedBytes / this.totalBytes) * 100).toFixed(1),
      speed: this.calculateSpeed(),
      eta: this.calculateEta(),
      status: this.cancelled ? 'cancelled' : 'downloading'
    };
  }

  /**
   * Cancel the download
   */
  cancel() {
    this.cancelled = true;
    this.abortController.abort();
  }
}

// Singleton instance
export const modelDownloader = new ModelDownloader();

export default modelDownloader;
