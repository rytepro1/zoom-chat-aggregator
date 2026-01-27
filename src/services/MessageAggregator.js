import { v4 as uuidv4 } from 'uuid';

/**
 * Aggregates chat messages from multiple Zoom meeting rooms
 * into a unified stream for display
 */
export class MessageAggregator {
  constructor(io) {
    this.io = io;
    this.messages = [];
    this.rooms = new Map();
    this.maxMessages = 500; // Ring buffer size
  }

  /**
   * Add a new message to the aggregated feed
   */
  addMessage(messageData) {
    const message = {
      id: uuidv4(),
      sender: messageData.sender || 'Unknown',
      content: messageData.content || '',
      room: messageData.room || 'Unknown Room',
      roomColor: messageData.roomColor || '#ef4444',
      meetingId: messageData.meetingId || null,
      timestamp: messageData.timestamp || new Date().toISOString(),
      type: messageData.type || 'chat'
    };

    // Add to messages array (ring buffer)
    this.messages.push(message);
    if (this.messages.length > this.maxMessages) {
      this.messages.shift();
    }

    // Update room stats
    this.updateRoomStats(message.room);

    // Broadcast to all connected clients
    this.io.emit('newMessage', message);

    // Also emit to room-specific channel
    if (message.meetingId) {
      this.io.to(`room:${message.meetingId}`).emit('roomMessage', message);
    }

    console.log(`[${message.room}] ${message.sender}: ${message.content.substring(0, 50)}...`);

    return message;
  }

  /**
   * Add or update a room
   */
  addRoom(roomData) {
    const room = {
      id: roomData.id,
      name: roomData.name || `Room ${roomData.id}`,
      participantCount: roomData.participantCount || 0,
      messageCount: 0,
      joinedAt: new Date().toISOString(),
      streamUrl: roomData.streamUrl || null
    };

    this.rooms.set(room.id, room);

    // Broadcast room update
    this.io.emit('roomAdded', room);

    console.log(`Room added: ${room.name}`);
    return room;
  }

  /**
   * Remove a room
   */
  removeRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (room) {
      this.rooms.delete(roomId);
      this.io.emit('roomRemoved', { id: roomId, name: room.name });
      console.log(`Room removed: ${room.name}`);
    }
  }

  /**
   * Update room statistics
   */
  updateRoomStats(roomName) {
    for (const [id, room] of this.rooms) {
      if (room.name === roomName) {
        room.messageCount = (room.messageCount || 0) + 1;
        room.lastActivity = new Date().toISOString();
        break;
      }
    }
  }

  /**
   * Get recent messages
   */
  getRecentMessages(limit = 100) {
    return this.messages.slice(-limit);
  }

  /**
   * Get messages filtered by room
   */
  getMessagesByRoom(roomId, limit = 100) {
    const room = this.rooms.get(roomId);
    if (!room) return [];

    return this.messages
      .filter(m => m.meetingId === roomId || m.room === room.name)
      .slice(-limit);
  }

  /**
   * Get all active rooms
   */
  getRooms() {
    return Array.from(this.rooms.values());
  }

  /**
   * Get aggregation statistics
   */
  getStats() {
    const roomStats = {};
    for (const [id, room] of this.rooms) {
      roomStats[room.name] = {
        messageCount: room.messageCount || 0,
        participantCount: room.participantCount || 0
      };
    }

    return {
      totalMessages: this.messages.length,
      activeRooms: this.rooms.size,
      roomStats,
      oldestMessage: this.messages[0]?.timestamp || null,
      newestMessage: this.messages[this.messages.length - 1]?.timestamp || null
    };
  }

  /**
   * Clear all messages (useful for testing)
   */
  clearMessages() {
    this.messages = [];
    this.io.emit('messagesCleared');
  }
}
