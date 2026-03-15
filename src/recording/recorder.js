import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPublisherById } from '../db/models/publisher.js';
import {
  createRecording,
  getActiveRecordingByRoomId,
  listActiveRecordings,
  getRecordingById,
  updateRecordingStatus,
  createRecordingTrack,
  updateRecordingTrackStatus,
  listTracksByRecordingId,
  stopAllTracksForRecording
} from '../db/models/recording.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const RECORDING_DIR = process.env.RECORDING_DIR || path.join(process.cwd(), 'recordings');
const RTP_PORT_MIN = parseInt(process.env.RECORDING_RTP_PORT_MIN || '50000');
const RTP_PORT_MAX = parseInt(process.env.RECORDING_RTP_PORT_MAX || '50999');
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const RECORDING_SEGMENT_SECONDS = parseInt(process.env.RECORDING_SEGMENT_SECONDS || '5');
const RECORDING_MERGE_ON_STOP = process.env.RECORDING_MERGE_ON_STOP !== 'false';
const RECORDING_DELETE_SEGMENTS_AFTER_MERGE = process.env.RECORDING_DELETE_SEGMENTS_AFTER_MERGE === 'true';
const SESSION_LOCK_VERSION = 1;
const SESSION_LOCK_FILENAME = 'session.lock.json';

// Dependencies injected from server.js
let router = null;
let channels = null;
let fastify = null;
let onStatusChange = null; // Callback for status change notifications

// Active recording sessions: roomId -> RecordingSession
const activeRecordings = new Map();
const blockedRecordings = new Map(); // roomId -> { recordingId, roomSlug, tenantId, folderName, startedAt, reason }

// Port allocation tracking
const usedPorts = new Set();

/**
 * Initialize the recorder module with dependencies from server.js
 * @param {object} deps - Dependencies
 * @param {object} deps.router - mediasoup router
 * @param {Map} deps.channels - channels Map
 * @param {object} deps.fastify - fastify instance
 * @param {function} deps.onStatusChange - Callback when recording status changes (tenantId, roomSlug, status)
 */
export function initRecorder(deps) {
  router = deps.router;
  channels = deps.channels;
  fastify = deps.fastify;
  onStatusChange = deps.onStatusChange || null;

  // Ensure recordings directory exists
  if (!fs.existsSync(RECORDING_DIR)) {
    fs.mkdirSync(RECORDING_DIR, { recursive: true });
  }

  console.log(`Recorder initialized. Recordings directory: ${RECORDING_DIR}`);
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

function getSessionLockPath(folderPath) {
  return path.join(folderPath, SESSION_LOCK_FILENAME);
}

function serializeSessionLock(session, status = 'recording') {
  const tracks = {};
  for (const [producerId, track] of session.tracks.entries()) {
    tracks[producerId] = {
      channelName: track.channelName,
      producerName: track.producerName,
      segmentPattern: track.segmentPattern,
      mergedFilePath: track.mergedFilePath,
      publisherId: track.publisherId || null,
      lastSeenAt: new Date().toISOString()
    };
  }
  return {
    version: SESSION_LOCK_VERSION,
    pid: process.pid,
    startedAt: session.startedAt.toISOString(),
    updatedAt: new Date().toISOString(),
    roomId: session.roomId,
    roomSlug: session.roomSlug,
    tenantId: session.tenantId || null,
    recordingId: session.recordingId,
    folderName: path.basename(session.folderPath),
    status,
    tracks
  };
}

function persistSessionLock(session, status = 'recording') {
  if (!session?.folderPath) return;
  const lockPath = getSessionLockPath(session.folderPath);
  atomicWriteJson(lockPath, serializeSessionLock(session, status));
}

function removeSessionLock(session) {
  if (!session?.folderPath) return;
  const lockPath = getSessionLockPath(session.folderPath);
  if (fs.existsSync(lockPath)) {
    fs.unlinkSync(lockPath);
  }
}

export function recoverRecordingSessions({ getRoomById }) {
  const active = listActiveRecordings();
  const now = new Date().toISOString();
  const result = { recovered: 0, failed: 0, blocked: 0 };
  for (const recording of active) {
    const room = getRoomById(recording.room_id);
    if (!room) {
      updateRecordingStatus(recording.id, 'error', now);
      stopAllTracksForRecording(recording.id);
      result.failed += 1;
      fastify?.log?.warn({ recordingId: recording.id, reason: 'room_not_found' }, 'Recording recovery failed');
      continue;
    }

    const folderPath = path.join(RECORDING_DIR, recording.folder_name);
    const lockPath = getSessionLockPath(folderPath);
    const lock = readJsonFile(lockPath);
    if (!lock || lock.version !== SESSION_LOCK_VERSION || lock.recordingId !== recording.id || lock.roomId !== room.id) {
      updateRecordingStatus(recording.id, 'error', now);
      stopAllTracksForRecording(recording.id);
      result.failed += 1;
      fastify?.log?.warn({ recordingId: recording.id, roomId: room.id, reason: 'resume_state_missing' }, 'Recording recovery failed');
      continue;
    }

    const lockPid = parseInt(lock.pid, 10);
    if (lockPid && lockPid !== process.pid && isPidAlive(lockPid)) {
      blockedRecordings.set(room.id, {
        recordingId: recording.id,
        roomSlug: room.slug,
        tenantId: room.tenant_id,
        folderName: recording.folder_name,
        startedAt: recording.started_at,
        reason: 'session_in_use'
      });
      result.blocked += 1;
      fastify?.log?.warn({ recordingId: recording.id, roomId: room.id, pid: lockPid, reason: 'session_in_use' }, 'Recording recovery blocked');
      continue;
    }

    if (!fs.existsSync(folderPath)) {
      updateRecordingStatus(recording.id, 'error', now);
      stopAllTracksForRecording(recording.id);
      result.failed += 1;
      fastify?.log?.warn({ recordingId: recording.id, roomId: room.id, reason: 'recording_folder_missing' }, 'Recording recovery failed');
      continue;
    }

    const session = new RecordingSession(room.id, room.slug, recording.id, folderPath);
    session.tenantId = room.tenant_id;
    session.startedAt = new Date(recording.started_at || lock.startedAt || now);
    session.recovered = true;
    activeRecordings.set(room.id, session);
    persistSessionLock(session, 'recording');
    result.recovered += 1;
    fastify?.log?.info({ recordingId: recording.id, roomId: room.id, recovered: true }, 'Recording session recovered');
  }
  return result;
}

/**
 * Allocate a free UDP port for RTP
 * @returns {number} Available port
 */
function allocatePort() {
  // Reserve RTP/RTCP as a pair (port + 1) to avoid collisions between
  // concurrent FFmpeg inputs that may bind both sockets.
  const start = RTP_PORT_MIN % 2 === 0 ? RTP_PORT_MIN : RTP_PORT_MIN + 1;
  for (let port = start; port <= RTP_PORT_MAX - 1; port += 2) {
    if (!usedPorts.has(port) && !usedPorts.has(port + 1)) {
      usedPorts.add(port);
      usedPorts.add(port + 1);
      return port;
    }
  }
  throw new Error('No available RTP ports for recording');
}

/**
 * Release a UDP port
 * @param {number} port - Port to release
 */
function releasePort(port) {
  usedPorts.delete(port);
}

/**
 * Generate a unique folder name for a recording
 * @param {string} roomSlug - Room slug
 * @returns {string} Folder name
 */
function generateFolderName(roomSlug) {
  const now = new Date();
  const timestamp = now.toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '_')
    .replace(/\.\d{3}Z$/, '');
  return `${roomSlug}_${timestamp}`;
}

/**
 * Sanitize a name for use as a filename
 * @param {string} name - Name to sanitize
 * @returns {string} Sanitized name
 */
function sanitizeName(name) {
  return (name || 'unknown')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .substring(0, 50);
}

/**
 * Recording session class
 */
class RecordingSession {
  constructor(roomId, roomSlug, recordingId, folderPath) {
    this.roomId = roomId;
    this.roomSlug = roomSlug;
    this.recordingId = recordingId;
    this.folderPath = folderPath;
    this.tracks = new Map(); // producerId -> TrackRecorder
    this.startedAt = new Date();
    this.recovered = false;
  }
}

/**
 * Track recorder class - manages a single producer's recording
 */
class TrackRecorder {
  constructor(producerId, channelName, producerName, segmentPattern, mergedFilePath, trackId, publisherId = null) {
    this.producerId = producerId;
    this.channelName = channelName;
    this.producerName = producerName;
    this.segmentPattern = segmentPattern;
    this.mergedFilePath = mergedFilePath;
    this.trackId = trackId;
    this.publisherId = publisherId;
    this.plainTransport = null;
    this.consumer = null;
    this.ffmpegProcess = null;
    this.rtpPort = null;
    this.sdpPath = null;
  }

  toMetadata() {
    return {
      trackId: this.trackId,
      producerId: this.producerId,
      producerName: this.producerName,
      channelName: this.channelName,
      segmentPattern: this.segmentPattern,
      mergedFilePath: this.mergedFilePath,
      publisherId: this.publisherId
    };
  }

  async start(producer) {
    try {
      // Allocate RTP port for FFmpeg to receive on
      this.rtpPort = allocatePort();

      // Create PlainTransport for consuming the producer
      // rtcpMux: true means RTP and RTCP on same port (simpler)
      this.plainTransport = await router.createPlainTransport({
        listenIp: { ip: '127.0.0.1', announcedIp: null },
        rtcpMux: true,
        comedia: false
      });

      console.log(`PlainTransport created, tuple: ${JSON.stringify(this.plainTransport.tuple)}`);

      // Connect the transport - tells mediasoup where to SEND RTP
      await this.plainTransport.connect({
        ip: '127.0.0.1',
        port: this.rtpPort
      });

      console.log(`PlainTransport connected to 127.0.0.1:${this.rtpPort}`);

      // Create consumer on the PlainTransport
      this.consumer = await this.plainTransport.consume({
        producerId: producer.id,
        rtpCapabilities: router.rtpCapabilities,
        paused: false
      });

      console.log(`Consumer created: id=${this.consumer.id}, paused=${this.consumer.paused}, producerId=${producer.id}`);
      console.log(`Producer state: id=${producer.id}, paused=${producer.paused}, closed=${producer.closed}`);

      // Explicitly resume consumer to ensure RTP flows
      if (this.consumer.paused) {
        await this.consumer.resume();
        console.log(`Consumer resumed`);
      }

      // Ensure output directory exists BEFORE writing any files
      const outputDir = path.dirname(this.segmentPattern);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      // Generate SDP file for FFmpeg
      const sdpContent = this.generateSdp();
      this.sdpPath = this.segmentPattern.replace(/%03d\.ogg$/, 'sdp');
      fs.writeFileSync(this.sdpPath, sdpContent);

      // Log SDP for debugging
      console.log(`SDP for ${this.producerName}:\n${sdpContent}`);

      // Spawn FFmpeg process with segmented output to flush to disk continuously
      this.ffmpegProcess = spawn(FFMPEG_PATH, [
        '-protocol_whitelist', 'file,rtp,udp',
        '-analyzeduration', '10000000',  // 10 seconds
        '-probesize', '5000000',         // 5MB
        '-fflags', '+genpts+discardcorrupt',
        '-i', this.sdpPath,
        '-c:a', 'copy',
        '-f', 'segment',
        '-segment_time', String(RECORDING_SEGMENT_SECONDS),
        '-reset_timestamps', '1',
        '-y',
        this.segmentPattern
      ], {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      this.ffmpegProcess.on('error', (err) => {
        console.error(`FFmpeg error for ${this.producerName}: ${err.message}`);
      });

      this.ffmpegProcess.stderr.on('data', (data) => {
        // Log FFmpeg output for debugging (can be verbose)
        const output = data.toString();
        if (output.includes('error') || output.includes('Error')) {
          console.error(`FFmpeg stderr: ${output}`);
        }
      });

      this.ffmpegProcess.on('close', (code) => {
        console.log(`FFmpeg process exited with code ${code} for ${this.producerName}`);
        // Cleanup SDP file
        if (this.sdpPath && fs.existsSync(this.sdpPath)) {
          fs.unlinkSync(this.sdpPath);
        }
      });

      console.log(`Started recording track: ${this.producerName} -> ${this.segmentPattern}`);
      return true;
    } catch (err) {
      console.error(`Failed to start track recording: ${err.message}`);
      await this.stop();
      throw err;
    }
  }

  generateSdp() {
    const rtpParams = this.consumer.rtpParameters;
    const codec = rtpParams.codecs[0];
    const payloadType = codec.payloadType;

    // Get SSRC from RTP parameters
    const ssrc = rtpParams.encodings?.[0]?.ssrc || 0;

    // SDP requires CRLF line endings
    const lines = [
      'v=0',
      'o=- 0 0 IN IP4 127.0.0.1',
      's=FFmpeg',
      'c=IN IP4 127.0.0.1',
      't=0 0',
      `m=audio ${this.rtpPort} RTP/AVP ${payloadType}`,
      `a=rtpmap:${payloadType} opus/48000/2`,
      `a=fmtp:${payloadType} sprop-stereo=1; stereo=1; useinbandfec=1`,
      'a=recvonly'
    ];

    // Add SSRC if available
    if (ssrc) {
      lines.push(`a=ssrc:${ssrc} cname:recording`);
    }

    // Join with CRLF as per SDP spec
    return lines.join('\r\n') + '\r\n';
  }

  async stop() {
    const now = new Date().toISOString();

    // Stop FFmpeg gracefully
    if (this.ffmpegProcess && !this.ffmpegProcess.killed) {
      this.ffmpegProcess.stdin?.end();
      this.ffmpegProcess.kill('SIGINT');

      // Give FFmpeg time to finalize the file
      await new Promise(resolve => setTimeout(resolve, 1000));

      if (!this.ffmpegProcess.killed) {
        this.ffmpegProcess.kill('SIGKILL');
      }
    }

    let mergedOk = true;
    if (RECORDING_MERGE_ON_STOP) {
      try {
        mergedOk = await this.mergeSegments();
      } catch (err) {
        mergedOk = false;
        console.error(`Failed to merge segments for ${this.producerName}: ${err.message}`);
      }
    }

    // Close consumer
    if (this.consumer && !this.consumer.closed) {
      this.consumer.close();
    }

    // Close transport
    if (this.plainTransport && !this.plainTransport.closed) {
      this.plainTransport.close();
    }

    // Release port
    if (this.rtpPort) {
      releasePort(this.rtpPort);
      releasePort(this.rtpPort + 1); // RTCP port
    }

    // Update database
    if (this.trackId) {
      updateRecordingTrackStatus(this.trackId, mergedOk ? 'stopped' : 'error', now);
    }

    console.log(`Stopped recording track: ${this.producerName}`);
  }

  async mergeSegments() {
    const outputDir = path.dirname(this.segmentPattern);
    const baseName = path.basename(this.segmentPattern).replace(/_%03d\.ogg$/, '');
    const segmentRegex = new RegExp(`^${baseName}_(\\d{3})\\.ogg$`);
    const entries = fs.readdirSync(outputDir)
      .filter(name => segmentRegex.test(name))
      .sort()
      .filter(name => {
        const filePath = path.join(outputDir, name);
        try {
          const stat = fs.statSync(filePath);
          return stat.isFile() && stat.size > 0;
        } catch {
          return false;
        }
      });

    if (entries.length === 0) {
      console.warn(`No segments found for ${this.producerName}, skip merge`);
      return false;
    }

    const listPath = path.join(outputDir, `${baseName}_concat.txt`);
    const listContent = entries.map(name => `file '${path.join(outputDir, name)}'`).join('\n') + '\n';
    fs.writeFileSync(listPath, listContent);

    await new Promise((resolve, reject) => {
      const proc = spawn(FFMPEG_PATH, [
        '-f', 'concat',
        '-safe', '0',
        '-i', listPath,
        '-c', 'copy',
        '-y',
        this.mergedFilePath
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      let stderr = '';
      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr || `ffmpeg concat exited with code ${code}`));
      });
    });

    if (fs.existsSync(listPath)) {
      fs.unlinkSync(listPath);
    }

    if (RECORDING_DELETE_SEGMENTS_AFTER_MERGE) {
      for (const name of entries) {
        const segmentPath = path.join(outputDir, name);
        if (fs.existsSync(segmentPath)) {
          fs.unlinkSync(segmentPath);
        }
      }
    }

    return true;
  }
}

/**
 * Start recording for a room
 * @param {string} roomSlug - Room slug
 * @param {number} roomId - Room ID
 * @param {number} tenantId - Tenant ID
 * @returns {object} Recording session info
 */
export async function startRecording(roomSlug, roomId, tenantId) {
  if (blockedRecordings.has(roomId)) {
    throw new Error('Recording session is currently owned by another live process');
  }

  // Check if already recording
  const existing = activeRecordings.get(roomId);
  if (existing) {
    throw new Error('Recording already in progress for this room');
  }

  const activeDbRecording = getActiveRecordingByRoomId(roomId);
  if (activeDbRecording) {
    throw new Error('Recording already in progress for this room');
  }

  // Generate folder name and create directory
  const folderName = generateFolderName(roomSlug);
  const folderPath = path.join(RECORDING_DIR, folderName);
  fs.mkdirSync(folderPath, { recursive: true });

  // Create recording in database
  const recording = createRecording(roomId, folderName);

  // Create session (store tenantId for notifications)
  const session = new RecordingSession(roomId, roomSlug, recording.id, folderPath);
  session.tenantId = tenantId;
  activeRecordings.set(roomId, session);
  persistSessionLock(session, 'recording');

  // Find all active producers for this room and start recording them
  const roomChannelPrefix = `${roomSlug}:`;
  let tracksStarted = 0;
  const tracks = [];

  for (const [channelId, channel] of channels) {
    // Check if this channel belongs to the room
    if (!channelId.startsWith(roomChannelPrefix)) continue;

    const channelName = channelId.substring(roomChannelPrefix.length);

    for (const [producerId, producerInfo] of channel.producers) {
      try {
        const trackInfo = await addProducerToRecording(roomId, producerId, channelName, producerInfo, session);
        if (trackInfo) tracks.push(trackInfo);
        tracksStarted++;
      } catch (err) {
        console.error(`Failed to start recording for producer ${producerId}: ${err.message}`);
      }
    }
  }

  // Write initial metadata
  writeMetadata(session);
  persistSessionLock(session, 'recording');

  console.log(`Started recording for room ${roomSlug}: ${tracksStarted} track(s)`);

  const result = {
    recordingId: recording.id,
    folderName,
    startedAt: recording.started_at,
    trackCount: tracksStarted,
    recovered: false,
    tracks
  };

  // Notify about recording status change
  if (onStatusChange) {
    onStatusChange(tenantId, roomSlug, {
      isRecording: true,
      ...result
    });
  }

  return result;
}

/**
 * Add a producer to an active recording session
 * @param {number} roomId - Room ID
 * @param {string} producerId - Producer ID (our internal UUID)
 * @param {string} channelName - Channel name
 * @param {object} producerInfo - Producer info with { transport, producer, clientId }
 * @param {RecordingSession} session - Optional session (if not provided, will look up)
 */
export async function addProducerToRecording(roomId, producerId, channelName, producerInfo, session = null) {
  session = session || activeRecordings.get(roomId);
  if (!session) return;

  // Skip if already recording this producer
  if (session.tracks.has(producerId)) {
    return session.tracks.get(producerId).toMetadata();
  }

  const producer = producerInfo.producer;
  if (!producer || producer.closed) return;

  // Use publisher's configured channel as the source of truth when available.
  // This prevents misrouting if a client sends an incorrect channelId during signaling.
  let resolvedChannelName = channelName;
  if (producerInfo.publisherId) {
    const publisher = getPublisherById(producerInfo.publisherId);
    if (publisher?.channel_name) {
      resolvedChannelName = publisher.channel_name;
    }
  }

  // Get producer name from client info or use generic name
  const producerName = producerInfo.name || `producer_${Date.now()}`;
  const sanitizedName = sanitizeName(producerName);
  const sanitizedChannel = sanitizeName(resolvedChannelName);

  // Create output path
  const baseName = `${sanitizedName}_${Date.now()}`;
  const channelDir = path.join(session.folderPath, sanitizedChannel);
  const segmentPattern = path.join(channelDir, `${baseName}_%03d.ogg`);
  const mergedFilePath = path.join(channelDir, `${baseName}.ogg`);
  const relativePath = path.join(sanitizedChannel, `${baseName}.ogg`);

  // Create track in database
  const track = createRecordingTrack(
    session.recordingId,
    resolvedChannelName,
    producerId,
    producerName,
    relativePath
  );

  // Create and start track recorder
  const trackRecorder = new TrackRecorder(
    producerId,
    resolvedChannelName,
    producerName,
    segmentPattern,
    mergedFilePath,
    track.id,
    producerInfo.publisherId || null
  );

  try {
    await trackRecorder.start(producer);
    session.tracks.set(producerId, trackRecorder);

    // Update metadata
    writeMetadata(session);
    persistSessionLock(session, 'recording');
    return trackRecorder.toMetadata();
  } catch (err) {
    updateRecordingTrackStatus(track.id, 'error', new Date().toISOString());
    throw err;
  }
}

/**
 * Remove a producer from an active recording
 * @param {number} roomId - Room ID
 * @param {string} producerId - Producer ID
 */
export async function removeProducerFromRecording(roomId, producerId) {
  const session = activeRecordings.get(roomId);
  if (!session) return;

  const trackRecorder = session.tracks.get(producerId);
  if (!trackRecorder) return;

  await trackRecorder.stop();
  session.tracks.delete(producerId);

  // Update metadata
  writeMetadata(session);
  persistSessionLock(session, 'recording');

  console.log(`Removed producer ${producerId} from recording for room ${session.roomSlug}`);
}

/**
 * Stop recording for a room
 * @param {string} roomSlug - Room slug
 * @param {number} roomId - Room ID
 * @returns {object} Recording summary
 */
export async function stopRecording(roomSlug, roomId) {
  const session = activeRecordings.get(roomId);
  if (!session && blockedRecordings.has(roomId)) {
    throw new Error('Recording session is currently owned by another live process');
  }
  if (!session) {
    throw new Error('No active recording for this room');
  }

  const tenantId = session.tenantId;

  // Stop all tracks
  const trackCount = session.tracks.size;
  for (const [producerId, trackRecorder] of session.tracks) {
    await trackRecorder.stop();
  }
  session.tracks.clear();

  // Update database
  const now = new Date().toISOString();
  stopAllTracksForRecording(session.recordingId);
  const recording = updateRecordingStatus(session.recordingId, 'stopped', now);

  // Final metadata update
  writeMetadata(session, true);
  persistSessionLock(session, 'stopped');
  removeSessionLock(session);

  // Remove session
  activeRecordings.delete(roomId);

  console.log(`Stopped recording for room ${roomSlug}: ${trackCount} track(s)`);

  const result = {
    recordingId: recording.id,
    folderName: recording.folder_name,
    startedAt: recording.started_at,
    stoppedAt: recording.stopped_at,
    trackCount,
    recovered: Boolean(session.recovered)
  };

  // Notify about recording status change
  if (onStatusChange && tenantId) {
    onStatusChange(tenantId, roomSlug, {
      isRecording: false,
      ...result
    });
  }

  return result;
}

/**
 * Write metadata JSON file for a recording session
 * @param {RecordingSession} session - Recording session
 * @param {boolean} final - Is this the final write (recording stopped)
 */
function writeMetadata(session, final = false) {
  const tracks = listTracksByRecordingId(session.recordingId);

  // Organize tracks by channel
  const channelTracks = {};
  for (const track of tracks) {
    if (!channelTracks[track.channel_name]) {
      channelTracks[track.channel_name] = [];
    }
    channelTracks[track.channel_name].push({
      producerName: track.producer_name,
      fileName: path.basename(track.file_path),
      status: track.status,
      startedAt: track.started_at,
      stoppedAt: track.stopped_at
    });
  }

  const metadata = {
    recordingId: session.recordingId,
    roomSlug: session.roomSlug,
    startedAt: session.startedAt.toISOString(),
    stoppedAt: final ? new Date().toISOString() : null,
    status: final ? 'stopped' : 'recording',
    channels: channelTracks
  };

  const metadataPath = path.join(session.folderPath, 'metadata.json');
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
}

/**
 * Check if a room is currently being recorded
 * @param {number} roomId - Room ID
 * @returns {boolean}
 */
export function isRecording(roomId) {
  return activeRecordings.has(roomId) || blockedRecordings.has(roomId);
}

/**
 * Get recording status for a room
 * @param {number} roomId - Room ID
 * @returns {object|null} Recording status or null if not recording
 */
export function getRecordingStatus(roomId) {
  const blocked = blockedRecordings.get(roomId);
  if (blocked) {
    const dbRecording = getRecordingById(blocked.recordingId);
    if (!dbRecording || dbRecording.status !== 'recording') {
      blockedRecordings.delete(roomId);
    } else {
      return {
        isRecording: true,
        recordingId: blocked.recordingId,
        folderName: blocked.folderName,
        startedAt: blocked.startedAt,
        trackCount: 0,
        tracks: [],
        recovered: false,
        unavailable: true,
        unavailableReason: blocked.reason
      };
    }
  }

  const session = activeRecordings.get(roomId);
  if (!session) {
    return null;
  }

  return {
    isRecording: true,
    recordingId: session.recordingId,
    folderName: path.basename(session.folderPath),
    startedAt: session.startedAt.toISOString(),
    trackCount: session.tracks.size,
    recovered: Boolean(session.recovered),
    tracks: Array.from(session.tracks.values()).map(t => ({
      channelName: t.channelName,
      producerName: t.producerName
    }))
  };
}

/**
 * Get all active recordings mapped by roomId
 * @returns {Map} Active recordings map
 */
export function getActiveRecordings() {
  return activeRecordings;
}

export default {
  initRecorder,
  recoverRecordingSessions,
  startRecording,
  stopRecording,
  addProducerToRecording,
  removeProducerFromRecording,
  isRecording,
  getRecordingStatus,
  getActiveRecordings
};
