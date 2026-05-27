import { v4 as uuidv4 } from 'uuid';

/**
 * Manages the lifecycle of "sessions" — a session represents one live
 * event run from server start (or operator action) until the operator
 * explicitly ends it. All messages persisted to the database are tagged
 * with the session id they belong to, enabling post-event browsing and
 * targeted export of saved highlights.
 *
 * Behavior:
 *   - On startup: reopen the most recent session that has no ended_at,
 *     or create a fresh one named with the current date/time. This makes
 *     a Railway redeploy mid-event invisible to clients.
 *   - end() marks ended_at and immediately starts a new session, so the
 *     server always has a "current" session messages can land in.
 *
 * Stub mode: if no `db` is provided, sessions are tracked in memory only
 * (still works as a label for messages flowing through, just not durable).
 */
export class SessionManager {
  constructor({ db, io } = {}) {
    this.db = db;
    this.io = io;
    this.current = null; // { id, name, started_at, ended_at }
  }

  async init() {
    if (!this.db) {
      this.current = this._makeInMemorySession();
      console.log(`[Session] in-memory session: ${this.current.name} (${this.current.id})`);
      return this.current;
    }

    // Try to reopen an existing un-ended session first.
    const existing = await this.db.query(
      `SELECT id, name, started_at, ended_at
         FROM sessions
        WHERE ended_at IS NULL
        ORDER BY started_at DESC
        LIMIT 1`
    );
    if (existing.rows.length > 0) {
      this.current = existing.rows[0];
      console.log(`[Session] resumed: ${this.current.name} (${this.current.id})`);
      return this.current;
    }

    // Otherwise create a fresh session.
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
        `UPDATE sessions SET ended_at = NOW() WHERE id = $1 AND ended_at IS NULL`,
        [this.current.id]
      );
      console.log(`[Session] ended: ${this.current.name} (${this.current.id})`);
      this.io?.emit('sessionEnded', { id: this.current.id });
    }
    return this._createNewSession(newSessionName);
  }

  /**
   * Rename the current session (no other state change). Used when the
   * operator wants to label an in-flight session with a meaningful name
   * (e.g. "Acme Q3 Kickoff" instead of the date-stamped default).
   */
  async rename(name) {
    if (!this.current) return null;
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new Error('Session name cannot be empty');
    if (this.db) {
      await this.db.query(
        `UPDATE sessions SET name = $2 WHERE id = $1`,
        [this.current.id, trimmed]
      );
    }
    this.current = { ...this.current, name: trimmed };
    console.log(`[Session] renamed to: ${trimmed} (${this.current.id})`);
    this.io?.emit('sessionRenamed', { id: this.current.id, name: trimmed });
    return this.current;
  }

  /**
   * Return a list of all sessions (most recent first) along with their
   * message counts. Used by the React UI's session browser.
   */
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
        GROUP BY s.id
        ORDER BY s.started_at DESC
        LIMIT $1`,
      [limit]
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
        `INSERT INTO sessions (id, name) VALUES ($1, $2)`,
        [id, sessionName]
      );
    }
    this.current = {
      id,
      name: sessionName,
      started_at: new Date(),
      ended_at: null,
    };
    console.log(`[Session] started: ${sessionName} (${id})`);
    this.io?.emit('sessionStarted', this.current);
    return this.current;
  }

  _makeInMemorySession() {
    return {
      id: uuidv4(),
      name: this._defaultName(),
      started_at: new Date(),
      ended_at: null,
    };
  }

  _defaultName() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `Session ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
}
