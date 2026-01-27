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

// Make aggregator available to routes
app.set('messageAggregator', messageAggregator);
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
setupSocketHandlers(io, messageAggregator);

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
