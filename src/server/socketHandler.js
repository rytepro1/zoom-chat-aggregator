/**
 * Socket.io event handlers for real-time client communication
 */

// Moderation state (shared across all clients)
let moderationState = {
  highlightedIds: [],
  queue: [],
  featuredMessage: null
};

export function setupSocketHandlers(io, messageAggregator, rtmsManager = null) {
  io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);

    // Send initial state to new client
    socket.emit('initialState', {
      messages: messageAggregator.getRecentMessages(100),
      rooms: messageAggregator.getRooms(),
      stats: messageAggregator.getStats()
    });

    // Handle client requesting message history
    socket.on('getHistory', (options = {}) => {
      const { limit = 100, room = null } = options;
      const messages = room
        ? messageAggregator.getMessagesByRoom(room, limit)
        : messageAggregator.getRecentMessages(limit);

      socket.emit('history', { messages });
    });

    // Handle client requesting room list
    socket.on('getRooms', () => {
      socket.emit('rooms', { rooms: messageAggregator.getRooms() });
    });

    // Handle client requesting stats
    socket.on('getStats', () => {
      socket.emit('stats', { stats: messageAggregator.getStats() });
    });

    // Handle room filter subscription
    socket.on('subscribeToRoom', (roomId) => {
      socket.join(`room:${roomId}`);
      console.log(`Client ${socket.id} subscribed to room: ${roomId}`);
    });

    socket.on('unsubscribeFromRoom', (roomId) => {
      socket.leave(`room:${roomId}`);
      console.log(`Client ${socket.id} unsubscribed from room: ${roomId}`);
    });

    // Handle meeting connection request from client
    socket.on('connectToMeeting', async ({ meetingId, passcode, roomName }) => {
      if (!rtmsManager) {
        socket.emit('meetingError', { error: 'RTMS manager not available' });
        return;
      }

      try {
        await rtmsManager.connect(meetingId, null, roomName || `Meeting ${meetingId}`);

        messageAggregator.addRoom({
          id: meetingId,
          name: roomName || `Meeting ${meetingId}`,
          participantCount: 0
        });

        io.emit('meetingConnected', {
          id: meetingId,
          meetingId,
          roomName: roomName || `Meeting ${meetingId}`,
          status: 'connected',
          isMock: rtmsManager.useMockMode
        });
      } catch (error) {
        socket.emit('meetingError', { error: error.message });
      }
    });

    // Handle meeting disconnect request
    socket.on('disconnectFromMeeting', (meetingId) => {
      if (!rtmsManager) return;

      rtmsManager.disconnect(meetingId);
      messageAggregator.removeRoom(meetingId);
      io.emit('meetingDisconnected', { id: meetingId });
    });

    // Get connected meetings
    socket.on('getConnectedMeetings', () => {
      if (!rtmsManager) {
        socket.emit('connectedMeetings', { meetings: [] });
        return;
      }

      const connections = rtmsManager.getActiveConnections();
      socket.emit('connectedMeetings', {
        meetings: connections.map(conn => ({
          id: conn.meetingId,
          meetingId: conn.meetingId,
          roomName: conn.roomName,
          status: 'connected',
          isMock: conn.isMock
        }))
      });
    });

    // ============================================
    // MODERATION HANDLERS
    // ============================================

    // Get current moderation state
    socket.on('getModerationState', () => {
      socket.emit('moderationState', moderationState);
    });

    // Handle moderation updates (broadcast to all clients)
    socket.on('moderationUpdate', (update) => {
      // Update server state
      if (update.highlightedIds !== undefined) {
        moderationState.highlightedIds = update.highlightedIds;
      }
      if (update.queue !== undefined) {
        moderationState.queue = update.queue;
      }
      if (update.featuredMessage !== undefined) {
        moderationState.featuredMessage = update.featuredMessage;
      }

      // Broadcast to all clients (including sender for consistency)
      io.emit('moderationUpdate', update);
      console.log('Moderation update:', Object.keys(update).join(', '));
    });

    // Handle disconnect
    socket.on('disconnect', () => {
      console.log(`Client disconnected: ${socket.id}`);
    });
  });
}
