import { v4 as uuidv4 } from 'uuid';

/**
 * Aggregates chat messages from one org's meeting rooms into a unified
 * stream and persists them to Postgres (via the optional db +
 * sessionManager dependencies). The in-memory ring buffer is kept so
 * real-time clients can read the recent timeline cheaply; the DB is
 * the source of truth for save/export and post-event browsing.
 *
 * Scoping (Phase 2): one MessageAggregator per org. Construct with
 * { orgId } so DB writes carry the org tag and socket emits go to the
 * org's room only (`io.to('org:<id>').emit(...)`). Two customers on the
 * same server can never see each other's chat.
 */
export class MessageAggregator {
  constructor(io, { db, sessionManager, orgId } = {}) {
    this.io = io;
    this.db = db || null;
    this.sessionManager = sessionManager || null;
    this.orgId = orgId || null;
    this.messages = [];
    this.rooms = new Map();
    this.maxMessages = 500;
  }

  get roomName() {
    return this.orgId ? `org:${this.orgId}` : null;
  }

  _emit(event, payload) {
    if (this.roomName) this.io.to(this.roomName).emit(event, payload);
    else this.io.emit(event, payload);
  }

  /**
   * Hydrate the in-memory ring buffer from the database. Called once
   * after sessionManager.init() so connecting clients see the
   * session-so-far instead of an empty feed.
   */
  async hydrate() {
    if (!this.db || !this.sessionManager?.current) return;
    const sessionId = this.sessionManager.current.id;
    const { rows } = await this.db.query(
      `SELECT id, timestamp, sender, room, room_color, meeting_id, content, type, saved, note
         FROM messages
        WHERE session_id = $1
          AND ($2::text IS NULL OR org_id = $2)
        ORDER BY timestamp DESC
        LIMIT $3`,
      [sessionId, this.orgId, this.maxMessages]
    );
    this.messages = rows.reverse().map(rowToMessage);
    console.log(`[Aggregator ${this.orgId}] hydrated ${this.messages.length} from ${sessionId}`);
  }

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

    // Echo dedup: inbound chat matching a recent outgoing?
    if (message.type === 'chat') {
      const cutoffMs = Date.now() - 5000;
      const recent = this.messages.slice(-10);
      const isEcho = recent.some(m =>
        (m.type === 'reply' || m.type === 'broadcast') &&
        m.sender === message.sender &&
        m.content === message.content &&
        m.meetingId === message.meetingId &&
        new Date(m.timestamp).getTime() >= cutoffMs
      );
      if (isEcho) {
        console.log(`[Aggregator ${this.orgId}] skipping echo in ${message.room}`);
        return null;
      }
    }

    this.messages.push(message);
    if (this.messages.length > this.maxMessages) this.messages.shift();
    this.updateRoomStats(message.room);
    this._emit('newMessage', message);
    if (message.meetingId) {
      // Room-specific channel: only sockets in BOTH the org room AND the
      // meeting room get it. (Meeting-scoped subscriptions for room filter
      // views.) We namespace by org to prevent meeting-id collisions
      // across orgs.
      this.io.to(`org:${this.orgId}:room:${message.meetingId}`).emit('roomMessage', message);
    }

    if (this.db && this.sessionManager?.current) {
      try {
        await this.db.query(
          `INSERT INTO messages
              (id, session_id, timestamp, sender, room, room_color,
               meeting_id, content, type, org_id, tenant_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($10, 'ryteproductions'))`,
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
            this.orgId,
          ]
        );
      } catch (err) {
        console.error(`[Aggregator ${this.orgId}] DB insert failed:`, err.message);
      }
    }

    console.log(`[${this.orgId}/${message.room}] ${message.sender}: ${message.content.substring(0, 50)}...`);
    return message;
  }

  async setSaved(messageId, saved, note = null) {
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
              AND ($4::text IS NULL OR org_id = $4)
        RETURNING id, timestamp, sender, room, room_color, meeting_id, content, type, saved, note`,
          [messageId, saved, saved ? note : null, this.orgId]
        );
        if (result.rows.length === 0 && !inMem) return null;
        const message = result.rows[0] ? rowToMessage(result.rows[0]) : inMem;
        this._emit(saved ? 'messageSaved' : 'messageUnsaved', message);
        return message;
      } catch (err) {
        console.error(`[Aggregator ${this.orgId}] setSaved DB error:`, err.message);
        if (inMem) this._emit(saved ? 'messageSaved' : 'messageUnsaved', inMem);
        return inMem || null;
      }
    }

    if (inMem) {
      this._emit(saved ? 'messageSaved' : 'messageUnsaved', inMem);
      return inMem;
    }
    return null;
  }

  async getSavedMessages({ sessionId } = {}) {
    const targetSession = sessionId || this.sessionManager?.current?.id;
    if (!this.db || !targetSession) {
      return this.messages.filter(m => m.saved).map(m => ({ ...m }));
    }
    const { rows } = await this.db.query(
      `SELECT id, timestamp, sender, room, room_color, meeting_id, content, type, saved, note, saved_at
         FROM messages
        WHERE session_id = $1 AND saved = TRUE
          AND ($2::text IS NULL OR org_id = $2)
        ORDER BY saved_at DESC NULLS LAST, timestamp DESC`,
      [targetSession, this.orgId]
    );
    return rows.map(rowToMessage);
  }

  // -------- Room management (org-scoped emits) --------

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
    this._emit('roomAdded', room);
    console.log(`[${this.orgId}] room added: ${room.name}`);
    return room;
  }

  removeRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (room) {
      this.rooms.delete(roomId);
      this._emit('roomRemoved', { id: roomId, name: room.name });
      console.log(`[${this.orgId}] room removed: ${room.name}`);
    }
  }

  updateRoomStats(roomName) {
    for (const [, room] of this.rooms) {
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
    for (const [, room] of this.rooms) {
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
    this._emit('messagesCleared');
  }
}

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
