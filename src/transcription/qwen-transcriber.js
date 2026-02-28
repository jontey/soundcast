import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { getRoomBySlug } from '../db/models/room.js';
import { recordTranscriptSegment } from './segment-handler.js';

const TRANSCRIPTION_ENABLED = process.env.TRANSCRIPTION_ENABLED === 'true';
const VLLMS_ASR_URL = process.env.TRANSCRIPTION_VLLMS_URL || 'http://127.0.0.1:11434/asr';
const TRANSCRIPTION_CHUNK_SECONDS = parseFloat(process.env.TRANSCRIPTION_CHUNK_SECONDS || '5');
const TRANSCRIPTION_CHUNK_OVERLAP_SECONDS = parseFloat(process.env.TRANSCRIPTION_CHUNK_OVERLAP_SECONDS || '1');
const TRANSCRIPTION_REQUEST_TIMEOUT_MS = parseInt(process.env.TRANSCRIPTION_REQUEST_TIMEOUT_MS || '20000');
const RTP_PORT_MIN = parseInt(process.env.TRANSCRIPTION_RTP_PORT_MIN || '51000');
const RTP_PORT_MAX = parseInt(process.env.TRANSCRIPTION_RTP_PORT_MAX || '51999');

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;

let router = null;
let channels = null;
let fastify = null;
let onTranscriptUpdate = null;
let onSessionUpdate = null;

const activeSessions = new Map();
const usedRtpPorts = new Set();

function allocateRtpPort() {
  for (let port = RTP_PORT_MIN; port <= RTP_PORT_MAX; port++) {
    if (!usedRtpPorts.has(port)) {
      usedRtpPorts.add(port);
      return port;
    }
  }
  throw new Error('No available RTP ports for transcription');
}

function releaseRtpPort(port) {
  usedRtpPorts.delete(port);
}

export function initTranscriber(deps) {
  router = deps.router;
  channels = deps.channels;
  fastify = deps.fastify;
  onTranscriptUpdate = deps.onTranscriptUpdate;
  onSessionUpdate = deps.onSessionUpdate;

  if (TRANSCRIPTION_ENABLED) {
    console.log('[QwenTranscriber] Initialized (enabled, mode: qwen)');
  } else {
    console.log('[QwenTranscriber] Initialized (disabled)');
  }
}

class QwenTranscriptionSession extends EventEmitter {
  constructor(roomId, producerId, config) {
    super();
    this.roomId = roomId;
    this.producerId = producerId;
    this.producerName = config.producerName || 'Unknown';
    this.channelName = config.channelName || 'default';
    this.language = config.language || 'en';
    this.roomSlug = config.roomSlug || '';
    this.recordingContext = config.recordingContext || null;
    this.onTranscriptUpdate = onTranscriptUpdate;

    this.plainTransport = null;
    this.consumer = null;
    this.rtpPort = null;
    this.sdpPath = null;

    this.audioConverter = null;
    this.audioBuffer = Buffer.alloc(0);
    this.audioChunkCount = 0;
    this.queue = Promise.resolve();
    this.nextChunkStart = 0;
    this.chunkDuration = Math.max(0.1, TRANSCRIPTION_CHUNK_SECONDS);
    this.chunkOverlap = Math.min(this.chunkDuration * 0.8, Math.max(0, TRANSCRIPTION_CHUNK_OVERLAP_SECONDS));
    this.chunkStep = Math.max(0.1, this.chunkDuration - this.chunkOverlap);
    const computedChunkBytes = Math.max(1, Math.floor(this.chunkDuration * SAMPLE_RATE * BYTES_PER_SAMPLE));
    const computedOverlapBytes = Math.min(Math.max(0, Math.floor(this.chunkOverlap * SAMPLE_RATE * BYTES_PER_SAMPLE)), computedChunkBytes - 1);
    this.chunkBytes = computedChunkBytes;
    this.overlapBytes = computedOverlapBytes;

    this.asrUrl = VLLMS_ASR_URL;
    this.sessionStartTimestamp = Date.now() / 1000;
    this.startedAt = Date.now();
    this.segmentsProcessed = 0;
    this.errors = 0;
    this.pendingRequests = 0;
    this.fileWriter = null;
  }

  async start(producer) {
    if (!router) {
      throw new Error('Router not initialized');
    }

    this.rtpPort = allocateRtpPort();

    this.plainTransport = await router.createPlainTransport({
      listenIp: { ip: '127.0.0.1', announcedIp: null },
      rtcpMux: true,
      comedia: false
    });

    await this.plainTransport.connect({
      ip: '127.0.0.1',
      port: this.rtpPort
    });

    this.consumer = await this.plainTransport.consume({
      producerId: producer.id,
      rtpCapabilities: router.rtpCapabilities,
      paused: false
    });

    if (this.consumer.paused) {
      await this.consumer.resume();
    }

    this.sdpPath = path.join('/tmp', `qwen_transcription_${this.producerId}.sdp`);
    fs.writeFileSync(this.sdpPath, this.generateSdp());

    this.startAudioPipeline();

    if (this.recordingContext) {
      try {
        const sanitizeName = (value) => (value || '')
          .replace(/[^a-zA-Z0-9_-]/g, '_')
          .substring(0, 50);

        const { TranscriptFileWriter } = await import('./transcript-file-writer.js');
        this.fileWriter = new TranscriptFileWriter({
          recordingId: this.recordingContext.recordingId,
          producerId: this.producerId,
          producerName: this.producerName,
          channelName: this.channelName,
          language: this.language,
          baseDir: path.join(this.recordingContext.folderPath, sanitizeName(this.channelName)),
          baseFilename: this.recordingContext.baseFilename || sanitizeName(this.producerName)
        });

        await this.fileWriter.initialize();
        console.log(`[QwenTranscriber] File writer ready for ${this.producerName}`);
      } catch (err) {
        console.error(`[QwenTranscriber] File writer initialization failed: ${err.message}`);
        this.fileWriter = null;
      }
    }

    console.log(`[QwenTranscriber] Session started for ${this.producerName}`);
  }

  generateSdp() {
    const rtpParams = this.consumer.rtpParameters;
    const codec = rtpParams.codecs[0];
    const payloadType = codec.payloadType;
    const ssrc = rtpParams.encodings?.[0]?.ssrc || 0;

    const lines = [
      'v=0',
      'o=- 0 0 IN IP4 127.0.0.1',
      's=Qwen Transcription RTP Stream',
      't=0 0',
      `m=audio ${this.rtpPort} RTP/AVP ${payloadType}`,
      'c=IN IP4 127.0.0.1',
      `a=rtpmap:${payloadType} ${codec.mimeType.split('/')[1]}/${codec.clockRate}/${codec.channels || 1}`
    ];

    if (ssrc) {
      lines.push(`a=ssrc:${ssrc}`);
    }

    lines.push('a=recvonly');

    return lines.join('\r\n') + '\r\n';
  }

  startAudioPipeline() {
    this.audioConverter = spawn('ffmpeg', [
      '-protocol_whitelist', 'file,rtp,udp',
      '-analyzeduration', '5000000',
      '-probesize', '2500000',
      '-f', 'sdp',
      '-i', this.sdpPath,
      '-ar', String(SAMPLE_RATE),
      '-ac', '1',
      '-f', 's16le',
      'pipe:1'
    ], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    this.audioConverter.stdout.on('data', chunk => this.processAudioChunk(chunk));

    this.audioConverter.stderr.on('data', (data) => {
      const text = data.toString();
      if (text.toLowerCase().includes('error')) {
        console.error(`[QwenTranscriber] FFmpeg stderr: ${text.trim()}`);
      }
    });

    this.audioConverter.on('close', (code) => {
      console.log(`[QwenTranscriber] FFmpeg exited with code ${code}`);
      if (this.sdpPath && fs.existsSync(this.sdpPath)) {
        fs.unlinkSync(this.sdpPath);
      }
    });
  }

  processAudioChunk(chunk) {
    this.audioBuffer = Buffer.concat([this.audioBuffer, chunk]);

    while (this.audioBuffer.length >= this.chunkBytes) {
      const chunkStart = this.nextChunkStart;
      this.nextChunkStart += this.chunkStep;

      const chunkToSend = this.audioBuffer.slice(0, this.chunkBytes);
      this.audioBuffer = this.audioBuffer.slice(this.chunkBytes - this.overlapBytes);
      this.queue = this.queue.then(() => this.sendChunk(chunkToSend, chunkStart)).catch(err => {
        console.error(`[QwenTranscriber] Chunk processing error: ${err.message}`);
      });
      this.audioChunkCount++;
    }
  }

  async sendChunk(chunk, chunkStart) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TRANSCRIPTION_REQUEST_TIMEOUT_MS);
    const chunkDuration = chunk.length / (SAMPLE_RATE * BYTES_PER_SAMPLE);

    this.pendingRequests++;

    try {
      const response = await fetch(this.asrUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Transcription-Language': this.language
        },
        body: chunk,
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const payload = await response.json();
      await this.handleAsrResponse(payload, chunkStart, chunkDuration);
    } catch (err) {
      if (err.name === 'AbortError') {
        console.warn('[QwenTranscriber] Chunk request timed out');
      } else {
        console.error(`[QwenTranscriber] Chunk request failed: ${err.message}`);
      }
      this.errors++;
    } finally {
      clearTimeout(timeout);
      this.pendingRequests = Math.max(0, this.pendingRequests - 1);
    }
  }

  async handleAsrResponse(payload, chunkStart, chunkDuration) {
    const segments = this.normalizeSegments(payload);
    if (segments.length === 0) return;

    for (const segment of segments) {
      const cleanText = (segment.text || '').trim();
      if (!cleanText) continue;

      const startOffset = typeof segment.start_time === 'number' ? segment.start_time : 0;
      const endOffset = typeof segment.end_time === 'number'
        ? segment.end_time
        : startOffset + chunkDuration;

      const timestampStart = this.sessionStartTimestamp + chunkStart + startOffset;
      const timestampEnd = this.sessionStartTimestamp + chunkStart + Math.max(endOffset, startOffset + 0.001);

      await recordTranscriptSegment(this, {
        text: cleanText,
        timestampStart,
        timestampEnd,
        confidence: typeof segment.confidence === 'number' ? segment.confidence : 1.0
      });

      this.segmentsProcessed++;
    }
  }

  normalizeSegments(payload) {
    if (!payload) return [];

    if (Array.isArray(payload.segments) && payload.segments.length) {
      return payload.segments;
    }

    if (Array.isArray(payload.results) && payload.results.length) {
      return payload.results.map(item => ({
        text: item.text ?? item.transcript ?? item.result,
        start_time: item.start_time ?? item.startTime,
        end_time: item.end_time ?? item.endTime,
        confidence: item.confidence ?? item.score
      }));
    }

    if (Array.isArray(payload.transcripts) && payload.transcripts.length) {
      return payload.transcripts.map(item => ({
        text: item.text ?? item.transcript,
        start_time: item.start_time ?? item.startTime,
        end_time: item.end_time ?? item.endTime,
        confidence: item.confidence ?? item.score
      }));
    }

    if (typeof payload.text === 'string') {
      return [{ text: payload.text }];
    }

    return [];
  }

  getStats() {
    const uptime = Math.floor((Date.now() - this.startedAt) / 1000);
    return {
      sessionId: this.producerId,
      producerId: this.producerId,
      producerName: this.producerName,
      channelName: this.channelName,
      language: this.language,
      uptime,
      queueSize: this.audioBuffer.length,
      segmentsProcessed: this.segmentsProcessed,
      errors: this.errors,
      pendingRequests: this.pendingRequests
    };
  }

  async stop() {
    if (this.fileWriter) {
      try {
        await this.fileWriter.finalize();
      } catch (err) {
        console.error(`[QwenTranscriber] File writer finalize error: ${err.message}`);
      }
      this.fileWriter = null;
    }

    if (this.audioConverter) {
      this.audioConverter.kill('SIGTERM');
      this.audioConverter = null;
    }

    if (this.consumer && !this.consumer.closed) {
      this.consumer.close();
      this.consumer = null;
    }

    if (this.plainTransport && !this.plainTransport.closed) {
      this.plainTransport.close();
      this.plainTransport = null;
    }

    if (this.rtpPort) {
      releaseRtpPort(this.rtpPort);
      this.rtpPort = null;
    }

    if (this.sdpPath && fs.existsSync(this.sdpPath)) {
      fs.unlinkSync(this.sdpPath);
    }

    console.log(`[QwenTranscriber] Session stopped for ${this.producerName}`);
  }
}

export async function startTranscription(roomId, producer, config) {
  if (!TRANSCRIPTION_ENABLED) {
    console.log('[QwenTranscriber] Transcription disabled');
    return null;
  }

  if (activeSessions.has(producer.id)) {
    console.log(`[QwenTranscriber] Session already exists for producer ${producer.id}`);
    return activeSessions.get(producer.id);
  }

  const session = new QwenTranscriptionSession(roomId, producer.id, config);

  try {
    await session.start(producer);
    activeSessions.set(producer.id, session);

    session.on('transcript', (data) => {
      if (fastify?.io && data?.roomSlug) {
        fastify.io.to(`room:${data.roomSlug}`).emit('transcript', data);
      }
    });

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
    console.error(`[QwenTranscriber] Failed to start session: ${err.message}`);
    return null;
  }
}

export async function stopTranscription(producerId) {
  const session = activeSessions.get(producerId);
  if (!session) {
    console.log(`[QwenTranscriber] No session for producer ${producerId}`);
    return;
  }

  const roomSlug = session.roomSlug;
  const channelName = session.channelName;
  const producerName = session.producerName;

  await session.stop();
  activeSessions.delete(producerId);

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

export function getSessionStats(roomId = null) {
  const sessions = Array.from(activeSessions.values());
  const stats = sessions.map(s => s.getStats());
  if (roomId) {
    return stats.filter(s => s.roomId === roomId);
  }
  return stats;
}

export async function stopAllTranscriptions() {
  const promises = Array.from(activeSessions.values()).map(session => session.stop());
  await Promise.all(promises);
  activeSessions.clear();
}

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
