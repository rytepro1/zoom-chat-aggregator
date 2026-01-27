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

// Initialize RTMS manager
const rtmsManager = new RTMSManager(messageAggregator);

// Make aggregator and RTMS manager available to routes
app.set('messageAggregator', messageAggregator);
app.set('rtmsManager', rtmsManager);
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
  const connections = rtmsManager.getActiveConnections();
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
  const { meetingId, passcode, roomName } = req.body;

  if (!meetingId) {
    return res.status(400).json({ error: 'Meeting ID is required' });
  }

  // Clean up meeting ID (remove spaces and dashes)
  const cleanMeetingId = meetingId.replace(/[\s-]/g, '');

  try {
    // Connect via RTMS manager (will use mock mode if RTMS not available)
    await rtmsManager.connect(cleanMeetingId, null, roomName || `Meeting ${cleanMeetingId}`);

    // Add room to message aggregator
    messageAggregator.addRoom({
      id: cleanMeetingId,
      name: roomName || `Meeting ${cleanMeetingId}`,
      participantCount: 0
    });

    // Notify clients
    io.emit('meetingConnected', {
      id: cleanMeetingId,
      meetingId: cleanMeetingId,
      roomName: roomName || `Meeting ${cleanMeetingId}`,
      status: 'connected',
      isMock: rtmsManager.useMockMode
    });

    res.json({
      success: true,
      id: cleanMeetingId,
      message: rtmsManager.useMockMode
        ? 'Connected in mock mode (RTMS not available)'
        : 'Connected to meeting stream',
      isMock: rtmsManager.useMockMode
    });
  } catch (error) {
    console.error('Failed to connect to meeting:', error);
    res.status(500).json({ error: error.message || 'Failed to connect to meeting' });
  }
});

// Disconnect from a meeting
app.post('/api/meetings/:id/disconnect', (req, res) => {
  const { id } = req.params;

  try {
    rtmsManager.disconnect(id);

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
  console.log(`
╔════════════════════════════════════════════════════════════╗
║         Zoom Chat Aggregator Server Started!               ║
╠════════════════════════════════════════════════════════════╣
║  Server running on: http://localhost:${PORT}                   ║
║  Webhook endpoint:  http://localhost:${PORT}/webhook/zoom      ║
║  Health check:      http://localhost:${PORT}/health            ║
╠════════════════════════════════════════════════════════════╣
║  Development endpoints:                                    ║
║  POST /dev/message  - Add test message                     ║
║  POST /dev/room     - Add test room                        ║
║  GET  /dev/state    - View current state                   ║
╚════════════════════════════════════════════════════════════╝
  `);
});

export { app, io, messageAggregator };
