import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import dgram from 'dgram';
import fs from 'fs';
import path from 'path';
import { getRoomBySlug } from '../db/models/room.js';
import { recordTranscriptSegment } from './segment-handler.js';

const TRANSCRIPTION_ENABLED = process.env.TRANSCRIPTION_ENABLED === 'true';
const QWEN_ASR_BIN = process.env.QWEN_ASR_BIN || 'qwen_asr';
const QWEN_ASR_MODEL_DIR = process.env.QWEN_ASR_MODEL_DIR || './models/qwen3-asr-0.6b';
const QWEN_ASR_TIMEOUT_MS = parseInt(process.env.QWEN_ASR_TIMEOUT_MS || '60000');
const QWEN_ASR_EXTRA_ARGS = (process.env.QWEN_ASR_EXTRA_ARGS || '')
  .split(/\s+/)
  .map(arg => arg.trim())
  .filter(Boolean);
const QWEN_ASR_TEST_TEXT = process.env.QWEN_ASR_TEST_TEXT || '';
const TRANSCRIPTION_CHUNK_SECONDS = parseFloat(process.env.TRANSCRIPTION_CHUNK_SECONDS || '5');
const TRANSCRIPTION_CHUNK_OVERLAP_SECONDS = parseFloat(process.env.TRANSCRIPTION_CHUNK_OVERLAP_SECONDS || '1');
const FFMPEG_RESTART_MAX_ATTEMPTS = parseInt(process.env.QWEN_ASR_FFMPEG_RESTART_MAX_ATTEMPTS || '3');
const FFMPEG_RESTART_DELAY_MS = parseInt(process.env.QWEN_ASR_FFMPEG_RESTART_DELAY_MS || '500');
const FIRST_AUDIO_TIMEOUT_MS = parseInt(process.env.QWEN_ASR_FIRST_AUDIO_TIMEOUT_MS || '10000');
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
const pendingStarts = new Map();
const usedRtpPorts = new Set();

function isUdpPortAvailable(port) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;

    const finalize = (available) => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch (_) {
        // no-op
      }
      resolve(available);
    };

    socket.once('error', () => finalize(false));
    socket.once('listening', () => finalize(true));
    socket.bind(port, '127.0.0.1');
  });
}

async function allocateRtpPort() {
  for (let port = RTP_PORT_MIN; port <= RTP_PORT_MAX; port++) {
    if (!usedRtpPorts.has(port) && await isUdpPortAvailable(port)) {
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
    console.log(`[QwenTranscriber] Initialized (enabled, mode: qwen, bin: ${QWEN_ASR_BIN})`);
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

    this.asrBin = QWEN_ASR_BIN;
    this.asrModelDir = QWEN_ASR_MODEL_DIR;
    this.sessionStartTimestamp = Date.now() / 1000;
    this.startedAt = Date.now();
    this.segmentsProcessed = 0;
    this.errors = 0;
    this.pendingRequests = 0;
    this.fileWriter = null;
    this.testSegmentEmitted = false;
    this.ffmpegRestartAttempts = 0;
    this.stopped = false;
    this.audioSeen = false;
    this.firstAudioTimeout = null;
    this.restartTimer = null;
  }

  async start(producer) {
    if (!router) {
      throw new Error('Router not initialized');
    }

    this.rtpPort = await allocateRtpPort();

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

    // Match native transcriber behavior: give RTP flow a brief head start.
    await new Promise(resolve => setTimeout(resolve, 200));
    this.startAudioPipeline();
    this.maybeEmitTestSegment();

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

  maybeEmitTestSegment() {
    if (!QWEN_ASR_TEST_TEXT || this.testSegmentEmitted) return;
    this.testSegmentEmitted = true;
    setTimeout(async () => {
      try {
        const now = Date.now() / 1000;
        await recordTranscriptSegment(this, {
          text: QWEN_ASR_TEST_TEXT,
          timestampStart: now,
          timestampEnd: now + 1,
          confidence: 1.0
        });
        this.segmentsProcessed++;
      } catch (err) {
        console.error(`[QwenTranscriber] Failed to emit test segment: ${err.message}`);
      }
    }, 1000);
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
    if (this.stopped) return;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.firstAudioTimeout) {
      clearTimeout(this.firstAudioTimeout);
      this.firstAudioTimeout = null;
    }

    this.audioConverter = spawn('ffmpeg', [
      '-protocol_whitelist', 'file,rtp,udp',
      '-fflags', '+nobuffer',
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
    this.firstAudioTimeout = setTimeout(() => {
      if (!this.audioSeen && !this.stopped) {
        console.warn(`[QwenTranscriber] No PCM audio received within ${FIRST_AUDIO_TIMEOUT_MS}ms for ${this.producerName}`);
      }
    }, FIRST_AUDIO_TIMEOUT_MS);

    this.audioConverter.stderr.on('data', (data) => {
      const text = data.toString();
      if (text.toLowerCase().includes('error')) {
        console.error(`[QwenTranscriber] FFmpeg stderr: ${text.trim()}`);
      }
    });

    this.audioConverter.on('close', (code) => {
      console.log(`[QwenTranscriber] FFmpeg exited with code ${code}`);
      if (this.firstAudioTimeout) {
        clearTimeout(this.firstAudioTimeout);
        this.firstAudioTimeout = null;
      }
      this.audioConverter = null;

      if (this.stopped) {
        if (this.sdpPath && fs.existsSync(this.sdpPath)) {
          fs.unlinkSync(this.sdpPath);
        }
        return;
      }

      if (this.ffmpegRestartAttempts < FFMPEG_RESTART_MAX_ATTEMPTS) {
        this.ffmpegRestartAttempts++;
        console.warn(
          `[QwenTranscriber] Restarting FFmpeg (${this.ffmpegRestartAttempts}/${FFMPEG_RESTART_MAX_ATTEMPTS}) for ${this.producerName}`
        );
        this.restartTimer = setTimeout(() => this.startAudioPipeline(), FFMPEG_RESTART_DELAY_MS);
      } else {
        console.error(`[QwenTranscriber] FFmpeg restart limit reached for ${this.producerName}`);
      }
    });
  }

  processAudioChunk(chunk) {
    if (!this.audioSeen && chunk.length > 0) {
      this.audioSeen = true;
      this.ffmpegRestartAttempts = 0;
      if (this.firstAudioTimeout) {
        clearTimeout(this.firstAudioTimeout);
        this.firstAudioTimeout = null;
      }
      console.log(`[QwenTranscriber] First PCM audio received for ${this.producerName}`);
    }

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
    const chunkDuration = chunk.length / (SAMPLE_RATE * BYTES_PER_SAMPLE);
    this.pendingRequests++;

    try {
      const payload = await this.runQwenAsr(chunk);
      await this.handleAsrResponse(payload, chunkStart, chunkDuration);
    } catch (err) {
      console.error(`[QwenTranscriber] Chunk transcription failed: ${err.message}`);
      this.errors++;
    } finally {
      this.pendingRequests = Math.max(0, this.pendingRequests - 1);
    }
  }

  mapLanguageCodeToQwenName(code) {
    if (!code) return null;
    const normalized = String(code).trim().toLowerCase();
    const map = {
      en: 'English',
      zh: 'Chinese',
      fr: 'French',
      de: 'German',
      es: 'Spanish',
      pt: 'Portuguese',
      it: 'Italian',
      ja: 'Japanese',
      ko: 'Korean',
      ru: 'Russian',
      ms: 'Malay',
      id: 'Indonesian',
      vi: 'Vietnamese',
      hi: 'Hindi',
      ar: 'Arabic',
      tr: 'Turkish',
      nl: 'Dutch',
      sv: 'Swedish',
      da: 'Danish',
      fi: 'Finnish',
      pl: 'Polish',
      cs: 'Czech',
      tl: 'Filipino',
      fa: 'Persian',
      el: 'Greek',
      ro: 'Romanian',
      hu: 'Hungarian',
      th: 'Thai',
      yue: 'Cantonese'
    };
    return map[normalized] || null;
  }

  runQwenAsr(chunk) {
    return new Promise((resolve, reject) => {
      if (!chunk || chunk.length === 0) {
        resolve({ text: '' });
        return;
      }

      if (!this.asrBin || !this.asrModelDir) {
        reject(new Error('QWEN_ASR_BIN/QWEN_ASR_MODEL_DIR not configured'));
        return;
      }

      const args = ['-d', this.asrModelDir, '--stdin', '--silent', ...QWEN_ASR_EXTRA_ARGS];
      const forcedLanguage = this.mapLanguageCodeToQwenName(this.language);
      if (forcedLanguage) {
        args.push('--language', forcedLanguage);
      }

      const child = spawn(this.asrBin, args, {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`qwen_asr timed out after ${QWEN_ASR_TIMEOUT_MS}ms`));
      }, QWEN_ASR_TIMEOUT_MS);

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      child.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          reject(new Error(`qwen_asr exited ${code}: ${stderr.trim() || 'no stderr'}`));
          return;
        }
        resolve({ text: stdout.trim() });
      });

      child.stdin.end(chunk);
    });
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
      roomId: this.roomId,
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
    this.stopped = true;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.firstAudioTimeout) {
      clearTimeout(this.firstAudioTimeout);
      this.firstAudioTimeout = null;
    }

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
  if (pendingStarts.has(producer.id)) {
    return pendingStarts.get(producer.id);
  }

  const startPromise = (async () => {
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
    } finally {
      pendingStarts.delete(producer.id);
    }
  })();

  pendingStarts.set(producer.id, startPromise);
  return startPromise;
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
  if (roomId) {
    return sessions
      .filter(s => s.roomId === roomId)
      .map(s => s.getStats());
  }
  return sessions.map(s => s.getStats());
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
