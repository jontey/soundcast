import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { setTimeout as sleep } from 'timers/promises';
import * as Y from 'yjs';
import {
  createTranscriptionSession,
  getTranscriptionSessionByRoomAndId,
  getActiveTranscriptionSessionByRoomId,
  listActiveTranscriptionSessions,
  stopTranscriptionSession,
  upsertTranscriptionStream,
  getActiveTranscriptionStreamsBySession,
  stopTranscriptionStream,
  stopAllTranscriptionStreamsBySession,
  createTranscriptSegment,
  listTranscriptDocsByRoom,
  listTranscriptDocsBySession,
  getTranscriptDocByRoomChannel,
  getTranscriptDocBySessionChannel,
  getLatestTranscriptDocByRoomEventChannel,
  upsertTranscriptDoc
} from '../db/models/transcription.js';
import { getRecordingById } from '../db/models/recording.js';

const DEFAULT_MODEL = process.env.TRANSCRIPTION_MODEL || 'mlx-community/Qwen3-ASR-0.6B-8bit';
const SIDECAR_HOST = process.env.TRANSCRIPTION_SIDECAR_HOST || '127.0.0.1';
const SIDECAR_PORT_START = parseInt(process.env.TRANSCRIPTION_SIDECAR_PORT_START || '8765', 10);
const MAX_SIDECAR_INSTANCES = parseInt(process.env.TRANSCRIPTION_MAX_SIDECAR_INSTANCES || '4', 10);
const SIDECAR_START_SCRIPT = process.env.TRANSCRIPTION_SIDECAR_START_SCRIPT
  || path.join(process.cwd(), 'scripts', 'start-transcription-sidecar.sh');
const SIDECAR_LOG_PREFIX = process.env.TRANSCRIPTION_SIDECAR_LOG_PREFIX || '/tmp/soundcast-asr';
const SIDECAR_HEALTH_TIMEOUT_MS = parseInt(process.env.TRANSCRIPTION_SIDECAR_HEALTH_TIMEOUT_MS || '45000', 10);
const POLL_INTERVAL_MS = parseInt(process.env.TRANSCRIPTION_POLL_INTERVAL_MS || '5000', 10);
const MIN_SEGMENT_AGE_MS = parseInt(process.env.TRANSCRIPTION_MIN_SEGMENT_AGE_MS || '1500', 10);
const RECORDING_SEGMENT_SECONDS = parseInt(process.env.RECORDING_SEGMENT_SECONDS || '5', 10);
const FINALIZED_SEGMENT_MIN_AGE_MS = parseInt(
  process.env.TRANSCRIPTION_FINALIZED_SEGMENT_MIN_AGE_MS || String((RECORDING_SEGMENT_SECONDS + 1) * 1000),
  10
);
const SNAPSHOT_DEBOUNCE_MS = parseInt(process.env.TRANSCRIPTION_SNAPSHOT_DEBOUNCE_MS || '300', 10);
const RECORDING_DIR = process.env.RECORDING_DIR || path.join(process.cwd(), 'recordings');
const AVAILABILITY_CACHE_MS = 15000;
const TRANSCRIPTION_LOCK_VERSION = 1;
const TRANSCRIPTION_LOCK_FILENAME = 'transcription.lock.json';
const TRANSCRIPTION_LANGUAGE = (process.env.TRANSCRIPTION_LANGUAGE || '').trim();
const SIDECAR_MODE = 'per-channel';

function nowIso() {
  return new Date().toISOString();
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildSegmentMatcher(segmentPattern) {
  if (!segmentPattern) return null;
  const dir = path.dirname(segmentPattern);
  const filePattern = path.basename(segmentPattern);
  const regexSource = '^' + escapeRegex(filePattern).replace('%03d', '(\\d{3})') + '$';
  return { dir, regex: new RegExp(regexSource), pattern: segmentPattern };
}

function parseTimestampStartMs(filename) {
  const match = filename.match(/_(\d{3})\.ogg$/);
  if (!match) return null;
  return parseInt(match[1], 10) * 1000;
}

function sanitizeTranscriptText(input) {
  if (!input) return '';
  return String(input)
    .replace(/<asr_text>/gi, '')
    .replace(/\uFFFD/g, '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function sanitizeLabel(input, fallback = 'unknown') {
  const value = String(input || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  if (!value) return fallback;
  return value.slice(0, 80);
}

function parseTranscriptWsRequest(req) {
  const params = req?.params || {};
  const query = req?.query || {};

  let roomSlug = params.room_slug;
  let channelName = params.channel_name;
  let apiKey = query.apiKey;
  let token = query.token;
  let sessionIdRaw = query.sessionId;

  if (!roomSlug || !channelName || (!apiKey && !token) || sessionIdRaw === undefined || sessionIdRaw === null) {
    const host = req?.headers?.host || 'localhost';
    const protocol = req?.socket?.encrypted ? 'https' : 'http';
    const parsed = new URL(req?.url || '/', `${protocol}://${host}`);

    if (!roomSlug || !channelName) {
      const match = parsed.pathname.match(/^\/ws\/transcripts\/([^/]+)\/([^/]+)$/);
      if (match) {
        roomSlug = roomSlug || decodeURIComponent(match[1]);
        channelName = channelName || decodeURIComponent(match[2]);
      }
    }

    apiKey = apiKey || parsed.searchParams.get('apiKey') || undefined;
    token = token || parsed.searchParams.get('token') || undefined;
    if (sessionIdRaw === undefined || sessionIdRaw === null) {
      sessionIdRaw = parsed.searchParams.get('sessionId');
    }
  }

  const hasSessionId = sessionIdRaw !== undefined && sessionIdRaw !== null && String(sessionIdRaw).trim() !== '';
  const parsedSessionId = hasSessionId ? parseInt(String(sessionIdRaw), 10) : null;
  const invalidSessionId = hasSessionId && (!Number.isFinite(parsedSessionId) || parsedSessionId <= 0);

  return {
    roomSlug,
    channelName,
    apiKey,
    token,
    sessionId: invalidSessionId ? null : parsedSessionId,
    hasSessionId,
    invalidSessionId
  };
}

function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function atomicWriteJson(filePath, data) {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

class TranscriptDocState {
  constructor({ roomId, roomSlug, channelName, sessionId, initialText = '', initialRevision = 0 }) {
    this.roomId = roomId;
    this.roomSlug = roomSlug;
    this.channelName = channelName;
    this.sessionId = sessionId;
    this.revision = initialRevision;
    this.ydoc = new Y.Doc();
    this.clients = new Set();
    this.persistTimer = null;
    this.persistInFlight = false;

    this.ytext = this.ydoc.getText('transcript');
    if (initialText) {
      this.ytext.insert(0, initialText);
    }
  }
}

export class TranscriptionRuntime {
  constructor({ fastify, verifyPublisherToken, verifyTenantApiKey, getRoomBySlug, getRoomById, listRoomsByTenant }) {
    this.fastify = fastify;
    this.verifyPublisherToken = verifyPublisherToken;
    this.verifyTenantApiKey = verifyTenantApiKey;
    this.getRoomBySlug = getRoomBySlug;
    this.getRoomById = getRoomById;
    this.listRoomsByTenant = listRoomsByTenant;

    this.sessions = new Map(); // roomId -> sessionState
    this.blockedSessions = new Map(); // roomId -> blocked session metadata
    this.docs = new Map(); // key(sessionId:roomSlug:channel) -> TranscriptDocState
    this.sidecarInstances = new Map(); // instanceId -> instance state
    this.channelAssignments = new Map(); // roomId::channelName -> instanceId
    this.channelUsageCounts = new Map(); // roomId::channelName -> active stream count
    this.nextInstanceId = 1;

    this.lastAvailabilityCheckAt = 0;
    this.lastAvailability = null;
  }

  get isMacAppleSilicon() {
    return process.platform === 'darwin' && process.arch === 'arm64';
  }

  makeDocKey(roomSlug, channelName, sessionId) {
    return `${sessionId}::${roomSlug}::${channelName}`;
  }

  makeChannelKey(roomId, channelName) {
    return `${roomId}::${channelName}`;
  }

  countRoomSidecars(roomId) {
    let count = 0;
    const prefix = `${roomId}::`;
    for (const key of this.channelAssignments.keys()) {
      if (key.startsWith(prefix)) count += 1;
    }
    return count;
  }

  getLockPathFromFolder(recordingFolderPath) {
    return path.join(recordingFolderPath, TRANSCRIPTION_LOCK_FILENAME);
  }

  serializeSessionLock(session, status = 'active') {
    const streams = {};
    for (const [producerId, stream] of session.streams.entries()) {
      streams[producerId] = {
        channelName: stream.channelName,
        publisherId: stream.publisherId || null,
        producerName: stream.producerName || null,
        segmentPattern: stream.segmentPattern || null,
        processedFiles: Array.from(stream.processedFiles || []),
        sidecarInstanceId: stream.sidecarInstanceId || null,
        sidecarPort: stream.sidecarPort || null,
        sidecarUrl: stream.sidecarUrl || null
      };
    }
    return {
      version: TRANSCRIPTION_LOCK_VERSION,
      pid: process.pid,
      updatedAt: nowIso(),
      roomId: session.roomId,
      roomSlug: session.roomSlug,
      recordingId: session.recordingId,
      transcriptionSessionId: session.sessionId,
      eventName: session.eventName,
      modelName: session.modelName,
      status,
      streams
    };
  }

  persistSessionLock(session, status = 'active') {
    if (!session?.recordingFolderPath) return;
    const lockPath = this.getLockPathFromFolder(session.recordingFolderPath);
    atomicWriteJson(lockPath, this.serializeSessionLock(session, status));
  }

  scheduleSessionLockPersist(session, status = 'active') {
    if (!session) return;
    if (session.lockPersistTimer) {
      clearTimeout(session.lockPersistTimer);
      session.lockPersistTimer = null;
    }
    session.lockPersistTimer = setTimeout(() => {
      try {
        this.persistSessionLock(session, status);
      } catch (error) {
        this.fastify.log.error(`Failed to persist transcription lock for room ${session.roomSlug}: ${error.message}`);
      }
    }, SNAPSHOT_DEBOUNCE_MS);
  }

  removeSessionLockByFolder(recordingFolderPath) {
    if (!recordingFolderPath) return;
    const lockPath = this.getLockPathFromFolder(recordingFolderPath);
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
    }
  }

  async checkAvailability() {
    const now = Date.now();
    if (this.lastAvailability && now - this.lastAvailabilityCheckAt < AVAILABILITY_CACHE_MS) {
      return this.lastAvailability;
    }

    if (!this.isMacAppleSilicon) {
      this.lastAvailability = {
        ok: false,
        reason: 'Live transcription is available only on macOS Apple Silicon in this phase.'
      };
      this.lastAvailabilityCheckAt = now;
      return this.lastAvailability;
    }

    try {
      if (!fs.existsSync(SIDECAR_START_SCRIPT)) {
        this.lastAvailability = {
          ok: false,
          reason: `ASR sidecar start script is missing: ${SIDECAR_START_SCRIPT}`
        };
        this.lastAvailabilityCheckAt = now;
        return this.lastAvailability;
      }

      this.lastAvailability = { ok: true };
      this.lastAvailabilityCheckAt = now;
      return this.lastAvailability;
    } catch (error) {
      this.lastAvailability = {
        ok: false,
        reason: `ASR sidecar unavailable: ${error.message}`
      };
      this.lastAvailabilityCheckAt = now;
      return this.lastAvailability;
    }
  }

  async ensureAvailableOrThrow() {
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      const error = new Error(availability.reason || 'Transcription is unavailable');
      error.code = 'TRANSCRIPTION_UNAVAILABLE';
      throw error;
    }
  }

  waitForSidecarReady(url) {
    const timeoutAt = Date.now() + SIDECAR_HEALTH_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const check = async () => {
        if (Date.now() > timeoutAt) {
          reject(new Error(`ASR sidecar health timeout (${url})`));
          return;
        }

        try {
          const response = await fetch(`${url}/health`, { method: 'GET' });
          if (!response.ok) {
            setTimeout(check, 500);
            return;
          }
          const data = await response.json();
          if (data?.ready) {
            resolve(data);
            return;
          }
        } catch { }
        setTimeout(check, 500);
      };
      check().catch(reject);
    });
  }

  findFreePort(preferredPort = null) {
    const tryPort = (port) => {
      if (!Number.isFinite(port) || port <= 0) return false;
      if (this.sidecarInstances.size >= MAX_SIDECAR_INSTANCES) return false;
      for (const instance of this.sidecarInstances.values()) {
        if (instance.port === port) return false;
      }
      return true;
    };

    if (tryPort(preferredPort)) return preferredPort;

    for (let offset = 0; offset < 100; offset += 1) {
      const candidate = SIDECAR_PORT_START + offset;
      if (tryPort(candidate)) return candidate;
    }
    return null;
  }

  async spawnSidecarInstance({ roomId, roomSlug, channelName, modelName, preferredPort = null }) {
    const port = this.findFreePort(preferredPort);
    if (!port) {
      const error = new Error('ASR sidecar capacity exceeded');
      error.code = 'SIDECAR_CAPACITY_EXCEEDED';
      throw error;
    }

    const instanceId = `asr-${this.nextInstanceId++}`;
    const roomLabel = sanitizeLabel(roomSlug || `room-${roomId}`, `room-${roomId}`);
    const channelLabel = sanitizeLabel(channelName, 'channel');
    const logBase = `${SIDECAR_LOG_PREFIX}-${roomLabel}-${channelLabel}-${port}`;
    const outPath = `${logBase}.out.log`;
    const errPath = `${logBase}.err.log`;
    const outFd = fs.openSync(outPath, 'a');
    const errFd = fs.openSync(errPath, 'a');
    const url = `http://${SIDECAR_HOST}:${port}`;

    const child = spawn('bash', [SIDECAR_START_SCRIPT], {
      env: {
        ...process.env,
        PORT: String(port),
        ASR_MODEL_ID: modelName || DEFAULT_MODEL,
        ...(process.env.TRANSCRIPTION_PYTHON_BIN ? { PYTHON_BIN: process.env.TRANSCRIPTION_PYTHON_BIN } : {})
      },
      stdio: ['ignore', outFd, errFd]
    });
    fs.closeSync(outFd);
    fs.closeSync(errFd);

    const instance = {
      id: instanceId,
      roomId,
      roomSlug,
      channelName,
      modelName: modelName || DEFAULT_MODEL,
      port,
      url,
      process: child,
      refs: 0,
      outPath,
      errPath
    };

    this.sidecarInstances.set(instanceId, instance);

    child.on('exit', (code, signal) => {
      const stillTracked = this.sidecarInstances.get(instanceId);
      if (!stillTracked) return;
      this.fastify.log.error({
        instanceId,
        roomId,
        roomSlug,
        channelName,
        port,
        code,
        signal
      }, 'ASR sidecar instance exited');
      this.handleSidecarCrash(stillTracked);
    });

    try {
      await this.waitForSidecarReady(url);
    } catch (error) {
      this.shutdownSidecarInstance(instanceId, { force: true, removeAssignment: true });
      throw error;
    }

    this.fastify.log.info({
      instanceId,
      roomId,
      roomSlug,
      channelName,
      port,
      mode: SIDECAR_MODE
    }, 'ASR sidecar instance ready');

    return instance;
  }

  async ensureChannelSidecar({ roomId, roomSlug, channelName, modelName, preferredPort = null }) {
    const channelKey = this.makeChannelKey(roomId, channelName);
    const existingId = this.channelAssignments.get(channelKey);
    if (existingId) {
      const existing = this.sidecarInstances.get(existingId);
      if (existing) return existing;
      this.channelAssignments.delete(channelKey);
    }

    if (this.sidecarInstances.size >= MAX_SIDECAR_INSTANCES) {
      const error = new Error('ASR sidecar capacity exceeded');
      error.code = 'SIDECAR_CAPACITY_EXCEEDED';
      throw error;
    }

    const instance = await this.spawnSidecarInstance({
      roomId,
      roomSlug,
      channelName,
      modelName,
      preferredPort
    });
    this.channelAssignments.set(channelKey, instance.id);
    this.fastify.log.info({
      roomId,
      roomSlug,
      channelName,
      instanceId: instance.id,
      port: instance.port
    }, 'Assigned ASR sidecar to channel');
    return instance;
  }

  async acquireChannelAssignment(session, channelName, options = {}) {
    const channelKey = this.makeChannelKey(session.roomId, channelName);
    const instance = await this.ensureChannelSidecar({
      roomId: session.roomId,
      roomSlug: session.roomSlug,
      channelName,
      modelName: session.modelName,
      preferredPort: options.preferredPort || null
    });

    const currentCount = this.channelUsageCounts.get(channelKey) || 0;
    this.channelUsageCounts.set(channelKey, currentCount + 1);
    instance.refs += 1;

    return {
      instanceId: instance.id,
      sidecarUrl: instance.url,
      sidecarPort: instance.port
    };
  }

  releaseChannelAssignment(roomId, channelName) {
    const channelKey = this.makeChannelKey(roomId, channelName);
    const currentCount = this.channelUsageCounts.get(channelKey) || 0;
    const instanceId = this.channelAssignments.get(channelKey);
    if (!instanceId) {
      this.channelUsageCounts.delete(channelKey);
      this.channelAssignments.delete(channelKey);
      return;
    }

    const instance = this.sidecarInstances.get(instanceId);
    if (instance) {
      instance.refs = Math.max(0, instance.refs - 1);
    }

    if (currentCount <= 1) {
      this.channelUsageCounts.delete(channelKey);
      this.shutdownSidecarInstance(instanceId, { force: true, removeAssignment: true });
      return;
    }

    this.channelUsageCounts.set(channelKey, currentCount - 1);
  }

  shutdownSidecarInstance(instanceId, { force = false, removeAssignment = false } = {}) {
    const instance = this.sidecarInstances.get(instanceId);
    if (!instance) return;

    if (!force && instance.refs > 0) return;

    this.sidecarInstances.delete(instanceId);
    if (removeAssignment) {
      const channelKey = this.makeChannelKey(instance.roomId, instance.channelName);
      const mappedInstanceId = this.channelAssignments.get(channelKey);
      if (mappedInstanceId === instanceId) {
        this.channelAssignments.delete(channelKey);
      }
      this.channelUsageCounts.delete(channelKey);
    }

    if (instance.process && !instance.process.killed) {
      try {
        instance.process.kill('SIGTERM');
      } catch { }
    }

    this.fastify.log.info({
      instanceId,
      roomId: instance.roomId,
      roomSlug: instance.roomSlug,
      channelName: instance.channelName,
      port: instance.port
    }, 'ASR sidecar instance stopped');
  }

  handleSidecarCrash(instance) {
    const channelKey = this.makeChannelKey(instance.roomId, instance.channelName);
    const mappedInstance = this.channelAssignments.get(channelKey);
    if (mappedInstance === instance.id) {
      this.channelAssignments.delete(channelKey);
      this.channelUsageCounts.delete(channelKey);
    }
    this.sidecarInstances.delete(instance.id);

    const session = this.sessions.get(instance.roomId);
    if (!session) return;
    if (session.stopping) return;

    const hasAffectedStream = Array.from(session.streams.values())
      .some((stream) => stream.channelName === instance.channelName);
    if (!hasAffectedStream) return;

    this.stopRoomSession(instance.roomId, 'error', 'sidecar_instance_crashed').catch((error) => {
      this.fastify.log.error(`Failed to stop transcription session after sidecar crash: ${error.message}`);
    });
  }

  getRoomSession(roomId) {
    return this.sessions.get(roomId) || null;
  }

  async recoverTranscriptionSessions() {
    const activeSessions = listActiveTranscriptionSessions();
    const result = { recovered: 0, failed: 0, blocked: 0 };
    for (const dbSession of activeSessions) {
      const room = this.getRoomById(dbSession.room_id);
      const recording = getRecordingById(dbSession.recording_id);

      if (!room || !recording || recording.status !== 'recording') {
        stopAllTranscriptionStreamsBySession(dbSession.id, 'error');
        stopTranscriptionSession(dbSession.id, 'error', 'recording_not_active');
        result.failed += 1;
        this.fastify.log.warn({ transcriptionSessionId: dbSession.id, roomId: dbSession.room_id, reason: 'recording_not_active' }, 'Transcription recovery failed');
        continue;
      }

      const recordingFolderPath = path.join(RECORDING_DIR, recording.folder_name);
      const lockPath = this.getLockPathFromFolder(recordingFolderPath);
      const lock = readJsonFile(lockPath);
      if (!lock || lock.version !== TRANSCRIPTION_LOCK_VERSION || lock.transcriptionSessionId !== dbSession.id || lock.roomId !== room.id || lock.recordingId !== recording.id) {
        stopAllTranscriptionStreamsBySession(dbSession.id, 'error');
        stopTranscriptionSession(dbSession.id, 'error', 'resume_state_missing');
        result.failed += 1;
        this.fastify.log.warn({ transcriptionSessionId: dbSession.id, roomId: room.id, reason: 'resume_state_missing' }, 'Transcription recovery failed');
        continue;
      }

      const lockPid = parseInt(lock.pid, 10);
      if (lockPid && lockPid !== process.pid && isPidAlive(lockPid)) {
        this.blockedSessions.set(room.id, {
          transcriptionSessionId: dbSession.id,
          roomId: room.id,
          roomSlug: room.slug,
          eventName: dbSession.event_name,
          modelName: dbSession.model_name,
          startedAt: dbSession.started_at,
          reason: 'session_in_use'
        });
        result.blocked += 1;
        this.fastify.log.warn({ transcriptionSessionId: dbSession.id, roomId: room.id, pid: lockPid, reason: 'session_in_use' }, 'Transcription recovery blocked');
        continue;
      }

      const sessionState = {
        roomId: room.id,
        roomSlug: room.slug,
        recordingId: dbSession.recording_id,
        folderName: recording.folder_name,
        recordingFolderPath,
        sessionId: dbSession.id,
        eventName: dbSession.event_name,
        modelName: dbSession.model_name,
        startedAt: dbSession.started_at,
        pollTimer: null,
        polling: false,
        stopping: false,
        recovered: true,
        lockPersistTimer: null,
        sidecarOverflow: false,
        streams: new Map()
      };

      let recoverFailed = false;
      const recoveredStreamEntries = Object.entries(lock.streams || {});
      for (const [producerId, streamState] of recoveredStreamEntries) {
        try {
          await this.registerProducerStream(room.id, {
            producerId,
            publisherId: streamState.publisherId || null,
            producerName: streamState.producerName || null,
            channelName: streamState.channelName || 'English',
            segmentPattern: streamState.segmentPattern || null,
            processedFiles: Array.isArray(streamState.processedFiles) ? streamState.processedFiles : [],
            preferredSidecarPort: Number.isFinite(parseInt(streamState.sidecarPort, 10))
              ? parseInt(streamState.sidecarPort, 10)
              : null
          }, sessionState);
        } catch (error) {
          recoverFailed = true;
          this.fastify.log.error({
            transcriptionSessionId: dbSession.id,
            roomId: room.id,
            producerId,
            reason: error.message
          }, 'Failed recovering transcription stream');
          break;
        }
      }

      if (recoverFailed) {
        this.releaseSessionChannels(sessionState);
        stopAllTranscriptionStreamsBySession(dbSession.id, 'error');
        stopTranscriptionSession(dbSession.id, 'error', 'resume_sidecar_unavailable');
        result.failed += 1;
        continue;
      }

      this.sessions.set(room.id, sessionState);
      this.persistSessionLock(sessionState, 'active');
      sessionState.pollTimer = setInterval(() => {
        this.pollRoomSession(sessionState).catch((error) => {
          this.fastify.log.error(`Transcription poll failed for room ${room.slug}: ${error.message}`);
        });
      }, POLL_INTERVAL_MS);
      result.recovered += 1;
      this.fastify.log.info({ transcriptionSessionId: dbSession.id, roomId: room.id, recovered: true }, 'Transcription session recovered');
    }
    return result;
  }

  getRoomTranscriptionStatus(roomId) {
    const blocked = this.blockedSessions.get(roomId);
    if (blocked) {
      const session = getTranscriptionSessionByRoomAndId(roomId, blocked.transcriptionSessionId);
      if (!session || session.status !== 'active') {
        this.blockedSessions.delete(roomId);
      } else {
        return {
          transcriptionActive: true,
          transcriptionSessionId: blocked.transcriptionSessionId,
          eventName: blocked.eventName,
          modelName: blocked.modelName,
          startedAt: blocked.startedAt,
          streamCount: 0,
          recovered: false,
          sidecarMode: SIDECAR_MODE,
          sidecarInstanceCount: this.countRoomSidecars(roomId),
          sidecarCapacity: MAX_SIDECAR_INSTANCES,
          sidecarOverflow: false,
          unavailable: true,
          unavailableReason: blocked.reason
        };
      }
    }

    const activeSession = this.sessions.get(roomId);
    if (!activeSession) return null;

    return {
      transcriptionActive: true,
      transcriptionSessionId: activeSession.sessionId,
      eventName: activeSession.eventName,
      modelName: activeSession.modelName,
      startedAt: activeSession.startedAt,
      streamCount: activeSession.streams.size,
      recovered: Boolean(activeSession.recovered),
      sidecarMode: SIDECAR_MODE,
      sidecarInstanceCount: this.countRoomSidecars(roomId),
      sidecarCapacity: MAX_SIDECAR_INSTANCES,
      sidecarOverflow: Boolean(activeSession.sidecarOverflow),
      unavailable: false
    };
  }

  async startRoomSession({
    roomId,
    roomSlug,
    recordingId,
    folderName,
    eventName,
    modelName = DEFAULT_MODEL,
    initialTracks = []
  }) {
    if (this.sessions.has(roomId)) {
      return this.getRoomTranscriptionStatus(roomId);
    }
    this.blockedSessions.delete(roomId);

    const channelSet = new Set();
    for (const track of initialTracks) {
      if (track?.channelName) channelSet.add(track.channelName);
    }
    const availableSlots = Math.max(0, MAX_SIDECAR_INSTANCES - this.sidecarInstances.size);
    if (channelSet.size > availableSlots) {
      const error = new Error(`sidecar_capacity_exceeded: requires ${channelSet.size} channels, available ${availableSlots}, capacity ${MAX_SIDECAR_INSTANCES}`);
      error.code = 'SIDECAR_CAPACITY_EXCEEDED';
      throw error;
    }

    const created = createTranscriptionSession({
      room_id: roomId,
      recording_id: recordingId,
      event_name: eventName,
      model_name: modelName
    });

    const sessionState = {
      roomId,
      roomSlug,
      recordingId,
      folderName,
      recordingFolderPath: path.join(RECORDING_DIR, folderName),
      sessionId: created.id,
      eventName: created.event_name,
      modelName: created.model_name,
      startedAt: created.started_at,
      pollTimer: null,
      polling: false,
      stopping: false,
      recovered: false,
      lockPersistTimer: null,
      sidecarOverflow: false,
      streams: new Map() // producerId -> streamState
    };

    this.sessions.set(roomId, sessionState);
    try {
      for (const track of initialTracks) {
        await this.registerProducerStream(roomId, track, sessionState);
      }
      this.persistSessionLock(sessionState, 'active');
    } catch (error) {
      this.releaseSessionChannels(sessionState);
      this.sessions.delete(roomId);
      stopAllTranscriptionStreamsBySession(sessionState.sessionId, 'error');
      stopTranscriptionSession(sessionState.sessionId, 'error', error.code === 'SIDECAR_CAPACITY_EXCEEDED' ? 'sidecar_capacity_exceeded' : error.message);
      throw error;
    }

    sessionState.pollTimer = setInterval(() => {
      this.pollRoomSession(sessionState).catch((error) => {
        this.fastify.log.error(`Transcription poll failed for room ${roomSlug}: ${error.message}`);
      });
    }, POLL_INTERVAL_MS);

    await this.pollRoomSession(sessionState);
    return this.getRoomTranscriptionStatus(roomId);
  }

  async stopRoomSession(roomId, status = 'stopped', errorMessage = null) {
    const session = this.sessions.get(roomId);
    if (!session) return null;
    session.stopping = true;
    this.blockedSessions.delete(roomId);

    if (session.pollTimer) {
      clearInterval(session.pollTimer);
      session.pollTimer = null;
    }
    if (session.lockPersistTimer) {
      clearTimeout(session.lockPersistTimer);
      session.lockPersistTimer = null;
    }

    for (const [producerId] of session.streams) {
      stopTranscriptionStream(session.sessionId, producerId, status);
    }
    this.releaseSessionChannels(session);

    const stopped = stopTranscriptionSession(session.sessionId, status, errorMessage);
    this.sessions.delete(roomId);

    for (const [docKey, docState] of this.docs) {
      if (docState.roomId !== roomId) continue;
      if (docState.sessionId !== session.sessionId) continue;
      await this.persistDocSnapshot(docState);
      for (const socket of docState.clients) {
        try {
          socket.close();
        } catch { }
      }
      this.docs.delete(docKey);
    }
    this.persistSessionLock(session, status);
    this.removeSessionLockByFolder(session.recordingFolderPath);

    return {
      transcriptionActive: false,
      transcriptionSessionId: session.sessionId,
      eventName: session.eventName,
      modelName: session.modelName,
      startedAt: session.startedAt,
      stoppedAt: stopped?.stopped_at || nowIso(),
      streamCount: session.streams.size,
      recovered: Boolean(session.recovered),
      status: stopped?.status || status
    };
  }

  async forceStopSession(roomId, sessionId, reason = 'Stopped by admin') {
    const session = getTranscriptionSessionByRoomAndId(roomId, sessionId);
    if (!session) return null;
    this.blockedSessions.delete(roomId);

    const inMemory = this.sessions.get(roomId);
    if (inMemory && inMemory.sessionId === sessionId) {
      return this.stopRoomSession(roomId, 'stopped', reason);
    }

    if (session.status === 'active') {
      stopAllTranscriptionStreamsBySession(sessionId, 'stopped');
      const stopped = stopTranscriptionSession(sessionId, 'stopped', reason);
      const recording = getRecordingById(session.recording_id);
      if (recording?.folder_name) {
        this.removeSessionLockByFolder(path.join(RECORDING_DIR, recording.folder_name));
      }
      return {
        transcriptionActive: false,
        transcriptionSessionId: stopped?.id || sessionId,
        eventName: stopped?.event_name || session.event_name,
        modelName: stopped?.model_name || session.model_name,
        startedAt: stopped?.started_at || session.started_at,
        stoppedAt: stopped?.stopped_at || null,
        status: stopped?.status || 'stopped'
      };
    }

    return {
      transcriptionActive: false,
      transcriptionSessionId: session.id,
      eventName: session.event_name,
      modelName: session.model_name,
      startedAt: session.started_at,
      stoppedAt: session.stopped_at,
      status: session.status
    };
  }

  releaseSessionChannels(session) {
    if (!session) return;
    for (const stream of session.streams.values()) {
      if (stream?.channelName) {
        this.releaseChannelAssignment(session.roomId, stream.channelName);
      }
    }
  }

  async registerProducerStream(roomId, trackInfo, explicitSession = null) {
    const session = explicitSession || this.sessions.get(roomId);
    if (!session || !trackInfo) return null;

    const existingStream = session.streams.get(trackInfo.producerId);
    if (existingStream) {
      if (existingStream.channelName) {
        this.releaseChannelAssignment(session.roomId, existingStream.channelName);
      }
      stopTranscriptionStream(session.sessionId, trackInfo.producerId, 'stopped');
    }

    let sidecarAssignment;
    try {
      sidecarAssignment = await this.acquireChannelAssignment(session, trackInfo.channelName, {
        preferredPort: trackInfo.preferredSidecarPort || null
      });
    } catch (error) {
      if (error.code === 'SIDECAR_CAPACITY_EXCEEDED' && !explicitSession) {
        session.sidecarOverflow = true;
        this.stopRoomSession(roomId, 'error', 'sidecar_capacity_exceeded').catch((stopError) => {
          this.fastify.log.error(`Failed to stop overflowed transcription session for room ${session.roomSlug}: ${stopError.message}`);
        });
      }
      throw error;
    }

    const streamRow = upsertTranscriptionStream({
      session_id: session.sessionId,
      room_id: session.roomId,
      channel_name: trackInfo.channelName,
      producer_id: trackInfo.producerId,
      publisher_id: trackInfo.publisherId || null,
      producer_name: trackInfo.producerName || null
    });

    const matcher = buildSegmentMatcher(trackInfo.segmentPattern);
    const state = {
      streamId: streamRow.id,
      producerId: trackInfo.producerId,
      publisherId: trackInfo.publisherId || null,
      producerName: trackInfo.producerName || null,
      channelName: trackInfo.channelName,
      segmentPattern: trackInfo.segmentPattern || null,
      matcher,
      processedFiles: new Set(Array.isArray(trackInfo.processedFiles) ? trackInfo.processedFiles : []),
      sidecarInstanceId: sidecarAssignment.instanceId,
      sidecarPort: sidecarAssignment.sidecarPort,
      sidecarUrl: sidecarAssignment.sidecarUrl
    };
    session.streams.set(trackInfo.producerId, state);
    this.scheduleSessionLockPersist(session, 'active');
    return state;
  }

  unregisterProducerStream(roomId, producerId) {
    const session = this.sessions.get(roomId);
    if (!session) return;
    if (session.streams.has(producerId)) {
      const stream = session.streams.get(producerId);
      stopTranscriptionStream(session.sessionId, producerId, 'stopped');
      session.streams.delete(producerId);
      if (stream?.channelName) {
        this.releaseChannelAssignment(session.roomId, stream.channelName);
      }
      this.scheduleSessionLockPersist(session, 'active');
    }
  }

  async pollRoomSession(session) {
    if (session.polling) return;
    session.polling = true;
    try {
      for (const streamState of session.streams.values()) {
        await this.pollProducerStream(session, streamState);
      }
    } finally {
      session.polling = false;
    }
  }

  async pollProducerStream(session, streamState) {
    if (!streamState.matcher) return;

    const { dir, regex } = streamState.matcher;
    if (!fs.existsSync(dir)) return;

    const entries = fs.readdirSync(dir)
      .filter((file) => regex.test(file))
      .sort();

    for (const filename of entries) {
      if (streamState.processedFiles.has(filename)) continue;

      const filePath = path.join(dir, filename);
      const stat = fs.statSync(filePath);
      const ageMs = Date.now() - stat.mtimeMs;
      const requiredAgeMs = Math.max(MIN_SEGMENT_AGE_MS, FINALIZED_SEGMENT_MIN_AGE_MS);
      if (ageMs < requiredAgeMs) continue;

      // Avoid prematurely marking still-open segment files as processed.
      if (stat.size <= 0) {
        if (ageMs < requiredAgeMs * 3) {
          continue;
        }
        streamState.processedFiles.add(filename);
        this.scheduleSessionLockPersist(session, 'active');
        this.fastify.log.warn(`Skipping stale empty segment ${filePath} (ageMs=${ageMs})`);
        continue;
      }

      try {
        const finalText = sanitizeTranscriptText(
          await this.transcribeFile(filePath, {
            language: TRANSCRIPTION_LANGUAGE || null,
            sidecarUrl: streamState.sidecarUrl
          })
        );
        streamState.processedFiles.add(filename);
        this.scheduleSessionLockPersist(session, 'active');

        if (!finalText) continue;

        const timestampStart = parseTimestampStartMs(filename);
        const timestampEnd = timestampStart === null ? null : timestampStart + POLL_INTERVAL_MS;
        createTranscriptSegment({
          session_id: session.sessionId,
          stream_id: streamState.streamId,
          room_id: session.roomId,
          channel_name: streamState.channelName,
          producer_id: streamState.producerId,
          publisher_id: streamState.publisherId,
          segment_file: path.relative(session.recordingFolderPath, filePath),
          text_content: finalText,
          timestamp_start_ms: timestampStart,
          timestamp_end_ms: timestampEnd,
          confidence_score: null,
          language: TRANSCRIPTION_LANGUAGE || null
        });

        const docState = await this.getOrCreateDoc(
          session.roomId,
          session.roomSlug,
          session.sessionId,
          streamState.channelName,
          session.eventName
        );
        this.appendAsrText(docState, finalText);
      } catch (error) {
        // No retry policy: mark the segment as processed after first failed send.
        streamState.processedFiles.add(filename);
        this.scheduleSessionLockPersist(session, 'active');
        this.fastify.log.warn(`Skipping segment ${filePath} after failed transcription attempt: ${error.message}`);
        await sleep(100);
      }
    }
  }

  async transcribeFile(filePath, { language = TRANSCRIPTION_LANGUAGE || null, sidecarUrl = null } = {}) {
    if (!sidecarUrl) {
      throw new Error('Missing sidecar assignment for transcription stream');
    }
    const payload = fs.readFileSync(filePath);
    const formData = new FormData();
    if (language) {
      formData.append('language', language);
    }
    formData.append('model', DEFAULT_MODEL);
    formData.append('audio', new Blob([payload], { type: 'audio/ogg' }), path.basename(filePath));

    const response = await fetch(`${sidecarUrl}/api/v1/transcribe/stream`, {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      const message = await response.text();
      const error = new Error(`Sidecar response ${response.status}: ${message}`);
      if (response.status === 400 && message.includes('Empty audio payload')) {
        error.code = 'EMPTY_AUDIO';
      }
      throw error;
    }

    const contentType = response.headers.get('content-type') || '';
    if (!response.body || contentType.includes('application/json')) {
      const data = await response.json();
      return data?.text || '';
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = '';
    let finalText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let lineEnd = buffer.indexOf('\n');
      while (lineEnd !== -1) {
        const line = buffer.slice(0, lineEnd).trim();
        buffer = buffer.slice(lineEnd + 1);
        if (line) {
          try {
            const item = JSON.parse(line);
            if (item.type === 'final' && item.text) {
              finalText = item.text;
            }
          } catch { }
        }
        lineEnd = buffer.indexOf('\n');
      }
    }

    if (!finalText && buffer.trim()) {
      try {
        const tail = JSON.parse(buffer.trim());
        if (tail.type === 'final' && tail.text) {
          finalText = tail.text;
        }
      } catch { }
    }

    return finalText;
  }

  appendAsrText(docState, text) {
    if (!text) return;
    docState.ydoc.transact(() => {
      const current = docState.ytext.toString();
      const prefix = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
      docState.ytext.insert(current.length, `${prefix}${text}\n`);
    }, 'asr');
  }

  schedulePersist(docState) {
    if (docState.persistTimer) {
      clearTimeout(docState.persistTimer);
      docState.persistTimer = null;
    }
    docState.persistTimer = setTimeout(() => {
      this.persistDocSnapshot(docState).catch((error) => {
        this.fastify.log.error(`Failed to persist transcript doc ${docState.roomSlug}/${docState.channelName}: ${error.message}`);
      });
    }, SNAPSHOT_DEBOUNCE_MS);
  }

  async persistDocSnapshot(docState) {
    if (docState.persistInFlight) return;
    docState.persistInFlight = true;
    try {
      const text = docState.ytext.toString();
      docState.revision += 1;
      upsertTranscriptDoc({
        session_id: docState.sessionId,
        room_id: docState.roomId,
        channel_name: docState.channelName,
        text_content: text,
        revision: docState.revision
      });
    } finally {
      docState.persistInFlight = false;
    }
  }

  async getOrCreateDoc(roomId, roomSlug, sessionId, channelName, eventName = null) {
    const key = this.makeDocKey(roomSlug, channelName, sessionId);
    if (this.docs.has(key)) return this.docs.get(key);

    const existingDocForSession = getTranscriptDocBySessionChannel(roomId, sessionId, channelName);
    const seedDoc = existingDocForSession || getLatestTranscriptDocByRoomEventChannel(roomId, eventName, channelName);

    const docState = new TranscriptDocState({
      roomId,
      roomSlug,
      channelName,
      sessionId,
      initialText: seedDoc?.text_content || '',
      initialRevision: seedDoc?.revision || 0
    });

    docState.ydoc.on('update', (update, origin) => {
      for (const socket of docState.clients) {
        if (origin && socket === origin) continue;
        if (socket.readyState !== 1) continue;
        try {
          socket.send(Buffer.from(update), { binary: true });
        } catch { }
      }
      this.schedulePersist(docState);
    });

    this.docs.set(key, docState);
    return docState;
  }

  async authenticateTranscriptSocket(roomSlug, apiKey, token) {
    const room = this.getRoomBySlug(roomSlug);
    if (!room) {
      return { ok: false, status: 404, message: 'Room not found' };
    }

    if (apiKey) {
      const tenant = this.verifyTenantApiKey(apiKey);
      if (!tenant) {
        return { ok: false, status: 403, message: 'Invalid API key' };
      }

      const tenantRooms = this.listRoomsByTenant(tenant.id);
      const allowed = tenantRooms.some((r) => r.id === room.id);
      if (!allowed) {
        return { ok: false, status: 403, message: 'Room not allowed for tenant' };
      }
      return { ok: true, room, authMode: 'admin' };
    }

    if (token) {
      const publisher = this.verifyPublisherToken(token);
      if (!publisher || publisher.room_id !== room.id) {
        return { ok: false, status: 403, message: 'Invalid publisher token for room' };
      }
      return { ok: true, room, authMode: 'publisher' };
    }

    return { ok: false, status: 401, message: 'Missing apiKey or token' };
  }

  registerWsRoute(fastifyInstance) {
    fastifyInstance.register(async (app) => {
      app.get('/ws/transcripts/:room_slug/:channel_name', { websocket: true }, async (connection, req) => {
        const socket = connection?.socket || connection;
        if (!socket || typeof socket.send !== 'function' || typeof socket.on !== 'function') {
          this.fastify.log.error('Transcript websocket connection is not a valid socket');
          return;
        }

        const { roomSlug, channelName, apiKey, token, sessionId, hasSessionId, invalidSessionId } = parseTranscriptWsRequest(req);
        if (!roomSlug || !channelName) {
          socket.send(JSON.stringify({ type: 'error', message: 'Invalid transcript websocket path' }));
          socket.close();
          return;
        }
        if (invalidSessionId) {
          socket.send(JSON.stringify({ type: 'error', message: 'Invalid sessionId' }));
          socket.close();
          return;
        }
        const auth = await this.authenticateTranscriptSocket(roomSlug, apiKey, token);
        if (!auth.ok) {
          socket.send(JSON.stringify({ type: 'error', message: auth.message }));
          socket.close();
          return;
        }

        const room = auth.room;
        const runtimeActiveSession = this.getRoomSession(room.id);
        const activeSession = runtimeActiveSession || (() => {
          const active = getActiveTranscriptionSessionByRoomId(room.id);
          if (!active) return null;
          return {
            roomId: room.id,
            roomSlug,
            recordingId: active.recording_id,
            folderName: null,
            recordingFolderPath: null,
            sessionId: active.id,
            eventName: active.event_name,
            modelName: active.model_name,
            startedAt: active.started_at,
            pollTimer: null,
            polling: false,
            streams: new Map()
          };
        })();

        if (auth.authMode === 'publisher' && hasSessionId) {
          socket.send(JSON.stringify({ type: 'error', message: 'Publishers can only edit the active transcription session' }));
          socket.close();
          return;
        }

        let session = activeSession;
        if (auth.authMode === 'admin' && hasSessionId) {
          if (activeSession?.sessionId === sessionId) {
            session = activeSession;
          } else {
            const requestedSession = getTranscriptionSessionByRoomAndId(room.id, sessionId);
            session = requestedSession
              ? {
                roomId: room.id,
                roomSlug,
                recordingId: requestedSession.recording_id,
                folderName: null,
                recordingFolderPath: null,
                sessionId: requestedSession.id,
                eventName: requestedSession.event_name,
                modelName: requestedSession.model_name,
                startedAt: requestedSession.started_at,
                pollTimer: null,
                polling: false,
                streams: new Map()
              }
              : null;
          }
        }

        if (!session) {
          socket.send(JSON.stringify({ type: 'error', message: 'Transcription session not found' }));
          socket.close();
          return;
        }

        const docState = await this.getOrCreateDoc(
          room.id,
          roomSlug,
          session.sessionId,
          channelName,
          session.eventName || session.event_name
        );
        docState.clients.add(socket);

        const fullUpdate = Y.encodeStateAsUpdate(docState.ydoc);
        socket.send(Buffer.from(fullUpdate), { binary: true });

        socket.on('message', (message) => {
          try {
            if (typeof message === 'string') {
              const payload = JSON.parse(message);
              if (payload?.type === 'ping') {
                socket.send(JSON.stringify({ type: 'pong' }));
              }
              return;
            }

            const update = new Uint8Array(message);
            Y.applyUpdate(docState.ydoc, update, socket);
          } catch (error) {
            this.fastify.log.error(`Invalid transcript websocket message: ${error.message}`);
          }
        });

        socket.on('close', () => {
          docState.clients.delete(socket);
        });
      });
    });
  }

  getSessionDocs(roomId, roomSlug, sessionId) {
    const session = getTranscriptionSessionByRoomAndId(roomId, sessionId);
    if (!session) return null;

    const docs = listTranscriptDocsBySession(roomId, sessionId);
    const docsByChannel = new Map(docs.map((doc) => [doc.channel_name, doc]));

    for (const docState of this.docs.values()) {
      if (docState.roomId !== roomId || docState.sessionId !== sessionId) continue;
      docsByChannel.set(docState.channelName, {
        channel_name: docState.channelName,
        text_content: docState.ytext.toString(),
        revision: docState.revision,
        updated_at: nowIso()
      });
    }

    const resolvedDocs = Array.from(docsByChannel.values())
      .sort((a, b) => a.channel_name.localeCompare(b.channel_name))
      .map((doc) => ({
        channelName: doc.channel_name,
        text: doc.text_content,
        revision: doc.revision,
        updatedAt: doc.updated_at
      }));

    return {
      transcriptionSessionId: session.id,
      eventName: session.event_name,
      modelName: session.model_name,
      status: session.status,
      startedAt: session.started_at,
      stoppedAt: session.stopped_at,
      docs: resolvedDocs
    };
  }

  getSessionChannelDoc(roomId, roomSlug, sessionId, channelName) {
    const session = getTranscriptionSessionByRoomAndId(roomId, sessionId);
    if (!session) return null;

    const liveDoc = this.docs.get(this.makeDocKey(roomSlug, channelName, sessionId));
    const doc = liveDoc
      ? {
        channel_name: channelName,
        text_content: liveDoc.ytext.toString(),
        revision: liveDoc.revision,
        updated_at: nowIso()
      }
      : getTranscriptDocBySessionChannel(roomId, sessionId, channelName);

    if (!doc) {
      return {
        transcriptionSessionId: session.id,
        eventName: session.event_name,
        modelName: session.model_name,
        status: session.status,
        startedAt: session.started_at,
        stoppedAt: session.stopped_at,
        channelName,
        text: '',
        revision: 0,
        updatedAt: null
      };
    }

    return {
      transcriptionSessionId: session.id,
      eventName: session.event_name,
      modelName: session.model_name,
      status: session.status,
      startedAt: session.started_at,
      stoppedAt: session.stopped_at,
      channelName: doc.channel_name,
      text: doc.text_content,
      revision: doc.revision,
      updatedAt: doc.updated_at
    };
  }

  getCurrentRoomDocs(roomId) {
    const session = this.sessions.get(roomId) || getActiveTranscriptionSessionByRoomId(roomId);
    if (!session) return null;
    const docs = listTranscriptDocsByRoom(roomId);
    return {
      transcriptionSessionId: session.sessionId || session.id,
      eventName: session.eventName || session.event_name,
      modelName: session.modelName || session.model_name,
      docs: docs.map((doc) => ({
        channelName: doc.channel_name,
        text: doc.text_content,
        revision: doc.revision,
        updatedAt: doc.updated_at
      }))
    };
  }

  getChannelDoc(roomId, channelName) {
    const session = this.sessions.get(roomId) || getActiveTranscriptionSessionByRoomId(roomId);
    if (!session) return null;

    const doc = getTranscriptDocByRoomChannel(roomId, channelName);
    if (!doc) {
      return {
        transcriptionSessionId: session.sessionId || session.id,
        eventName: session.eventName || session.event_name,
        modelName: session.modelName || session.model_name,
        channelName,
        text: '',
        revision: 0,
        updatedAt: null
      };
    }

    return {
      transcriptionSessionId: session.sessionId || session.id,
      eventName: session.eventName || session.event_name,
      modelName: session.modelName || session.model_name,
      channelName: doc.channel_name,
      text: doc.text_content,
      revision: doc.revision,
      updatedAt: doc.updated_at
    };
  }

  async shutdown() {
    for (const session of this.sessions.values()) {
      if (session.pollTimer) {
        clearInterval(session.pollTimer);
        session.pollTimer = null;
      }
      if (session.lockPersistTimer) {
        clearTimeout(session.lockPersistTimer);
        session.lockPersistTimer = null;
      }
    }

    for (const instanceId of [...this.sidecarInstances.keys()]) {
      this.shutdownSidecarInstance(instanceId, { force: true, removeAssignment: true });
    }
  }
}

export default TranscriptionRuntime;
