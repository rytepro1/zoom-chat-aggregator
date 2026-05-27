import { v4 as uuidv4 } from 'uuid';

/**
 * Manages the lifecycle of "sessions" — a session represents one live
 * event run from server start (or operator action) until the operator
 * explicitly ends it. All messages persisted to the database are tagged
 * with the session id they belong to, enabling post-event browsing and
 * targeted export of saved highlights.
 *
 * Scoping (Phase 2): one SessionManager instance per org. Construct with
 * { orgId } and all DB reads/writes are filtered to that org so two
 * customers on the same server can never see each other's sessions.
 *
 * Behavior:
 *   - On init(): reopen the most recent un-ended session for the org,
 *     or create a fresh one named with the current date/time.
 *   - end() marks ended_at and immediately starts a new session for
 *     the org, so the org always has a "current" session to land in.
 *
 * Stub mode: if no `db` is provided, sessions are tracked in memory only
 * (still works as a label for messages flowing through, just not durable).
 */
export class SessionManager {
  constructor({ db, io, orgId } = {}) {
    this.db = db;
    this.io = io;
    this.orgId = orgId || null;
    this.current = null; // { id, name, started_at, ended_at, org_id }
  }

  /** Channel used for socket events scoped to this org. */
  get roomName() {
    return this.orgId ? `org:${this.orgId}` : null;
  }

  _emit(event, payload) {
    if (!this.io) return;
    if (this.roomName) this.io.to(this.roomName).emit(event, payload);
    else this.io.emit(event, payload);
  }

  async init() {
    if (!this.db) {
      this.current = this._makeInMemorySession();
      console.log(`[Session ${this.orgId}] in-memory: ${this.current.name} (${this.current.id})`);
      return this.current;
    }

    // Try to reopen an existing un-ended session for this org.
    const existing = await this.db.query(
      `SELECT id, name, started_at, ended_at, org_id
         FROM sessions
        WHERE ended_at IS NULL
          AND ($1::text IS NULL OR org_id = $1)
        ORDER BY started_at DESC
        LIMIT 1`,
      [this.orgId]
    );
    if (existing.rows.length > 0) {
      this.current = existing.rows[0];
      console.log(`[Session ${this.orgId}] resumed: ${this.current.name} (${this.current.id})`);
      return this.current;
    }

    return this._createNewSession();
  }

  getCurrent() {
    return this.current;
  }

  /**
   * End the current session and start a new one. Returns the new
   * session. Idempotent for the "no-op when no current session" case.
   */
  async end({ newSessionName } = {}) {
    if (this.db && this.current) {
      await this.db.query(
        `UPDATE sessions SET ended_at = NOW()
          WHERE id = $1 AND ended_at IS NULL
            AND ($2::text IS NULL OR org_id = $2)`,
        [this.current.id, this.orgId]
      );
      console.log(`[Session ${this.orgId}] ended: ${this.current.name} (${this.current.id})`);
      this._emit('sessionEnded', { id: this.current.id });
    }
    return this._createNewSession(newSessionName);
  }

  async rename(name) {
    if (!this.current) return null;
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new Error('Session name cannot be empty');
    if (this.db) {
      await this.db.query(
        `UPDATE sessions SET name = $2
          WHERE id = $1 AND ($3::text IS NULL OR org_id = $3)`,
        [this.current.id, trimmed, this.orgId]
      );
    }
    this.current = { ...this.current, name: trimmed };
    console.log(`[Session ${this.orgId}] renamed: ${trimmed} (${this.current.id})`);
    this._emit('sessionRenamed', { id: this.current.id, name: trimmed });
    return this.current;
  }

  async list({ limit = 50 } = {}) {
    if (!this.db) {
      return this.current ? [{ ...this.current, message_count: 0 }] : [];
    }
    const { rows } = await this.db.query(
      `SELECT s.id, s.name, s.started_at, s.ended_at,
              COUNT(m.id) AS message_count,
              COUNT(m.id) FILTER (WHERE m.saved) AS saved_count
         FROM sessions s
    LEFT JOIN messages m ON m.session_id = s.id
        WHERE ($1::text IS NULL OR s.org_id = $1)
        GROUP BY s.id
        ORDER BY s.started_at DESC
        LIMIT $2`,
      [this.orgId, limit]
    );
    return rows.map(r => ({
      ...r,
      message_count: Number(r.message_count),
      saved_count: Number(r.saved_count),
    }));
  }

  async _createNewSession(name) {
    const id = uuidv4();
    const sessionName = name || this._defaultName();
    if (this.db) {
      await this.db.query(
        `INSERT INTO sessions (id, name, org_id, tenant_id)
         VALUES ($1, $2, $3, COALESCE($3, 'ryteproductions'))`,
        [id, sessionName, this.orgId]
      );
    }
    this.current = {
      id,
      name: sessionName,
      started_at: new Date(),
      ended_at: null,
      org_id: this.orgId,
    };
    console.log(`[Session ${this.orgId}] started: ${sessionName} (${id})`);
    this._emit('sessionStarted', this.current);
    return this.current;
  }

  _makeInMemorySession() {
    return {
      id: uuidv4(),
      name: this._defaultName(),
      started_at: new Date(),
      ended_at: null,
      org_id: this.orgId,
    };
  }

  _defaultName() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `Session ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
}
