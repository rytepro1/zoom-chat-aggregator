import cookie from 'cookie';
import { COOKIE_NAME, validateSession } from '../auth/sessions.js';

/**
 * Socket.io setup: auth gate + per-org room subscription + moderation
 * state that's namespaced by org.
 *
 * Auth: on connect, parse the session cookie out of the handshake
 * headers and validate it. Reject connections without a valid session.
 *
 * Org isolation: each socket auto-joins `org:<id>` so emits like
 * `io.to('org:<id>').emit('newMessage', m)` reach only that org's
 * connected clients. Meeting-room subscriptions are namespaced by org
 * too (`org:<id>:room:<meetingId>`) to prevent collisions.
 *
 * Moderation state (featured message / highlight list / queue) is now
 * per-org. Each org sees its own.
 */

const moderationStateByOrg = new Map();
function getModerationState(orgId) {
  if (!moderationStateByOrg.has(orgId)) {
    moderationStateByOrg.set(orgId, {
      highlightedIds: [],
      queue: [],
      featuredMessage: null,
    });
  }
  return moderationStateByOrg.get(orgId);
}

export function setupSocketHandlers(io, { db, orgState }) {
  // ---- Auth middleware ----
  io.use(async (socket, next) => {
    if (!db) return next(new Error('Server not configured for sessions'));
    try {
      const rawCookie = socket.handshake.headers.cookie || '';
      const cookies = cookie.parse(rawCookie);
      const sessionId = cookies[COOKIE_NAME];
      if (!sessionId) return next(new Error('Not signed in'));
      const session = await validateSession(db, sessionId);
      if (!session) return next(new Error('Session expired'));
      socket.data.user = session.user;
      socket.data.org = session.org;
      return next();
    } catch (err) {
      console.error('[socket auth] error:', err.message);
      return next(new Error('Auth check failed'));
    }
  });

  io.on('connection', async (socket) => {
    const orgId = socket.data.org.id;
    socket.join(`org:${orgId}`);
    console.log(`[socket] connected ${socket.id} as ${socket.data.user.email} (${orgId})`);

    // Hydrate this client with its org's state.
    let entry;
    try {
      entry = await orgState.get(orgId);
    } catch (err) {
      console.error(`[socket] failed to init org state for ${orgId}:`, err);
      socket.emit('serverError', { error: 'Failed to load workspace' });
      return;
    }
    const { ma } = entry;

    socket.emit('initialState', {
      messages: ma.getRecentMessages(100),
      rooms: ma.getRooms(),
      stats: ma.getStats(),
    });

    socket.on('getHistory', (options = {}) => {
      const { limit = 100, room = null } = options;
      const messages = room ? ma.getMessagesByRoom(room, limit) : ma.getRecentMessages(limit);
      socket.emit('history', { messages });
    });

    socket.on('getRooms', () => {
      socket.emit('rooms', { rooms: ma.getRooms() });
    });

    socket.on('getStats', () => {
      socket.emit('stats', { stats: ma.getStats() });
    });

    // Per-org room subscriptions are namespaced so meeting-id collisions
    // across orgs can never cross-contaminate.
    socket.on('subscribeToRoom', (roomId) => {
      socket.join(`org:${orgId}:room:${roomId}`);
    });
    socket.on('unsubscribeFromRoom', (roomId) => {
      socket.leave(`org:${orgId}:room:${roomId}`);
    });

    // ---- Moderation (per-org) ----
    socket.on('getModerationState', () => {
      socket.emit('moderationState', getModerationState(orgId));
    });
    socket.on('moderationUpdate', (update) => {
      const state = getModerationState(orgId);
      if (update.highlightedIds !== undefined) state.highlightedIds = update.highlightedIds;
      if (update.queue !== undefined) state.queue = update.queue;
      if (update.featuredMessage !== undefined) state.featuredMessage = update.featuredMessage;
      io.to(`org:${orgId}`).emit('moderationUpdate', update);
    });

    socket.on('disconnect', () => {
      console.log(`[socket] disconnected ${socket.id} (${socket.data.user.email})`);
    });
  });
}
