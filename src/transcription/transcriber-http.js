import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createTranscript } from '../db/models/transcript.js';
import { embeddingService } from './embedder.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const WHISPER_CPP_PATH = process.env.WHISPER_CPP_PATH || './whisper.cpp/server';
const WHISPER_MODEL_DIR = process.env.WHISPER_MODEL_DIR || './models';
const WHISPER_MODEL_SIZE = process.env.WHISPER_MODEL_SIZE || 'base';
const TRANSCRIPTION_ENABLED = process.env.TRANSCRIPTION_ENABLED === 'true';

// Port allocation for RTP and Whisper HTTP server
const RTP_PORT_MIN = parseInt(process.env.TRANSCRIPTION_RTP_PORT_MIN || '51000');
const RTP_PORT_MAX = parseInt(process.env.TRANSCRIPTION_RTP_PORT_MAX || '51999');

// Dependencies injected from server.js
let router = null;
let channels = null;
let fastify = null;

// Active transcription sessions: producerId -> TranscriptionSession
const activeSessions = new Map();

// Port allocation tracking
const usedRtpPorts = new Set();

/**
 * Initialize the transcriber module
 * @param {object} deps - Dependencies
 * @param {object} deps.router - mediasoup router
 * @param {Map} deps.channels - channels Map
 * @param {object} deps.fastify - fastify instance
 */
export function initTranscriber(deps) {
  router = deps.router;
  channels = deps.channels;
  fastify = deps.fastify;

  if (TRANSCRIPTION_ENABLED) {
    console.log('Transcriber initialized (enabled)');
  } else {
    console.log('Transcriber initialized (disabled)');
  }
}

/**
 * Allocate a free UDP port for RTP
 * @returns {number} Available port
 */
function allocateRtpPort() {
  for (let port = RTP_PORT_MIN; port <= RTP_PORT_MAX; port++) {
    if (!usedRtpPorts.has(port)) {
      usedRtpPorts.add(port);
      return port;
    }
  }
  throw new Error('No available RTP ports for transcription');
}

/**
 * Release a UDP port
 * @param {number} port - Port to release
 */
function releaseRtpPort(port) {
  usedRtpPorts.delete(port);
}

/**
 * Transcription Session - manages transcription for a single producer
 */
class TranscriptionSession extends EventEmitter {
  constructor(roomId, producerId, config) {
    super();
    this.roomId = roomId;
    this.producerId = producerId;
    this.producerName = config.producerName || 'Unknown';
    this.channelName = config.channelName || 'default';
    this.language = config.language || 'en';
    this.roomSlug = config.roomSlug || '';
    this.modelPath = config.modelPath || null;

    // mediasoup components
    this.plainTransport = null;
    this.consumer = null;
    this.rtpPort = null;
    this.sdpPath = null;

    // Whisper components
    this.whisperProcess = null;
    this.whisperPort = null;
    this.whisperReady = false;

    // FFmpeg audio converter (Opus → 16kHz PCM WAV)
    this.audioConverter = null;
    this.audioBuffer = Buffer.alloc(0);
    this.audioChunkCount = 0;

    // Timing
    this.startTime = Date.now();
    this.sessionStartTimestamp = this.startTime / 1000; // Unix timestamp in seconds

    // Error tracking
    this.restartCount = 0;
    this.maxRestarts = 3;
  }

  /**
   * Start the transcription session
   * @param {object} producer - mediasoup producer
   */
  async start(producer) {
    try {
      console.log(`[Transcriber] Starting session for ${this.producerName} (${this.language})`);

      // 1. Allocate RTP port
      this.rtpPort = allocateRtpPort();

      // 2. Create PlainTransport for consuming the producer
      this.plainTransport = await router.createPlainTransport({
        listenIp: { ip: '127.0.0.1', announcedIp: null },
        rtcpMux: true,
        comedia: false
      });

      // 3. Connect the transport
      await this.plainTransport.connect({
        ip: '127.0.0.1',
        port: this.rtpPort
      });

      console.log(`[Transcriber] PlainTransport connected to 127.0.0.1:${this.rtpPort}`);

      // 4. Create consumer on the PlainTransport
      this.consumer = await this.plainTransport.consume({
        producerId: producer.id,
        rtpCapabilities: router.rtpCapabilities,
        paused: false
      });

      // 5. Resume consumer to ensure RTP flows
      if (this.consumer.paused) {
        await this.consumer.resume();
      }

      console.log(`[Transcriber] Consumer created for producer ${this.producerId}`);

      // 6. Start Whisper.cpp server
      await this.startWhisperProcess();

      // 7. Start audio pipeline (RTP → FFmpeg → WAV chunks → Whisper)
      this.startAudioPipeline();

      console.log(`[Transcriber] Session started for ${this.producerName}`);
      return true;
    } catch (err) {
      console.error(`[Transcriber] Failed to start session: ${err.message}`);
      await this.stop();
      throw err;
    }
  }

  /**
   * Start Whisper.cpp server subprocess
   */
  async startWhisperProcess() {
    return new Promise((resolve, reject) => {
      let model;

      // Use provided modelPath if available, otherwise fall back to environment variables
      if (this.modelPath) {
        model = this.modelPath;
      } else {
        const modelPath = path.join(WHISPER_MODEL_DIR, `ggml-${WHISPER_MODEL_SIZE}.bin`);
        const modelEnPath = path.join(WHISPER_MODEL_DIR, `ggml-${WHISPER_MODEL_SIZE}.en.bin`);
        // Use English-only model if available and language is English
        model = (this.language === 'en' && fs.existsSync(modelEnPath)) ? modelEnPath : modelPath;
      }

      if (!fs.existsSync(model)) {
        reject(new Error(`Whisper model not found: ${model}`));
        return;
      }

      console.log(`[Transcriber] Starting Whisper server with model: ${model}`);

      this.whisperProcess = spawn(WHISPER_CPP_PATH, [
        '-m', model,
        '--port', '0', // Auto-assign port
        '--convert',   // Auto-convert audio formats
        '-l', this.language,
        '--print-realtime',
        '--output-json'
      ], {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let portDetected = false;

      this.whisperProcess.stdout.on('data', (data) => {
        const output = data.toString();

        // Detect port number
        if (!portDetected) {
          const portMatch = output.match(/listening on.*:(\d+)/i);
          if (portMatch) {
            this.whisperPort = parseInt(portMatch[1]);
            this.whisperReady = true;
            portDetected = true;
            console.log(`[Transcriber] Whisper server ready on port ${this.whisperPort}`);
            resolve();
          }
        }

        // Parse JSON transcription results
        this.parseWhisperOutput(output);
      });

      this.whisperProcess.stderr.on('data', (data) => {
        const output = data.toString();
        // Only log errors, not debug output
        if (output.includes('error') || output.includes('Error')) {
          console.error(`[Transcriber] Whisper stderr: ${output}`);
        }
      });

      this.whisperProcess.on('error', (err) => {
        console.error(`[Transcriber] Whisper process error: ${err.message}`);
        if (!portDetected) {
          reject(err);
        } else {
          this.handleWhisperCrash();
        }
      });

      this.whisperProcess.on('close', (code) => {
        console.log(`[Transcriber] Whisper process exited with code ${code}`);
        if (portDetected && code !== 0) {
          this.handleWhisperCrash();
        }
      });

      // Timeout after 10 seconds
      setTimeout(() => {
        if (!portDetected) {
          reject(new Error('Whisper server failed to start within 10 seconds'));
        }
      }, 10000);
    });
  }

  /**
   * Start audio pipeline: RTP → FFmpeg → WAV chunks → Whisper
   */
  startAudioPipeline() {
    // Generate SDP for RTP stream
    const sdpContent = this.generateSdp();
    this.sdpPath = path.join('/tmp', `transcription_${this.producerId}.sdp`);
    fs.writeFileSync(this.sdpPath, sdpContent);

    // Spawn FFmpeg to convert Opus (48kHz stereo) → PCM (16kHz mono) for Whisper
    this.audioConverter = spawn('ffmpeg', [
      '-protocol_whitelist', 'file,rtp,udp',
      '-analyzeduration', '5000000',
      '-probesize', '2500000',
      '-f', 'sdp',
      '-i', this.sdpPath,
      // Convert to Whisper-compatible format
      '-ar', '16000',   // 16kHz sample rate
      '-ac', '1',       // Mono
      '-f', 'wav',      // WAV format
      'pipe:1'          // Output to stdout
    ], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    // Buffer WAV audio and send chunks to Whisper
    this.audioConverter.stdout.on('data', (chunk) => {
      this.processAudioChunk(chunk);
    });

    this.audioConverter.stderr.on('data', (data) => {
      const output = data.toString();
      if (output.includes('error') || output.includes('Error')) {
        console.error(`[Transcriber] FFmpeg stderr: ${output}`);
      }
    });

    this.audioConverter.on('error', (err) => {
      console.error(`[Transcriber] FFmpeg error: ${err.message}`);
    });

    this.audioConverter.on('close', (code) => {
      console.log(`[Transcriber] FFmpeg process exited with code ${code}`);
      // Cleanup SDP file
      if (this.sdpPath && fs.existsSync(this.sdpPath)) {
        fs.unlinkSync(this.sdpPath);
      }
    });

    console.log(`[Transcriber] Audio pipeline started`);
  }

  /**
   * Generate SDP for RTP stream (similar to recorder.js)
   */
  generateSdp() {
    const rtpParams = this.consumer.rtpParameters;
    const codec = rtpParams.codecs[0];
    const payloadType = codec.payloadType;
    const ssrc = rtpParams.encodings?.[0]?.ssrc || 0;

    const lines = [
      'v=0',
      'o=- 0 0 IN IP4 127.0.0.1',
      's=Transcription RTP Stream',
      't=0 0',
      `m=audio ${this.rtpPort} RTP/AVP ${payloadType}`,
      'c=IN IP4 127.0.0.1',
      `a=rtpmap:${payloadType} ${codec.mimeType.split('/')[1]}/${codec.clockRate}/${codec.channels || 1}`,
      `a=ssrc:${ssrc}`
    ];

    return lines.join('\r\n') + '\r\n';
  }

  /**
   * Process audio chunk - buffer and send to Whisper in 30s windows
   * @param {Buffer} chunk - Audio chunk from FFmpeg
   */
  async processAudioChunk(chunk) {
    if (!this.whisperReady) return;

    // Accumulate audio chunks
    this.audioBuffer = Buffer.concat([this.audioBuffer, chunk]);

    // Calculate chunk size for 30 seconds of audio
    // 16kHz * 16-bit (2 bytes) * 1 channel * 30 seconds = 960,000 bytes
    // Plus WAV header (44 bytes) ≈ 960,044 bytes
    const CHUNK_SIZE = 960000;

    if (this.audioBuffer.length >= CHUNK_SIZE) {
      // Extract 30s chunk
      const toSend = this.audioBuffer.slice(0, CHUNK_SIZE);

      // Keep 10% overlap (3 seconds) for next chunk
      const overlapSize = Math.floor(CHUNK_SIZE * 0.1);
      this.audioBuffer = this.audioBuffer.slice(CHUNK_SIZE - overlapSize);

      // Send to Whisper
      this.sendToWhisper(toSend);
      this.audioChunkCount++;
    }
  }

  /**
   * Send audio chunk to Whisper HTTP server
   * @param {Buffer} audioData - WAV audio data
   */
  async sendToWhisper(audioData) {
    if (!this.whisperPort || !this.whisperReady) return;

    try {
      const response = await fetch(`http://127.0.0.1:${this.whisperPort}/inference`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream'
        },
        body: audioData
      });

      if (!response.ok) {
        console.error(`[Transcriber] Whisper HTTP error: ${response.status}`);
        return;
      }

      // Response will be streamed via stdout event handlers
    } catch (err) {
      console.error(`[Transcriber] Failed to send audio to Whisper: ${err.message}`);
    }
  }

  /**
   * Parse Whisper output and emit transcription events
   * @param {string} output - Whisper stdout output
   */
  parseWhisperOutput(output) {
    // Try to parse JSON output
    const lines = output.split('\n');

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const result = JSON.parse(line);

        if (result.text && result.text.trim()) {
          const elapsedTime = (Date.now() - this.startTime) / 1000;
          const timestamp = this.sessionStartTimestamp + elapsedTime;

          const segment = {
            producerId: this.producerId,
            producerName: this.producerName,
            channelName: this.channelName,
            text: result.text.trim(),
            timestamp,
            timestampStart: timestamp,
            timestampEnd: timestamp + 5.0, // Estimate 5s duration
            confidence: result.confidence || 0.0,
            language: this.language
          };

          // Emit event for real-time broadcasting
          this.emit('transcription', segment);

          // Save to database
          this.saveTranscript(segment);

          console.log(`[Transcriber] ${this.producerName}: "${segment.text}"`);
        }
      } catch (e) {
        // Not JSON, skip
      }
    }
  }

  /**
   * Save transcript to database and enqueue for embedding
   * @param {object} segment - Transcription segment
   * @returns {number} Transcript ID
   */
  saveTranscript(segment) {
    try {
      const transcript = createTranscript({
        room_id: this.roomId,
        channel_name: segment.channelName,
        producer_id: segment.producerId,
        producer_name: segment.producerName,
        text_content: segment.text,
        timestamp_start: segment.timestampStart,
        timestamp_end: segment.timestampEnd,
        confidence_score: segment.confidence,
        language: segment.language
      });

      // Enqueue for embedding generation
      embeddingService.enqueue({
        transcriptId: transcript.id,
        text: segment.text,
        roomId: this.roomId
      });

      return transcript.id;
    } catch (err) {
      console.error(`[Transcriber] Failed to save transcript: ${err.message}`);
      return null;
    }
  }

  /**
   * Handle Whisper process crash
   */
  async handleWhisperCrash() {
    if (this.restartCount >= this.maxRestarts) {
      console.error(`[Transcriber] Max restart attempts reached for ${this.producerName}`);
      this.emit('error', new Error('Whisper process crashed too many times'));
      await this.stop();
      return;
    }

    this.restartCount++;
    console.log(`[Transcriber] Attempting to restart Whisper (attempt ${this.restartCount}/${this.maxRestarts})`);

    try {
      await this.startWhisperProcess();
      console.log(`[Transcriber] Whisper restarted successfully`);
    } catch (err) {
      console.error(`[Transcriber] Failed to restart Whisper: ${err.message}`);
      await this.stop();
    }
  }

  /**
   * Stop the transcription session
   */
  async stop() {
    console.log(`[Transcriber] Stopping session for ${this.producerName}`);

    // Stop FFmpeg
    if (this.audioConverter) {
      try {
        this.audioConverter.kill('SIGTERM');
      } catch (e) {
        // Process already dead
      }
      this.audioConverter = null;
    }

    // Stop Whisper
    if (this.whisperProcess) {
      try {
        this.whisperProcess.kill('SIGTERM');
      } catch (e) {
        // Process already dead
      }
      this.whisperProcess = null;
      this.whisperReady = false;
    }

    // Close consumer
    if (this.consumer && !this.consumer.closed) {
      try {
        this.consumer.close();
      } catch (e) {
        console.error(`[Transcriber] Error closing consumer: ${e.message}`);
      }
    }

    // Close transport
    if (this.plainTransport && !this.plainTransport.closed) {
      try {
        this.plainTransport.close();
      } catch (e) {
        console.error(`[Transcriber] Error closing transport: ${e.message}`);
      }
    }

    // Release port
    if (this.rtpPort) {
      releaseRtpPort(this.rtpPort);
      this.rtpPort = null;
    }

    // Cleanup SDP file
    if (this.sdpPath && fs.existsSync(this.sdpPath)) {
      try {
        fs.unlinkSync(this.sdpPath);
      } catch (e) {
        // File already deleted
      }
    }

    console.log(`[Transcriber] Session stopped for ${this.producerName}`);
  }
}

/**
 * Start transcription for a producer
 * @param {number} roomId - Room ID
 * @param {object} producer - mediasoup producer
 * @param {object} config - Configuration
 * @param {string} config.channelName - Channel name
 * @param {string} config.producerName - Publisher name
 * @param {string} config.language - Language code
 * @param {string} config.roomSlug - Room slug
 * @returns {TranscriptionSession} Session object
 */
export async function startTranscription(roomId, producer, config) {
  if (!TRANSCRIPTION_ENABLED) {
    console.log('[Transcriber] Transcription is disabled');
    return null;
  }

  if (!router) {
    throw new Error('Transcriber not initialized');
  }

  const session = new TranscriptionSession(roomId, producer.id, config);

  try {
    await session.start(producer);
    activeSessions.set(producer.id, session);
    return session;
  } catch (err) {
    console.error(`[Transcriber] Failed to start transcription: ${err.message}`);
    throw err;
  }
}

/**
 * Stop transcription for a producer
 * @param {string} producerId - Producer ID
 */
export async function stopTranscription(producerId) {
  const session = activeSessions.get(producerId);
  if (session) {
    await session.stop();
    activeSessions.delete(producerId);
  }
}

/**
 * Stop all active transcription sessions
 */
export async function stopAllTranscriptions() {
  const promises = [];
  for (const [producerId, session] of activeSessions) {
    promises.push(session.stop());
  }
  await Promise.all(promises);
  activeSessions.clear();
}

/**
 * Get active transcription session for a producer
 * @param {string} producerId - Producer ID
 * @returns {TranscriptionSession|null} Session or null
 */
export function getTranscriptionSession(producerId) {
  return activeSessions.get(producerId) || null;
}

export default {
  initTranscriber,
  startTranscription,
  stopTranscription,
  stopAllTranscriptions,
  getTranscriptionSession
};
