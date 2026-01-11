import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createTranscript } from '../db/models/transcript.js';
import { getRoomBySlug } from '../db/models/room.js';
import { embeddingService } from './embedder.js';
import { WhisperTranscriber } from '../native/whisper-binding.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const WHISPER_MODEL_DIR = process.env.WHISPER_MODEL_DIR || './models';
const WHISPER_MODEL_SIZE = process.env.WHISPER_MODEL_SIZE || 'base';
const TRANSCRIPTION_ENABLED = process.env.TRANSCRIPTION_ENABLED === 'true';
const TRANSCRIPTION_USE_NATIVE = process.env.TRANSCRIPTION_USE_NATIVE !== 'false'; // Default to native

// Port allocation for RTP
const RTP_PORT_MIN = parseInt(process.env.TRANSCRIPTION_RTP_PORT_MIN || '51000');
const RTP_PORT_MAX = parseInt(process.env.TRANSCRIPTION_RTP_PORT_MAX || '51999');

// Dependencies injected from server.js
let router = null;
let channels = null;
let fastify = null;
let onTranscriptUpdate = null;
let onSessionUpdate = null;

// Active transcription sessions: producerId -> TranscriptionSession
const activeSessions = new Map();

// Port allocation tracking
const usedRtpPorts = new Set();

/**
 * Initialize the transcriber module
 */
export function initTranscriber(deps) {
  router = deps.router;
  channels = deps.channels;
  fastify = deps.fastify;
  onTranscriptUpdate = deps.onTranscriptUpdate;
  onSessionUpdate = deps.onSessionUpdate;

  if (TRANSCRIPTION_ENABLED) {
    console.log(`Transcriber initialized (enabled, mode: ${TRANSCRIPTION_USE_NATIVE ? 'native' : 'http'})`);
  } else {
    console.log('Transcriber initialized (disabled)');
  }
}

/**
 * Allocate a free UDP port for RTP
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
 */
function releaseRtpPort(port) {
  usedRtpPorts.delete(port);
}

/**
 * Transcription Session - Native N-API version
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
    this.modelPath = config.modelPath || this.resolveModelPath();

    // mediasoup components
    this.plainTransport = null;
    this.consumer = null;
    this.rtpPort = null;
    this.sdpPath = null;

    // Native Whisper addon
    this.whisperTranscriber = null;
    this.whisperStream = null;

    // FFmpeg audio converter (Opus → 16kHz PCM Float32)
    this.audioConverter = null;
    this.audioBuffer = Buffer.alloc(0);
    this.audioChunkCount = 0;

    // Timing
    this.startTime = Date.now();
    this.sessionStartTimestamp = this.startTime / 1000; // Unix timestamp in seconds

    // Stats
    this.segmentsProcessed = 0;
    this.errors = 0;
    this.queueSize = 0;

    // Recording integration
    this.recordingContext = config.recordingContext || null;
    this.fileWriter = null;
  }

  /**
   * Resolve model path based on configuration
   */
  resolveModelPath() {
    const modelPath = path.join(WHISPER_MODEL_DIR, `ggml-${WHISPER_MODEL_SIZE}.bin`);
    const modelEnPath = path.join(WHISPER_MODEL_DIR, `ggml-${WHISPER_MODEL_SIZE}.en.bin`);

    // Use English-only model if available and language is English
    if (this.language === 'en' && fs.existsSync(modelEnPath)) {
      return modelEnPath;
    }

    return modelPath;
  }

  /**
   * Start the transcription session
   */
  async start(producer) {
    try {
      console.log(`[Transcriber] Starting native session for ${this.producerName} (${this.language})`);

      // 1. Validate model exists
      if (!fs.existsSync(this.modelPath)) {
        throw new Error(`Whisper model not found: ${this.modelPath}`);
      }

      // 2. Initialize native Whisper transcriber
      this.whisperTranscriber = new WhisperTranscriber(this.modelPath, {
        language: this.language,
        threads: 4
      });

      await this.whisperTranscriber.loadModel();
      console.log(`[Transcriber] Native model loaded: ${path.basename(this.modelPath)}`);

      // 3. Create streaming session
      this.whisperStream = this.whisperTranscriber.createStream();

      // 4. Handle transcription segments
      this.whisperStream.on('segment', (segment) => {
        this.handleSegment(segment);
      });

      this.whisperStream.on('error', (err) => {
        console.error(`[Transcriber] Native addon error: ${err.message}`);
        this.errors++;
      });

      // 5. Allocate RTP port
      this.rtpPort = allocateRtpPort();

      // 6. Create PlainTransport for consuming the producer
      this.plainTransport = await router.createPlainTransport({
        listenIp: { ip: '127.0.0.1', announcedIp: null },
        rtcpMux: true,
        comedia: false
      });

      // 7. Connect the transport
      await this.plainTransport.connect({
        ip: '127.0.0.1',
        port: this.rtpPort
      });

      console.log(`[Transcriber] PlainTransport connected to 127.0.0.1:${this.rtpPort}`);

      // 8. Create consumer on the PlainTransport
      this.consumer = await this.plainTransport.consume({
        producerId: producer.id,
        rtpCapabilities: router.rtpCapabilities,
        paused: false
      });

      // 9. Resume consumer to ensure RTP flows
      if (this.consumer.paused) {
        await this.consumer.resume();
      }

      console.log(`[Transcriber] Consumer created for producer ${this.producerId}`);

      // 10. Wait briefly for RTP stream to establish before starting FFmpeg
      await new Promise(resolve => setTimeout(resolve, 200));

      // 11. Start audio pipeline (RTP → FFmpeg → Native Addon)
      this.startAudioPipeline();

      // 12. Initialize file writer if recording is active
      if (this.recordingContext) {
        try {
          const { recordingId, folderPath, channelName, baseFilename } = this.recordingContext;
          const sanitizeName = (name) => name.replace(/[^a-zA-Z0-9_-]/g, '_');

          const { TranscriptFileWriter } = await import('./transcript-file-writer.js');
          this.fileWriter = new TranscriptFileWriter({
            recordingId,
            producerId: this.producerId,
            producerName: this.producerName,
            channelName,
            language: this.language,
            baseDir: path.join(folderPath, sanitizeName(channelName)),
            baseFilename
          });

          await this.fileWriter.initialize();
          console.log(`[Transcriber] File writer initialized for ${this.producerName}`);
        } catch (err) {
          console.error(`[Transcriber] Failed to initialize file writer: ${err.message}`);
          this.fileWriter = null;
        }
      }

      console.log(`[Transcriber] Native session started for ${this.producerName}`);
      return true;
    } catch (err) {
      console.error(`[Transcriber] Failed to start native session: ${err.message}`);
      await this.stop();
      throw err;
    }
  }

  /**
   * Start audio pipeline: RTP → FFmpeg → Float32 PCM → Native Addon
   */
  startAudioPipeline() {
    // Generate SDP for RTP stream
    const sdpContent = this.generateSdp();
    this.sdpPath = path.join('/tmp', `transcription_${this.producerId}.sdp`);
    fs.writeFileSync(this.sdpPath, sdpContent);

    // Spawn FFmpeg to convert Opus (48kHz stereo) → Float32 PCM (16kHz mono)
    this.audioConverter = spawn('ffmpeg', [
      '-protocol_whitelist', 'file,rtp,udp',
      '-analyzeduration', '5000000',
      '-probesize', '2500000',
      '-f', 'sdp',
      '-i', this.sdpPath,
      // Convert to Whisper-compatible format
      '-ar', '16000',       // 16kHz sample rate
      '-ac', '1',           // Mono
      '-f', 'f32le',        // Float32 PCM (little-endian)
      'pipe:1'              // Output to stdout
    ], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    // Pipe audio directly to native addon
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
      this.errors++;
    });

    this.audioConverter.on('close', (code) => {
      console.log(`[Transcriber] FFmpeg process exited with code ${code}`);
      // Cleanup SDP file
      if (this.sdpPath && fs.existsSync(this.sdpPath)) {
        fs.unlinkSync(this.sdpPath);
      }
    });

    console.log(`[Transcriber] Native audio pipeline started`);
  }

  /**
   * Generate SDP for RTP stream
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
   * Process audio chunk - send directly to native addon
   */
  async processAudioChunk(chunk) {
    if (!this.whisperStream) return;

    try {
      // Update queue size estimate
      this.queueSize = this.audioBuffer.length + chunk.length;

      // Write directly to streaming session
      this.whisperStream.write(chunk);
      this.audioChunkCount++;
    } catch (err) {
      console.error(`[Transcriber] Failed to process audio chunk: ${err.message}`);
      this.errors++;
    }
  }

  /**
   * Handle transcription segment from native addon
   */
  async handleSegment(segment) {
    try {
      const text = segment.text.trim();
      if (!text || text.length < 2) return;

      // Calculate absolute timestamps using current time for real-time accuracy
      const now = Date.now() / 1000; // Current time in seconds
      const segmentDuration = (segment.timestampEnd - segment.timestampStart) / 1000;

      // Use current time as end, and subtract duration for start
      // This ensures unique timestamps for each segment as they arrive
      const timestampEnd = now;
      const timestampStart = now - segmentDuration;

      console.log(`[Transcriber] ${this.producerName}: "${text}"`);

      // Save to database
      const transcript = await createTranscript({
        room_id: this.roomId,
        channel_name: this.channelName,
        producer_id: this.producerId,
        producer_name: this.producerName,
        text_content: text,
        timestamp_start: timestampStart,
        timestamp_end: timestampEnd,
        language: this.language,
        confidence_score: 1.0 // Native addon doesn't provide confidence yet
      });

      this.segmentsProcessed++;

      // Notify admin clients via WebSocket
      if (onTranscriptUpdate && this.roomSlug) {
        const room = getRoomBySlug(this.roomSlug);
        if (room) {
          onTranscriptUpdate(room.tenant_id, this.roomSlug, {
            id: transcript.id,
            channel_name: this.channelName,
            producer_name: this.producerName,
            text_content: text,
            timestamp_start: timestampStart,
            timestamp_end: timestampEnd,
            language: this.language
          });
        }
      }

      // Write to file if recording is active
      if (this.fileWriter && !this.fileWriter.isClosed) {
        try {
          await this.fileWriter.appendSegment({
            id: transcript.id,
            text,
            timestampStart,
            timestampEnd,
            confidence: 1.0
          });
        } catch (err) {
          console.error(`[Transcriber] File write error: ${err.message}`);
        }
      }

      // Generate embedding (async, don't wait)
      if (process.env.EMBEDDING_ENABLED === 'true') {
        embeddingService.enqueue({
          transcriptId: transcript.id,
          text: text,
          roomId: this.roomId
        });
      }

      // Emit event for real-time UI updates
      this.emit('transcript', {
        roomId: this.roomId,
        roomSlug: this.roomSlug,
        channelName: this.channelName,
        producerId: this.producerId,
        producerName: this.producerName,
        text,
        timestampStart,
        timestampEnd,
        transcriptId: transcript.id
      });

    } catch (err) {
      console.error(`[Transcriber] Failed to handle segment: ${err.message}`);
      this.errors++;
    }
  }

  /**
   * Get session statistics
   */
  getStats() {
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);
    return {
      sessionId: this.producerId,
      producerId: this.producerId,
      producerName: this.producerName,
      channelName: this.channelName,
      language: this.language,
      modelPath: this.modelPath,
      uptime,
      queueSize: this.queueSize,
      segmentsProcessed: this.segmentsProcessed,
      errors: this.errors
    };
  }

  /**
   * Stop the transcription session
   */
  async stop() {
    console.log(`[Transcriber] Stopping native session for ${this.producerName}`);

    // Finalize file writer before cleanup
    if (this.fileWriter) {
      try {
        await this.fileWriter.finalize();
        console.log(`[Transcriber] File writer finalized for ${this.producerName}`);
      } catch (err) {
        console.error(`[Transcriber] Error finalizing file writer: ${err.message}`);
      }
      this.fileWriter = null;
    }

    // Stop audio converter
    if (this.audioConverter) {
      this.audioConverter.kill('SIGTERM');
      this.audioConverter = null;
    }

    // Cleanup SDP file
    if (this.sdpPath && fs.existsSync(this.sdpPath)) {
      try {
        fs.unlinkSync(this.sdpPath);
      } catch (err) {
        console.error(`[Transcriber] Failed to cleanup SDP: ${err.message}`);
      }
    }

    // Stop native whisper stream
    if (this.whisperStream) {
      try {
        await this.whisperStream.end();
      } catch (err) {
        console.error(`[Transcriber] Error ending whisper stream: ${err.message}`);
      }
      this.whisperStream = null;
    }

    // Destroy native transcriber
    if (this.whisperTranscriber) {
      this.whisperTranscriber.destroy();
      this.whisperTranscriber = null;
    }

    // Close consumer
    if (this.consumer) {
      this.consumer.close();
      this.consumer = null;
    }

    // Close transport
    if (this.plainTransport) {
      this.plainTransport.close();
      this.plainTransport = null;
    }

    // Release RTP port
    if (this.rtpPort) {
      releaseRtpPort(this.rtpPort);
      this.rtpPort = null;
    }

    console.log(`[Transcriber] Native session stopped for ${this.producerName}`);
  }
}

/**
 * Start transcription for a producer
 */
export async function startTranscription(roomId, producer, config) {
  if (!TRANSCRIPTION_ENABLED) {
    console.log('[Transcriber] Transcription disabled by config');
    return null;
  }

  if (activeSessions.has(producer.id)) {
    console.log(`[Transcriber] Session already exists for producer ${producer.id}`);
    return activeSessions.get(producer.id);
  }

  const session = new TranscriptionSession(roomId, producer.id, config);

  try {
    await session.start(producer);
    activeSessions.set(producer.id, session);

    // Forward transcript events
    session.on('transcript', (data) => {
      // Emit to WebSocket subscribers for this room
      if (fastify?.io) {
        fastify.io.to(`room:${data.roomSlug}`).emit('transcript', data);
      }
    });

    // Notify admin clients that session started
    if (onSessionUpdate && config.roomSlug) {
      const room = getRoomBySlug(config.roomSlug);
      if (room) {
        onSessionUpdate(room.tenant_id, config.roomSlug, {
          action: 'started',
          producerId: producer.id,
          channelName: config.channelName || 'default',
          producerName: config.producerName || 'Unknown',
          language: config.language || 'en'
        });
      }
    }

    return session;
  } catch (err) {
    console.error(`[Transcriber] Failed to start transcription: ${err.message}`);
    return null;
  }
}

/**
 * Stop transcription for a producer
 */
export async function stopTranscription(producerId) {
  const session = activeSessions.get(producerId);
  if (!session) {
    console.log(`[Transcriber] No active session for producer ${producerId}`);
    return;
  }

  // Get session info before stopping
  const roomSlug = session.roomSlug;
  const channelName = session.channelName;
  const producerName = session.producerName;

  await session.stop();
  activeSessions.delete(producerId);

  // Notify admin clients that session stopped
  if (onSessionUpdate && roomSlug) {
    const room = getRoomBySlug(roomSlug);
    if (room) {
      onSessionUpdate(room.tenant_id, roomSlug, {
        action: 'stopped',
        producerId,
        channelName,
        producerName
      });
    }
  }
}

/**
 * Get active session statistics
 */
export function getSessionStats(roomId = null) {
  const sessions = Array.from(activeSessions.values());

  if (roomId) {
    return sessions
      .filter(s => s.roomId === roomId)
      .map(s => s.getStats());
  }

  return sessions.map(s => s.getStats());
}

/**
 * Stop all transcription sessions
 */
export async function stopAllTranscriptions() {
  console.log(`[Transcriber] Stopping all active sessions (${activeSessions.size})`);

  const stopPromises = Array.from(activeSessions.values()).map(session => session.stop());
  await Promise.all(stopPromises);

  activeSessions.clear();
}

/**
 * Get an active transcription session by producer ID
 */
export function getTranscriptionSession(producerId) {
  return activeSessions.get(producerId) || null;
}

export default {
  initTranscriber,
  startTranscription,
  stopTranscription,
  getSessionStats,
  stopAllTranscriptions,
  getTranscriptionSession
};
