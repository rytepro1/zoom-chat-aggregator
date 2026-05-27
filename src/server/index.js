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
import { RTMSManager } from '../rtms/RTMSManager.js';
import { RecallBotManager } from '../recall/RecallBotManager.js';

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

// Initialize message aggregator
const messageAggregator = new MessageAggregator(io);

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
app.set('rtmsManager', rtmsManager);
app.set('recallBotManager', recallBotManager);
app.set('io', io);

// Middleware
app.use(cors());
app.use(express.json());
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

// Start server
const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  const botPath = useRecall ? 'Recall.ai' : `RTMS (${rtmsManager.useMockMode ? 'mock mode' : 'live'})`;
  console.log(`
╔════════════════════════════════════════════════════════════╗
║         Zoom Chat Aggregator Server Started!               ║
╠════════════════════════════════════════════════════════════╣
║  Server running on: http://localhost:${PORT}                   ║
║  Webhook endpoint:  http://localhost:${PORT}/webhook/zoom      ║
║  Health check:      http://localhost:${PORT}/health            ║
║  Bot path:          ${botPath.padEnd(40)}║
╠════════════════════════════════════════════════════════════╣
║  Development endpoints:                                    ║
║  POST /dev/message  - Add test message                     ║
║  POST /dev/room     - Add test room                        ║
║  GET  /dev/state    - View current state                   ║
╚════════════════════════════════════════════════════════════╝
  `);
  console.log(`[BotManager] Active path: ${botPath}`);
});

export { app, io, messageAggregator };
