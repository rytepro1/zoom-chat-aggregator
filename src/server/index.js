import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import webhookRoutes from '../routes/webhook.js';
import authRouter from '../routes/auth.js';
import { setupSocketHandlers } from './socketHandler.js';
import { RosterManager } from '../services/RosterManager.js';
import { OrgState } from '../services/OrgState.js';
import { RTMSManager } from '../rtms/RTMSManager.js';
import { RecallBotManager } from '../recall/RecallBotManager.js';
import { initDatabase } from '../db/index.js';
import { attachUser, requireAuth } from '../auth/middleware.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: process.env.NODE_ENV === 'production'
      ? true
      : ['http://localhost:5173', 'http://localhost:3000'],
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Singletons that aren't per-org:
//   - rosterManager (CRUD layer; orgId passed per-call)
//   - recallBotManager (one Recall workspace, bot records carry orgId)
//   - rtmsManager (legacy fallback; kept alive for the unused Zoom webhook path)
//   - orgState (lazy per-org MessageAggregator + SessionManager)
const rosterManager = new RosterManager();
const rtmsManager = new RTMSManager();
const recallBotManager = new RecallBotManager({
  apiKey: process.env.RECALL_API_KEY,
  apiBase: process.env.RECALL_API_BASE,
  publicWebhookUrl: process.env.PUBLIC_WEBHOOK_URL,
});
const useRecall = recallBotManager.isConfigured();
const orgState = new OrgState({ io });

app.set('rosterManager', rosterManager);
app.set('rtmsManager', rtmsManager);
app.set('recallBotManager', recallBotManager);
app.set('orgState', orgState);
app.set('io', io);

// ---- Middleware ----
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? true
    : ['http://localhost:5173', 'http://localhost:3000'],
  credentials: true,
}));
app.use(cookieParser());
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Soft-attach req.user / req.org if a valid session cookie is present.
app.use((req, res, next) => {
  const db = app.get('db');
  if (!db) return next();
  return attachUser(db)(req, res, next);
});

// ---- Public routes (no auth) ----

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/status', (req, res) => {
  res.json({
    botPath: useRecall ? 'recall' : 'rtms-mock',
    recall: {
      configured: recallBotManager.isConfigured(),
      apiBase: recallBotManager.apiBase,
      publicWebhookUrl: recallBotManager.publicWebhookUrl,
      webhookSignatureEnforced: Boolean(process.env.RECALL_WEBHOOK_SECRET),
      activeBots: recallBotManager.getActiveConnections().length,
    },
    rtms: {
      mockMode: rtmsManager.useMockMode,
      activeConnections: rtmsManager.getActiveConnections().length,
    },
  });
});

// Webhook routes (HMAC-verified, never user-authenticated)
app.use('/webhook', webhookRoutes);

// Auth routes (signup, login, logout, /me, verify-email, password-reset)
app.use('/api/auth', authRouter());

// ---- Authenticated /api/* routes ----
//
// Everything below this line requires a valid session AND uses req.org.id
// for org isolation. Per-org runtime state comes from
// `await orgState.get(req.org.id)`.

app.use('/api', requireAuth);

// Helper to grab the requesting user's org state on demand.
async function org(req) {
  return orgState.get(req.org.id);
}

// ---- Meetings ----

app.get('/api/meetings', async (req, res) => {
  const connections = useRecall
    ? recallBotManager.getActiveConnections(req.org.id)
    : rtmsManager.getActiveConnections();
  res.json({
    meetings: connections.map(conn => ({
      id: conn.meetingId,
      meetingId: conn.meetingId,
      roomName: conn.roomName,
      status: 'connected',
      isMock: conn.isMock,
      connectedAt: conn.connectedAt,
    })),
  });
});

app.post('/api/meetings/connect', async (req, res) => {
  const { meetingId, passcode, roomName, roomColor, botName } = req.body;
  if (!meetingId) return res.status(400).json({ error: 'Meeting ID is required' });
  if (useRecall && (!botName || !String(botName).trim())) {
    return res.status(400).json({
      error: 'Bot Display Name is required — this is how the bot will appear to participants.',
    });
  }

  const cleanMeetingId = meetingId.replace(/[\s-]/g, '');
  const finalRoomName = roomName || `Meeting ${cleanMeetingId}`;
  const finalRoomColor = roomColor || '#ef4444';

  try {
    const { ma } = await org(req);
    if (useRecall) {
      // RecallBotManager needs orgState wired so handleChatEvent can
      // route inbound webhooks to the right org's MA.
      recallBotManager.orgState = orgState;
      recallBotManager.db = app.get('db');
      await recallBotManager.connect(req.org.id, cleanMeetingId, passcode, finalRoomName, finalRoomColor, botName);
    } else {
      await rtmsManager.connect(cleanMeetingId, null, finalRoomName, finalRoomColor);
    }

    ma.addRoom({
      id: cleanMeetingId,
      name: finalRoomName,
      color: finalRoomColor,
      participantCount: 0,
    });

    const isMock = useRecall ? false : rtmsManager.useMockMode;
    io.to(`org:${req.org.id}`).emit('meetingConnected', {
      id: cleanMeetingId,
      meetingId: cleanMeetingId,
      roomName: finalRoomName,
      roomColor: finalRoomColor,
      status: 'connected',
      isMock,
    });

    const message = useRecall
      ? 'Bot dispatched to meeting via Recall.ai'
      : (rtmsManager.useMockMode ? 'Connected in mock mode' : 'Connected to meeting stream');
    res.json({ success: true, id: cleanMeetingId, message, isMock });
  } catch (error) {
    console.error('Failed to connect to meeting:', error);
    res.status(500).json({ error: error.message || 'Failed to connect to meeting' });
  }
});

app.post('/api/meetings/:id/disconnect', async (req, res) => {
  const { id } = req.params;
  try {
    const { ma } = await org(req);
    if (useRecall) {
      await recallBotManager.disconnect(req.org.id, id);
    } else {
      rtmsManager.disconnect(id);
    }
    ma.removeRoom(id);
    io.to(`org:${req.org.id}`).emit('meetingDisconnected', { id });
    res.json({ success: true, message: 'Disconnected from meeting' });
  } catch (error) {
    console.error('Failed to disconnect from meeting:', error);
    res.status(500).json({ error: error.message || 'Failed to disconnect' });
  }
});

// ---- Sessions ----

app.get('/api/sessions/current', async (req, res) => {
  const { sm } = await org(req);
  res.json({ session: sm.getCurrent() });
});

app.patch('/api/sessions/current', async (req, res) => {
  const name = req.body?.name;
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  try {
    const { sm } = await org(req);
    const session = await sm.rename(name);
    res.json({ session });
  } catch (err) {
    console.error('PATCH /api/sessions/current failed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions', async (req, res) => {
  try {
    const { sm } = await org(req);
    const sessions = await sm.list({ limit: 100 });
    res.json({ sessions });
  } catch (err) {
    console.error('GET /api/sessions failed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sessions/end', async (req, res) => {
  try {
    const { sm, ma } = await org(req);
    const newSession = await sm.end({ newSessionName: req.body?.newSessionName });
    ma.clearMessages();
    res.json({ session: newSession });
  } catch (err) {
    console.error('POST /api/sessions/end failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Saved messages ----

app.post('/api/messages/:id/save', async (req, res) => {
  const { id } = req.params;
  const note = req.body?.note ?? null;
  try {
    const { ma } = await org(req);
    const message = await ma.setSaved(id, true, note);
    if (!message) return res.status(404).json({ error: 'Message not found' });
    res.json({ message });
  } catch (err) {
    console.error(`POST /api/messages/${id}/save failed:`, err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/messages/:id/save', async (req, res) => {
  const { id } = req.params;
  try {
    const { ma } = await org(req);
    const message = await ma.setSaved(id, false, null);
    if (!message) return res.status(404).json({ error: 'Message not found' });
    res.json({ message });
  } catch (err) {
    console.error(`DELETE /api/messages/${id}/save failed:`, err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/saved', async (req, res) => {
  const sessionId = req.query.session_id || undefined;
  try {
    const { ma } = await org(req);
    const messages = await ma.getSavedMessages({ sessionId });
    res.json({ messages });
  } catch (err) {
    console.error('GET /api/saved failed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/saved/export.csv', async (req, res) => {
  const sessionId = req.query.session_id || undefined;
  try {
    const { ma } = await org(req);
    const messages = await ma.getSavedMessages({ sessionId });
    const rows = [
      ['timestamp', 'room', 'sender', 'content', 'note'],
      ...messages.map(m => [m.timestamp, m.room, m.sender, m.content, m.note || '']),
    ];
    const csv = rows.map(row => row.map(csvEscape).join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="zoomchat-saved.csv"');
    res.send(csv);
  } catch (err) {
    console.error('GET /api/saved/export.csv failed:', err);
    res.status(500).json({ error: err.message });
  }
});

function csvEscape(value) {
  if (value == null) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// ---- Outbound chat ----

app.post('/api/meetings/:meetingId/reply', async (req, res) => {
  if (!useRecall) {
    return res.status(503).json({ error: 'Sending chat requires the Recall path (currently in mock mode).' });
  }
  const { meetingId } = req.params;
  const text = req.body?.text;
  try {
    const { ma } = await org(req);
    const result = await recallBotManager.sendChatToMeeting(req.org.id, meetingId, text);
    const botInfo = recallBotManager.botsByMeeting.get(meetingId);
    if (botInfo) {
      await ma.addMessage({
        sender: botInfo.botName,
        content: text,
        room: botInfo.roomName,
        roomColor: botInfo.roomColor,
        meetingId,
        timestamp: new Date().toISOString(),
        type: 'reply',
      });
    }
    res.json({ success: true, ...result });
  } catch (err) {
    console.error(`POST /api/meetings/${meetingId}/reply failed:`, err.message);
    const status = /rate limit/i.test(err.message)
      ? 429
      : /no active bot|does not belong|required/i.test(err.message)
        ? 400
        : 500;
    res.status(status).json({ error: err.message });
  }
});

app.post('/api/broadcast', async (req, res) => {
  if (!useRecall) {
    return res.status(503).json({ error: 'Broadcast requires the Recall path (currently in mock mode).' });
  }
  const text = req.body?.text;
  try {
    const { ma } = await org(req);
    const results = await recallBotManager.broadcastChat(req.org.id, text);
    for (const r of results) {
      if (!r.ok) continue;
      const botInfo = recallBotManager.botsByMeeting.get(r.meetingId);
      if (!botInfo) continue;
      await ma.addMessage({
        sender: botInfo.botName,
        content: text,
        room: botInfo.roomName,
        roomColor: botInfo.roomColor,
        meetingId: r.meetingId,
        timestamp: new Date().toISOString(),
        type: 'broadcast',
      });
    }
    res.json({
      success: true,
      sent: results.filter(r => r.ok).length,
      failed: results.filter(r => !r.ok).length,
      results,
    });
  } catch (err) {
    console.error('POST /api/broadcast failed:', err.message);
    res.status(/no active bots|required/i.test(err.message) ? 400 : 500)
       .json({ error: err.message });
  }
});

// ---- Rosters ----

app.get('/api/rosters', async (req, res) => {
  if (!rosterManager.isAvailable()) return res.json({ rosters: [] });
  try {
    res.json({ rosters: await rosterManager.list(req.org.id) });
  } catch (err) {
    console.error('GET /api/rosters failed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/rosters/:id', async (req, res) => {
  try {
    const roster = await rosterManager.get(req.org.id, req.params.id);
    if (!roster) return res.status(404).json({ error: 'Roster not found' });
    res.json({ roster });
  } catch (err) {
    console.error(`GET /api/rosters/${req.params.id} failed:`, err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/rosters', async (req, res) => {
  if (!rosterManager.isAvailable()) {
    return res.status(503).json({ error: 'Roster storage requires the database.' });
  }
  const { name, entries = [] } = req.body || {};
  try {
    rosterManager.validateEntries(entries);
    const roster = await rosterManager.create(req.org.id, { name, entries });
    res.status(201).json({ roster });
  } catch (err) {
    console.error('POST /api/rosters failed:', err);
    res.status(/required|empty|invalid/i.test(err.message) ? 400 : 500)
       .json({ error: err.message });
  }
});

app.patch('/api/rosters/:id', async (req, res) => {
  if (!rosterManager.isAvailable()) {
    return res.status(503).json({ error: 'Roster storage requires the database.' });
  }
  const { name, entries } = req.body || {};
  try {
    if (Array.isArray(entries)) rosterManager.validateEntries(entries);
    const roster = await rosterManager.update(req.org.id, req.params.id, { name, entries });
    if (!roster) return res.status(404).json({ error: 'Roster not found' });
    res.json({ roster });
  } catch (err) {
    console.error(`PATCH /api/rosters/${req.params.id} failed:`, err);
    res.status(/required|empty|invalid/i.test(err.message) ? 400 : 500)
       .json({ error: err.message });
  }
});

app.delete('/api/rosters/:id', async (req, res) => {
  if (!rosterManager.isAvailable()) {
    return res.status(503).json({ error: 'Roster storage requires the database.' });
  }
  try {
    const removed = await rosterManager.delete(req.org.id, req.params.id);
    if (!removed) return res.status(404).json({ error: 'Roster not found' });
    res.json({ success: true });
  } catch (err) {
    console.error(`DELETE /api/rosters/${req.params.id} failed:`, err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/rosters/:id/deploy', async (req, res) => {
  if (!useRecall) {
    return res.status(503).json({ error: 'Deploy requires the Recall path (currently in mock mode).' });
  }
  try {
    const { ma } = await org(req);
    const roster = await rosterManager.get(req.org.id, req.params.id);
    if (!roster) return res.status(404).json({ error: 'Roster not found' });
    if (roster.entries.length === 0) {
      return res.status(400).json({ error: 'Roster has no meetings to deploy' });
    }

    recallBotManager.orgState = orgState;
    recallBotManager.db = app.get('db');

    const results = await Promise.allSettled(
      roster.entries.map(async (entry) => {
        await recallBotManager.connect(
          req.org.id,
          entry.meeting_id,
          entry.passcode,
          entry.room_name,
          entry.room_color,
          entry.bot_name
        );
        ma.addRoom({
          id: entry.meeting_id,
          name: entry.room_name,
          color: entry.room_color,
          participantCount: 0,
        });
        io.to(`org:${req.org.id}`).emit('meetingConnected', {
          id: entry.meeting_id,
          meetingId: entry.meeting_id,
          roomName: entry.room_name,
          roomColor: entry.room_color,
          status: 'connected',
          isMock: false,
        });
        return { meetingId: entry.meeting_id, roomName: entry.room_name };
      })
    );

    const detailed = results.map((r, i) => ({
      meetingId: roster.entries[i].meeting_id,
      roomName: roster.entries[i].room_name,
      ok: r.status === 'fulfilled',
      error: r.status === 'rejected' ? (r.reason?.message || String(r.reason)) : null,
    }));
    res.json({
      total: roster.entries.length,
      succeeded: detailed.filter(d => d.ok).length,
      failed: detailed.filter(d => !d.ok).length,
      results: detailed,
    });
  } catch (err) {
    console.error(`POST /api/rosters/${req.params.id}/deploy failed:`, err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Static client ----

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(join(__dirname, '../../client/dist')));
  app.get('*', (req, res) => {
    res.sendFile(join(__dirname, '../../client/dist/index.html'));
  });
}

const PORT = process.env.PORT || 3001;

async function start() {
  const db = await initDatabase({ databaseUrl: process.env.DATABASE_URL });
  app.set('db', db);
  orgState.db = db;
  rosterManager.db = db;
  recallBotManager.db = db;
  recallBotManager.orgState = orgState;

  // Register Socket.io handlers now that `db` is available (the auth
  // middleware needs it on every handshake).
  setupSocketHandlers(io, { db, orgState });

  httpServer.listen(PORT, () => {
    const botPath = useRecall ? 'Recall.ai' : `RTMS (${rtmsManager.useMockMode ? 'mock' : 'live'})`;
    const persistence = db ? 'Postgres' : 'in-memory only';
    console.log(`
╔════════════════════════════════════════════════════════════╗
║         Zoom Chat Aggregator — Phase 2                     ║
╠════════════════════════════════════════════════════════════╣
║  Server:        http://localhost:${PORT}                       ║
║  Health:        http://localhost:${PORT}/health                ║
║  Bot path:      ${botPath.padEnd(44)}║
║  Persistence:   ${persistence.padEnd(44)}║
║  Auth:          required on /api/* (except /api/auth/*)    ║
╚════════════════════════════════════════════════════════════╝
    `);
  });
}

start().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

export { app, io };
