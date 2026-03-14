import fs from 'fs';
import path from 'path';
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

const DEFAULT_MODEL = process.env.TRANSCRIPTION_MODEL || 'mlx-community/Qwen3-ASR-0.6B-8bit';
const SIDECAR_URL = process.env.TRANSCRIPTION_SIDECAR_URL || 'http://127.0.0.1:8765';
const POLL_INTERVAL_MS = parseInt(process.env.TRANSCRIPTION_POLL_INTERVAL_MS || '5000', 10);
const MIN_SEGMENT_AGE_MS = parseInt(process.env.TRANSCRIPTION_MIN_SEGMENT_AGE_MS || '1500', 10);
const SNAPSHOT_DEBOUNCE_MS = parseInt(process.env.TRANSCRIPTION_SNAPSHOT_DEBOUNCE_MS || '300', 10);
const RECORDING_DIR = process.env.RECORDING_DIR || path.join(process.cwd(), 'recordings');
const AVAILABILITY_CACHE_MS = 15000;

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
  constructor({ fastify, verifyPublisherToken, verifyTenantApiKey, getRoomBySlug, listRoomsByTenant }) {
    this.fastify = fastify;
    this.verifyPublisherToken = verifyPublisherToken;
    this.verifyTenantApiKey = verifyTenantApiKey;
    this.getRoomBySlug = getRoomBySlug;
    this.listRoomsByTenant = listRoomsByTenant;

    this.sessions = new Map(); // roomId -> sessionState
    this.docs = new Map(); // key(sessionId:roomSlug:channel) -> TranscriptDocState

    this.lastAvailabilityCheckAt = 0;
    this.lastAvailability = null;
  }

  get isMacAppleSilicon() {
    return process.platform === 'darwin' && process.arch === 'arm64';
  }

  makeDocKey(roomSlug, channelName, sessionId) {
    return `${sessionId}::${roomSlug}::${channelName}`;
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
      const response = await fetch(`${SIDECAR_URL}/health`, { method: 'GET' });
      if (!response.ok) {
        this.lastAvailability = { ok: false, reason: `ASR sidecar health check failed (${response.status}).` };
        this.lastAvailabilityCheckAt = now;
        return this.lastAvailability;
      }

      const data = await response.json();
      if (!data?.ready) {
        this.lastAvailability = { ok: false, reason: data?.reason || 'ASR sidecar is not ready.' };
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

  getRoomSession(roomId) {
    return this.sessions.get(roomId) || null;
  }

  reconcileStaleSessions(reason = 'Transcription session stopped after server restart') {
    const activeSessions = listActiveTranscriptionSessions();
    if (!activeSessions.length) return 0;
    for (const session of activeSessions) {
      stopAllTranscriptionStreamsBySession(session.id, 'stopped');
      stopTranscriptionSession(session.id, 'stopped', reason);
    }
    return activeSessions.length;
  }

  getRoomTranscriptionStatus(roomId) {
    const activeSession = this.sessions.get(roomId);
    if (!activeSession) return null;

    return {
      transcriptionActive: true,
      transcriptionSessionId: activeSession.sessionId,
      eventName: activeSession.eventName,
      modelName: activeSession.modelName,
      startedAt: activeSession.startedAt,
      streamCount: activeSession.streams.size
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
      streams: new Map() // producerId -> streamState
    };

    this.sessions.set(roomId, sessionState);

    for (const track of initialTracks) {
      this.registerProducerStream(roomId, track);
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

    if (session.pollTimer) {
      clearInterval(session.pollTimer);
      session.pollTimer = null;
    }

    for (const [producerId] of session.streams) {
      stopTranscriptionStream(session.sessionId, producerId, status);
    }

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

    return {
      transcriptionActive: false,
      transcriptionSessionId: session.sessionId,
      eventName: session.eventName,
      modelName: session.modelName,
      startedAt: session.startedAt,
      stoppedAt: stopped?.stopped_at || nowIso(),
      streamCount: session.streams.size
    };
  }

  async forceStopSession(roomId, sessionId, reason = 'Stopped by admin') {
    const session = getTranscriptionSessionByRoomAndId(roomId, sessionId);
    if (!session) return null;

    const inMemory = this.sessions.get(roomId);
    if (inMemory && inMemory.sessionId === sessionId) {
      return this.stopRoomSession(roomId, 'stopped', reason);
    }

    if (session.status === 'active') {
      stopAllTranscriptionStreamsBySession(sessionId, 'stopped');
      const stopped = stopTranscriptionSession(sessionId, 'stopped', reason);
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

  registerProducerStream(roomId, trackInfo) {
    const session = this.sessions.get(roomId);
    if (!session || !trackInfo) return null;

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
      processedFiles: new Set()
    };
    session.streams.set(trackInfo.producerId, state);
    return state;
  }

  unregisterProducerStream(roomId, producerId) {
    const session = this.sessions.get(roomId);
    if (!session) return;
    if (session.streams.has(producerId)) {
      stopTranscriptionStream(session.sessionId, producerId, 'stopped');
      session.streams.delete(producerId);
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
      if (ageMs < MIN_SEGMENT_AGE_MS) continue;

      try {
        const finalText = await this.transcribeFile(filePath, 'English');
        streamState.processedFiles.add(filename);

        if (!finalText || !finalText.trim()) continue;

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
          text_content: finalText.trim(),
          timestamp_start_ms: timestampStart,
          timestamp_end_ms: timestampEnd,
          confidence_score: null,
          language: 'English'
        });

        const docState = await this.getOrCreateDoc(
          session.roomId,
          session.roomSlug,
          session.sessionId,
          streamState.channelName,
          session.eventName
        );
        this.appendAsrText(docState, finalText.trim());
      } catch (error) {
        this.fastify.log.error(`Failed to transcribe segment ${filePath}: ${error.message}`);
        await sleep(100);
      }
    }
  }

  async transcribeFile(filePath, language = 'English') {
    const payload = fs.readFileSync(filePath);
    const formData = new FormData();
    formData.append('language', language);
    formData.append('model', DEFAULT_MODEL);
    formData.append('audio', new Blob([payload], { type: 'audio/ogg' }), path.basename(filePath));

    const response = await fetch(`${SIDECAR_URL}/api/v1/transcribe/stream`, {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Sidecar response ${response.status}: ${message}`);
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
}

export default TranscriptionRuntime;
