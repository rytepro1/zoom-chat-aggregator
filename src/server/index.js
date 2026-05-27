import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import webhookRoutes from '../routes/webhook.js';
import { setupSocketHandlers } from './socketHandler.js';
import { MessageAggregator } from '../services/MessageAggregator.js';
import { SessionManager } from '../services/SessionManager.js';
import { RTMSManager } from '../rtms/RTMSManager.js';
import { RecallBotManager } from '../recall/RecallBotManager.js';
import { initDatabase } from '../db/index.js';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const httpServer = createServer(app);

// Initialize Socket.io
const io = new Server(httpServer, {
  cors: {
    origin: process.env.NODE_ENV === 'production'
      ? true  // Allow same-origin in production
      : ['http://localhost:5173', 'http://localhost:3000'],
    methods: ['GET', 'POST']
  }
});

// Initialize message aggregator + session manager. The DB connection and
// session hydration happen asynchronously in start() below; the
// aggregator's `db` and `sessionManager` fields get patched in once
// they're ready. addMessage() guards on those being present, so messages
// arriving during the brief startup window are still served live —
// they just won't be persisted (and will fall out of the in-memory ring
// when 500 newer ones arrive).
const messageAggregator = new MessageAggregator(io);
const sessionManager = new SessionManager({ io });

// Initialize RTMS manager (legacy / mock fallback)
const rtmsManager = new RTMSManager(messageAggregator);

// Initialize Recall.ai bot manager. Active only when both RECALL_API_KEY
// and PUBLIC_WEBHOOK_URL are configured; otherwise we fall back to RTMS.
const recallBotManager = new RecallBotManager({
  messageAggregator,
  apiKey: process.env.RECALL_API_KEY,
  apiBase: process.env.RECALL_API_BASE,
  publicWebhookUrl: process.env.PUBLIC_WEBHOOK_URL,
});
const useRecall = recallBotManager.isConfigured();

// Make managers available to routes
app.set('messageAggregator', messageAggregator);
app.set('sessionManager', sessionManager);
app.set('rtmsManager', rtmsManager);
app.set('recallBotManager', recallBotManager);
app.set('io', io);

// Middleware
app.use(cors());
// Capture the raw request body alongside parsed JSON so webhook handlers
// can verify HMAC signatures over the exact bytes the sender signed.
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    rooms: messageAggregator.getStats()
  });
});

// Operational status — confirms which capture path is live and how it's
// configured. Useful for verifying a Railway redeploy picked up env vars
// without having to dig through logs.
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

// Webhook routes
app.use('/webhook', webhookRoutes);

// ============================================
// MEETING CONNECTION API ENDPOINTS
// ============================================

// Get list of connected meetings
app.get('/api/meetings', (req, res) => {
  const manager = useRecall ? recallBotManager : rtmsManager;
  const connections = manager.getActiveConnections();
  res.json({
    meetings: connections.map(conn => ({
      id: conn.meetingId,
      meetingId: conn.meetingId,
      roomName: conn.roomName,
      status: 'connected',
      isMock: conn.isMock,
      connectedAt: conn.connectedAt
    }))
  });
});

// Connect to a meeting
app.post('/api/meetings/connect', async (req, res) => {
  const { meetingId, passcode, roomName, roomColor } = req.body;

  if (!meetingId) {
    return res.status(400).json({ error: 'Meeting ID is required' });
  }

  // Clean up meeting ID (remove spaces and dashes)
  const cleanMeetingId = meetingId.replace(/[\s-]/g, '');
  const finalRoomName = roomName || `Meeting ${cleanMeetingId}`;
  const finalRoomColor = roomColor || '#ef4444';

  try {
    // Route through Recall when configured; otherwise use the existing RTMS path.
    if (useRecall) {
      await recallBotManager.connect(cleanMeetingId, passcode, finalRoomName, finalRoomColor);
    } else {
      await rtmsManager.connect(cleanMeetingId, null, finalRoomName, finalRoomColor);
    }

    // Add room to message aggregator
    messageAggregator.addRoom({
      id: cleanMeetingId,
      name: finalRoomName,
      color: finalRoomColor,
      participantCount: 0
    });

    const isMock = useRecall ? false : rtmsManager.useMockMode;

    // Notify clients
    io.emit('meetingConnected', {
      id: cleanMeetingId,
      meetingId: cleanMeetingId,
      roomName: finalRoomName,
      roomColor: finalRoomColor,
      status: 'connected',
      isMock
    });

    let message;
    if (useRecall) {
      message = 'Bot dispatched to meeting via Recall.ai';
    } else if (rtmsManager.useMockMode) {
      message = 'Connected in mock mode (RTMS not available)';
    } else {
      message = 'Connected to meeting stream';
    }

    res.json({
      success: true,
      id: cleanMeetingId,
      message,
      isMock
    });
  } catch (error) {
    console.error('Failed to connect to meeting:', error);
    res.status(500).json({ error: error.message || 'Failed to connect to meeting' });
  }
});

// Disconnect from a meeting
app.post('/api/meetings/:id/disconnect', async (req, res) => {
  const { id } = req.params;

  try {
    if (useRecall) {
      await recallBotManager.disconnect(id);
    } else {
      rtmsManager.disconnect(id);
    }

    // Remove room from message aggregator
    messageAggregator.removeRoom(id);

    // Notify clients
    io.emit('meetingDisconnected', { id });

    res.json({ success: true, message: 'Disconnected from meeting' });
  } catch (error) {
    console.error('Failed to disconnect from meeting:', error);
    res.status(500).json({ error: error.message || 'Failed to disconnect' });
  }
});

// ============================================
// SESSIONS + SAVED MESSAGES
// ============================================

// Current session info (always returns a session — server auto-starts one).
app.get('/api/sessions/current', (req, res) => {
  res.json({ session: sessionManager.getCurrent() });
});

// Rename the current session. Body: { name }.
app.patch('/api/sessions/current', async (req, res) => {
  const name = req.body?.name;
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  try {
    const session = await sessionManager.rename(name);
    res.json({ session });
  } catch (err) {
    console.error('PATCH /api/sessions/current failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// Full list of sessions, most recent first, with message counts. Lets a
// future UI browse past events.
app.get('/api/sessions', async (req, res) => {
  try {
    const sessions = await sessionManager.list({ limit: 100 });
    res.json({ sessions });
  } catch (err) {
    console.error('GET /api/sessions failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// End the current session (closes its log) and immediately start a new
// one. The new session's name can be supplied; otherwise a date-stamped
// default is used.
app.post('/api/sessions/end', async (req, res) => {
  try {
    const newSession = await sessionManager.end({ newSessionName: req.body?.newSessionName });
    // Reset the in-memory ring buffer for the new session — clients
    // will see a fresh feed when they subscribe again.
    messageAggregator.clearMessages();
    res.json({ session: newSession });
  } catch (err) {
    console.error('POST /api/sessions/end failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// Mark a message as saved (with optional one-line note).
app.post('/api/messages/:id/save', async (req, res) => {
  const { id } = req.params;
  const note = req.body?.note ?? null;
  try {
    const message = await messageAggregator.setSaved(id, true, note);
    if (!message) return res.status(404).json({ error: 'Message not found' });
    res.json({ message });
  } catch (err) {
    console.error(`POST /api/messages/${id}/save failed:`, err);
    res.status(500).json({ error: err.message });
  }
});

// Unmark a saved message.
app.delete('/api/messages/:id/save', async (req, res) => {
  const { id } = req.params;
  try {
    const message = await messageAggregator.setSaved(id, false, null);
    if (!message) return res.status(404).json({ error: 'Message not found' });
    res.json({ message });
  } catch (err) {
    console.error(`DELETE /api/messages/${id}/save failed:`, err);
    res.status(500).json({ error: err.message });
  }
});

// All saved messages for the given session (defaults to current).
app.get('/api/saved', async (req, res) => {
  const sessionId = req.query.session_id || undefined;
  try {
    const messages = await messageAggregator.getSavedMessages({ sessionId });
    res.json({ messages });
  } catch (err) {
    console.error('GET /api/saved failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// CSV export of saved messages — operators paste straight into a sheet.
app.get('/api/saved/export.csv', async (req, res) => {
  const sessionId = req.query.session_id || undefined;
  try {
    const messages = await messageAggregator.getSavedMessages({ sessionId });
    const rows = [
      ['timestamp', 'room', 'sender', 'content', 'note'],
      ...messages.map(m => [
        m.timestamp,
        m.room,
        m.sender,
        m.content,
        m.note || '',
      ]),
    ];
    const csv = rows
      .map(row => row.map(csvEscape).join(','))
      .join('\n');
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
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// ============================================
// DEVELOPMENT/TESTING ENDPOINTS
// These let you test without actual Zoom connection
// ============================================

// Simulate adding a chat message (for testing)
app.post('/dev/message', (req, res) => {
  const { sender, content, room } = req.body;

  if (!sender || !content) {
    return res.status(400).json({ error: 'sender and content required' });
  }

  messageAggregator.addMessage({
    sender: sender || 'Test User',
    content: content,
    room: room || 'Test Room',
    timestamp: new Date().toISOString()
  });

  res.json({ success: true, message: 'Message added' });
});

// Simulate a room joining
app.post('/dev/room', (req, res) => {
  const { roomName, meetingId } = req.body;

  messageAggregator.addRoom({
    id: meetingId || `test-${Date.now()}`,
    name: roomName || 'Test Room',
    participantCount: Math.floor(Math.random() * 20) + 1
  });

  res.json({ success: true, message: 'Room added' });
});

// Get current state (for debugging)
app.get('/dev/state', (req, res) => {
  res.json({
    messages: messageAggregator.getRecentMessages(50),
    stats: messageAggregator.getStats(),
    rooms: messageAggregator.getRooms()
  });
});

// Setup Socket.io handlers
setupSocketHandlers(io, messageAggregator, rtmsManager);

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(join(__dirname, '../../client/dist')));
  app.get('*', (req, res) => {
    res.sendFile(join(__dirname, '../../client/dist/index.html'));
  });
}

// Start server. Async wrapper so we can await DB + session init before
// taking traffic — that way the very first message of a session lands
// in the DB instead of falling through the persistence gap.
const PORT = process.env.PORT || 3001;

async function start() {
  // 1. Connect to Postgres (optional — falls back to in-memory only).
  const db = await initDatabase({ databaseUrl: process.env.DATABASE_URL });
  messageAggregator.db = db;
  sessionManager.db = db;

  // 2. Reopen the most recent un-ended session, or create a new one.
  await sessionManager.init();
  messageAggregator.sessionManager = sessionManager;

  // 3. Hydrate the in-memory ring buffer from this session's history.
  await messageAggregator.hydrate();

  // 4. Start listening.
  httpServer.listen(PORT, () => {
    const botPath = useRecall ? 'Recall.ai' : `RTMS (${rtmsManager.useMockMode ? 'mock mode' : 'live'})`;
    const persistence = db ? 'Postgres' : 'in-memory only';
    const session = sessionManager.getCurrent();
    console.log(`
╔════════════════════════════════════════════════════════════╗
║         Zoom Chat Aggregator Server Started!               ║
╠════════════════════════════════════════════════════════════╣
║  Server running on: http://localhost:${PORT}                   ║
║  Webhook endpoint:  http://localhost:${PORT}/webhook/zoom      ║
║  Health check:      http://localhost:${PORT}/health            ║
║  Bot path:          ${botPath.padEnd(40)}║
║  Persistence:       ${persistence.padEnd(40)}║
║  Session:           ${(session?.name || 'none').padEnd(40)}║
╠════════════════════════════════════════════════════════════╣
║  Development endpoints:                                    ║
║  POST /dev/message  - Add test message                     ║
║  POST /dev/room     - Add test room                        ║
║  GET  /dev/state    - View current state                   ║
╚════════════════════════════════════════════════════════════╝
    `);
    console.log(`[BotManager] Active path: ${botPath}`);
  });
}

start().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

export { app, io, messageAggregator, sessionManager };
