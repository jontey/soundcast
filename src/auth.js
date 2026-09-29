import { randomBytes, timingSafeEqual } from 'crypto';
import { getRoomBySlug, verifyRoomPin } from './db/models/room.js';

const sessions = new Map();
const attempts = new Map();
const SESSION_MS = 12 * 60 * 60 * 1000;
const WINDOW_MS = 5 * 60 * 1000;

function equalSecret(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function cookieValue(request) {
  const cookie = request.headers.cookie || '';
  const match = cookie.match(/(?:^|;\s*)soundcast_session=([a-f0-9]{64})(?:;|$)/);
  return match?.[1];
}

export function currentSession(request) {
  const key = cookieValue(request);
  const session = key && sessions.get(key);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(key);
    return null;
  }
  if (session.role === 'room' && !getRoomBySlug(session.roomSlug)) {
    sessions.delete(key);
    return null;
  }
  return session;
}

function setSession(request, reply, identity) {
  const key = randomBytes(32).toString('hex');
  sessions.set(key, { ...identity, expiresAt: Date.now() + SESSION_MS });
  const secure = request.protocol === 'https' ? '; Secure' : '';
  reply.header('Set-Cookie', `soundcast_session=${key}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${secure}`);
}

function rateLimited(request) {
  const ip = request.ip || 'unknown';
  const now = Date.now();
  const state = attempts.get(ip);
  return Boolean(state && now - state.startedAt <= WINDOW_MS && state.count >= 8);
}

function recordFailure(request) {
  const ip = request.ip || 'unknown';
  const now = Date.now();
  const state = attempts.get(ip);
  if (!state || now - state.startedAt > WINDOW_MS) attempts.set(ip, { count: 1, startedAt: now });
  else state.count++;
}

export function canAccessRoom(session, slug) {
  return Boolean(session && !session.revoked && (session.role === 'admin' || (session.role === 'room' && session.roomSlug === slug)));
}

export function revokeRoomSessions(slug) {
  for (const [key, session] of sessions) {
    if (session.role === 'room' && session.roomSlug === slug) {
      session.revoked = true;
      sessions.delete(key);
    }
  }
}

export function registerAuthRoutes(fastify) {
  fastify.post('/api/auth/login', async (request, reply) => {
    if (rateLimited(request)) return reply.code(429).send({ message: 'Too many attempts. Try again in five minutes.' });
    const { role, password, room_slug: roomSlug, pin } = request.body || {};
    if (role === 'admin') {
      const configured = process.env.ADMIN_PASSWORD;
      if (!configured || !equalSecret(password || '', configured)) {
        recordFailure(request);
        return reply.code(401).send({ message: 'Incorrect password' });
      }
      attempts.delete(request.ip || 'unknown');
      setSession(request, reply, { role: 'admin' });
      return { role: 'admin' };
    }
    if (role === 'room' && typeof roomSlug === 'string' && typeof pin === 'string') {
      const roomId = verifyRoomPin(roomSlug, pin);
      if (!roomId) {
        recordFailure(request);
        return reply.code(401).send({ message: 'Incorrect room or PIN' });
      }
      attempts.delete(request.ip || 'unknown');
      setSession(request, reply, { role: 'room', roomSlug, roomId });
      return { role: 'room', roomSlug };
    }
    return reply.code(400).send({ message: 'Choose admin or room sign in' });
  });

  fastify.get('/api/auth/me', async (request, reply) => {
    const session = currentSession(request);
    if (!session) return reply.code(401).send({ message: 'Sign in required' });
    return { role: session.role, roomSlug: session.roomSlug || null };
  });

  fastify.post('/api/auth/logout', async (request, reply) => {
    const key = cookieValue(request);
    if (key) sessions.delete(key);
    reply.header('Set-Cookie', 'soundcast_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    return { ok: true };
  });
}

export async function requireAdmin(request, reply) {
  if (currentSession(request)?.role !== 'admin') return reply.code(401).send({ message: 'Admin sign in required' });
}

export async function authorizeRoomApi(request, reply) {
  if (request.url.split('?')[0] === '/api/config') return;
  const session = currentSession(request);
  if (!session) return reply.code(401).send({ message: 'Sign in required' });
  const path = request.url.split('?')[0];
  if (session.role === 'admin') return;
  const match = path.match(/^\/api\/rooms\/([^/]+)(?:\/|$)/);
  if (!match || decodeURIComponent(match[1]) !== session.roomSlug) {
    return reply.code(403).send({ message: 'This room is outside your access' });
  }
  if (path.endsWith('/access') || (path === `/api/rooms/${match[1]}` && request.method !== 'GET')) {
    return reply.code(403).send({ message: 'Owner access required' });
  }
}
