/**
 * Socket.io event handlers for real-time client communication
 */

export function setupSocketHandlers(io, messageAggregator) {
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

    // Handle disconnect
    socket.on('disconnect', () => {
      console.log(`Client disconnected: ${socket.id}`);
    });
  });
}
