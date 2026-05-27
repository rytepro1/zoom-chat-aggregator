import { v4 as uuidv4 } from 'uuid';

/**
 * Aggregates chat messages from multiple Zoom meeting rooms into a
 * unified stream and persists them to Postgres (via the optional db +
 * sessionManager dependencies). The in-memory ring buffer is kept so
 * real-time clients can read the recent timeline cheaply; the DB is
 * the source of truth for save/export and post-event browsing.
 */
export class MessageAggregator {
  constructor(io, { db, sessionManager } = {}) {
    this.io = io;
    this.db = db || null;
    this.sessionManager = sessionManager || null;
    this.messages = [];
    this.rooms = new Map();
    this.maxMessages = 500; // Ring buffer size (in-memory)
  }

  /**
   * Hydrate the in-memory ring buffer from the database. Called once on
   * startup after sessionManager.init() so connecting clients see the
   * session-so-far instead of an empty feed.
   */
  async hydrate() {
    if (!this.db || !this.sessionManager?.current) return;
    const sessionId = this.sessionManager.current.id;
    const { rows } = await this.db.query(
      `SELECT id, timestamp, sender, room, room_color, meeting_id, content, type, saved, note
         FROM messages
        WHERE session_id = $1
        ORDER BY timestamp DESC
        LIMIT $2`,
      [sessionId, this.maxMessages]
    );
    // DB returns newest-first; flip so the in-memory buffer is oldest-first
    // (same shape as if these had arrived through addMessage live).
    this.messages = rows.reverse().map(rowToMessage);
    console.log(`[Aggregator] hydrated ${this.messages.length} messages from session ${sessionId}`);
  }

  /**
   * Add a new message to the aggregated feed. Writes through to the DB
   * (best-effort — a DB error is logged but doesn't drop the live event).
   */
  async addMessage(messageData) {
    const message = {
      id: uuidv4(),
      sender: messageData.sender || 'Unknown',
      content: messageData.content || '',
      room: messageData.room || 'Unknown Room',
      roomColor: messageData.roomColor || '#ef4444',
      meetingId: messageData.meetingId || null,
      timestamp: messageData.timestamp || new Date().toISOString(),
      type: messageData.type || 'chat',
      saved: false,
      note: null,
    };

    this.messages.push(message);
    if (this.messages.length > this.maxMessages) this.messages.shift();
    this.updateRoomStats(message.room);
    this.io.emit('newMessage', message);
    if (message.meetingId) {
      this.io.to(`room:${message.meetingId}`).emit('roomMessage', message);
    }

    if (this.db && this.sessionManager?.current) {
      try {
        await this.db.query(
          `INSERT INTO messages
              (id, session_id, timestamp, sender, room, room_color,
               meeting_id, content, type)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            message.id,
            this.sessionManager.current.id,
            message.timestamp,
            message.sender,
            message.room,
            message.roomColor,
            message.meetingId,
            message.content,
            message.type,
          ]
        );
      } catch (err) {
        console.error('[Aggregator] DB insert failed (message still in live feed):', err.message);
      }
    }

    console.log(`[${message.room}] ${message.sender}: ${message.content.substring(0, 50)}...`);
    return message;
  }

  /**
   * Mark a message as saved (or unsaved). Updates the in-memory entry
   * if present, writes through to the DB, and emits a socket event so
   * other connected clients (display window, second moderator) stay in
   * sync. Returns the updated message or null if not found.
   */
  async setSaved(messageId, saved, note = null) {
    // Update in-memory if present (recent message)
    const inMem = this.messages.find(m => m.id === messageId);
    if (inMem) {
      inMem.saved = saved;
      inMem.note = saved ? note : null;
    }

    if (this.db) {
      try {
        const result = await this.db.query(
          `UPDATE messages
              SET saved = $2,
                  saved_at = CASE WHEN $2 THEN NOW() ELSE NULL END,
                  note = $3
            WHERE id = $1
        RETURNING id, timestamp, sender, room, room_color, meeting_id, content, type, saved, note`,
          [messageId, saved, saved ? note : null]
        );
        if (result.rows.length === 0 && !inMem) return null;
        const message = result.rows[0] ? rowToMessage(result.rows[0]) : inMem;
        this.io.emit(saved ? 'messageSaved' : 'messageUnsaved', message);
        return message;
      } catch (err) {
        console.error('[Aggregator] setSaved DB error:', err.message);
        // Best-effort: still emit if we had the message in memory
        if (inMem) this.io.emit(saved ? 'messageSaved' : 'messageUnsaved', inMem);
        return inMem || null;
      }
    }

    // No DB — operate on in-memory only
    if (inMem) {
      this.io.emit(saved ? 'messageSaved' : 'messageUnsaved', inMem);
      return inMem;
    }
    return null;
  }

  /**
   * Return all saved messages for the given session (or the current
   * session if none specified), newest first.
   */
  async getSavedMessages({ sessionId } = {}) {
    const targetSession = sessionId || this.sessionManager?.current?.id;
    if (!this.db || !targetSession) {
      // No DB: filter in-memory by current-session inferred via saved flag.
      return this.messages.filter(m => m.saved).map(m => ({ ...m }));
    }
    const { rows } = await this.db.query(
      `SELECT id, timestamp, sender, room, room_color, meeting_id, content, type, saved, note, saved_at
         FROM messages
        WHERE session_id = $1 AND saved = TRUE
        ORDER BY saved_at DESC NULLS LAST, timestamp DESC`,
      [targetSession]
    );
    return rows.map(rowToMessage);
  }

  // -------- Room management (unchanged from before) --------

  addRoom(roomData) {
    const room = {
      id: roomData.id,
      name: roomData.name || `Room ${roomData.id}`,
      participantCount: roomData.participantCount || 0,
      messageCount: 0,
      joinedAt: new Date().toISOString(),
      streamUrl: roomData.streamUrl || null,
    };
    this.rooms.set(room.id, room);
    this.io.emit('roomAdded', room);
    console.log(`Room added: ${room.name}`);
    return room;
  }

  removeRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (room) {
      this.rooms.delete(roomId);
      this.io.emit('roomRemoved', { id: roomId, name: room.name });
      console.log(`Room removed: ${room.name}`);
    }
  }

  updateRoomStats(roomName) {
    for (const [id, room] of this.rooms) {
      if (room.name === roomName) {
        room.messageCount = (room.messageCount || 0) + 1;
        room.lastActivity = new Date().toISOString();
        break;
      }
    }
  }

  getRecentMessages(limit = 100) {
    return this.messages.slice(-limit);
  }

  getMessagesByRoom(roomId, limit = 100) {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return this.messages
      .filter(m => m.meetingId === roomId || m.room === room.name)
      .slice(-limit);
  }

  getRooms() {
    return Array.from(this.rooms.values());
  }

  getStats() {
    const roomStats = {};
    for (const [id, room] of this.rooms) {
      roomStats[room.name] = {
        messageCount: room.messageCount || 0,
        participantCount: room.participantCount || 0,
      };
    }
    return {
      totalMessages: this.messages.length,
      activeRooms: this.rooms.size,
      roomStats,
      oldestMessage: this.messages[0]?.timestamp || null,
      newestMessage: this.messages[this.messages.length - 1]?.timestamp || null,
    };
  }

  clearMessages() {
    this.messages = [];
    this.io.emit('messagesCleared');
  }
}

/**
 * Convert a DB row to the message shape the React client expects.
 * Centralized so the same translation is applied everywhere a row
 * leaves the persistence layer.
 */
function rowToMessage(row) {
  return {
    id: row.id,
    sender: row.sender,
    content: row.content,
    room: row.room,
    roomColor: row.room_color,
    meetingId: row.meeting_id,
    timestamp:
      row.timestamp instanceof Date ? row.timestamp.toISOString() : row.timestamp,
    type: row.type || 'chat',
    saved: row.saved === true,
    note: row.note || null,
  };
}
