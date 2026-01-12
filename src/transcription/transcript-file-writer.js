import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

const appendFile = promisify(fs.appendFile);
const writeFile = promisify(fs.writeFile);
const mkdir = promisify(fs.mkdir);

/**
 * Format timestamp for different subtitle formats
 * @param {number} seconds - Timestamp in seconds
 * @param {string} format - Format type ('srt', 'vtt', or 'txt')
 * @returns {string} Formatted timestamp
 */
function formatTimestamp(seconds, format) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const millis = Math.floor((seconds % 1) * 1000);

  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');
  const mmm = String(millis).padStart(3, '0');

  if (format === 'srt') {
    return `${hh}:${mm}:${ss},${mmm}`;
  } else {
    return `${hh}:${mm}:${ss}.${mmm}`;
  }
}

/**
 * Sanitize name for filename
 * @param {string} name - Name to sanitize
 * @returns {string} Sanitized name
 */
function sanitizeName(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * TranscriptFileWriter - Manages file I/O for transcript formats
 * Writes transcription segments to TXT, SRT, VTT, and JSON formats in real-time
 */
export class TranscriptFileWriter {
  constructor(config) {
    this.recordingId = config.recordingId;
    this.producerId = config.producerId;
    this.producerName = config.producerName;
    this.channelName = config.channelName;
    this.language = config.language;
    this.baseDir = config.baseDir;
    this.baseFilename = config.baseFilename;

    // File paths
    this.txtPath = path.join(this.baseDir, `${this.baseFilename}.txt`);
    this.srtPath = path.join(this.baseDir, `${this.baseFilename}.srt`);
    this.vttPath = path.join(this.baseDir, `${this.baseFilename}.vtt`);
    this.jsonPath = path.join(this.baseDir, `${this.baseFilename}.json`);

    // State
    this.srtSequence = 1;
    this.segments = [];
    this.isInitialized = false;
    this.isClosed = false;
    this.startedAt = null;
    this.stoppedAt = null;
  }

  /**
   * Initialize file writer - create directory and write headers
   */
  async initialize() {
    if (this.isInitialized) return;

    try {
      // Create directory if it doesn't exist
      await mkdir(this.baseDir, { recursive: true });

      // Write VTT header
      await writeFile(this.vttPath, 'WEBVTT\n\n');

      this.startedAt = new Date().toISOString();
      this.isInitialized = true;

      console.log(`[FileWriter] Initialized for ${this.producerName}`);
      console.log(`[FileWriter] Files: ${this.baseFilename}.{txt,srt,vtt,json}`);
    } catch (err) {
      console.error(`[FileWriter] Initialization error: ${err.message}`);
      throw err;
    }
  }

  /**
   * Append a transcription segment to all formats
   * @param {object} segment - Segment to append
   * @param {number} segment.id - Transcript ID
   * @param {string} segment.text - Transcribed text
   * @param {number} segment.timestampStart - Start time in seconds
   * @param {number} segment.timestampEnd - End time in seconds
   * @param {number} segment.confidence - Confidence score
   */
  async appendSegment(segment) {
    if (!this.isInitialized) {
      console.warn('[FileWriter] appendSegment called before initialization');
      return;
    }

    if (this.isClosed) {
      console.warn('[FileWriter] appendSegment called after close');
      return;
    }

    const { id, text, timestampStart, timestampEnd, confidence } = segment;

    // Write to all formats in parallel
    const writes = [];

    // TXT format
    writes.push(
      this.writeTxt(text, timestampStart).catch(err => {
        console.error(`[FileWriter] TXT write failed: ${err.message}`);
      })
    );

    // SRT format
    writes.push(
      this.writeSrt(text, timestampStart, timestampEnd).catch(err => {
        console.error(`[FileWriter] SRT write failed: ${err.message}`);
      })
    );

    // VTT format
    writes.push(
      this.writeVtt(text, timestampStart, timestampEnd).catch(err => {
        console.error(`[FileWriter] VTT write failed: ${err.message}`);
      })
    );

    // JSON (in-memory accumulation)
    this.segments.push({
      id,
      timestampStart,
      timestampEnd,
      text,
      confidence
    });

    // Wait for all writes to complete
    await Promise.all(writes);
  }

  /**
   * Write to TXT format
   */
  async writeTxt(text, timestampStart) {
    const timestamp = formatTimestamp(timestampStart, 'txt');
    const line = `[${timestamp}] ${this.producerName}: ${text}\n`;
    await appendFile(this.txtPath, line);
  }

  /**
   * Write to SRT format
   */
  async writeSrt(text, timestampStart, timestampEnd) {
    const start = formatTimestamp(timestampStart, 'srt');
    const end = formatTimestamp(timestampEnd, 'srt');
    const block = `${this.srtSequence}\n${start} --> ${end}\n${text}\n\n`;
    await appendFile(this.srtPath, block);
    this.srtSequence++;
  }

  /**
   * Write to VTT format
   */
  async writeVtt(text, timestampStart, timestampEnd) {
    const start = formatTimestamp(timestampStart, 'vtt');
    const end = formatTimestamp(timestampEnd, 'vtt');
    const block = `${start} --> ${end}\n<v ${this.producerName}>${text}\n\n`;
    await appendFile(this.vttPath, block);
  }

  /**
   * Finalize and close all files
   */
  async finalize() {
    if (this.isClosed) return;

    try {
      this.stoppedAt = new Date().toISOString();

      // Write JSON file
      const jsonData = {
        recordingId: this.recordingId,
        producerId: this.producerId,
        producerName: this.producerName,
        channelName: this.channelName,
        language: this.language,
        startedAt: this.startedAt,
        stoppedAt: this.stoppedAt,
        segments: this.segments,
        totalSegments: this.segments.length
      };

      await writeFile(this.jsonPath, JSON.stringify(jsonData, null, 2));

      this.isClosed = true;
      console.log(`[FileWriter] Finalized ${this.segments.length} segments for ${this.producerName}`);
    } catch (err) {
      console.error(`[FileWriter] Finalization error: ${err.message}`);
      throw err;
    }
  }

  /**
   * Alias for finalize
   */
  async close() {
    await this.finalize();
  }
}

export default TranscriptFileWriter;
