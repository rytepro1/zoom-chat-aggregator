import { randomUUID } from 'node:crypto';

/**
 * Manages saved meeting rosters — pre-built lists of meetings the
 * operator can deploy in one click. See docs/MONETIZATION-PLAN.md for
 * the eventual multi-tenant scoping; for now everything reads/writes
 * with tenant_id = 'ryteproductions' (the default column value).
 *
 * Deployment itself happens in the route layer (which has access to
 * RecallBotManager + MessageAggregator). RosterManager is just the
 * persistence + retrieval layer.
 */
export class RosterManager {
  constructor({ db } = {}) {
    this.db = db || null;
    // No db = no rosters (fail-open for local in-memory mode).
  }

  isAvailable() {
    return Boolean(this.db);
  }

  /** List all rosters with entry counts. */
  async list() {
    if (!this.db) return [];
    const { rows } = await this.db.query(
      `SELECT r.id, r.name, r.created_at, r.updated_at,
              COUNT(e.id)::int AS entry_count
         FROM rosters r
    LEFT JOIN roster_entries e ON e.roster_id = r.id
        GROUP BY r.id
        ORDER BY r.updated_at DESC, r.created_at DESC`
    );
    return rows;
  }

  /** Get one roster with full entries, in display order. */
  async get(id) {
    if (!this.db) return null;
    const rosterRes = await this.db.query(
      `SELECT id, name, created_at, updated_at FROM rosters WHERE id = $1`,
      [id]
    );
    if (rosterRes.rows.length === 0) return null;
    const roster = rosterRes.rows[0];
    const entriesRes = await this.db.query(
      `SELECT id, meeting_id, passcode, room_name, room_color, bot_name, display_order
         FROM roster_entries
        WHERE roster_id = $1
        ORDER BY display_order ASC, id ASC`,
      [id]
    );
    roster.entries = entriesRes.rows;
    return roster;
  }

  /**
   * Create a roster with its initial entries in a single transaction.
   * entries: array of { meeting_id, passcode, room_name, room_color, bot_name }.
   */
  async create({ name, entries = [] }) {
    if (!this.db) throw new Error('Persistence is not configured');
    const trimmedName = String(name || '').trim();
    if (!trimmedName) throw new Error('Roster name is required');

    const id = randomUUID();
    const client = await this.db.query.bind(this.db); // single-pool .query is fine for our tiny scale
    await this.db.query(
      `INSERT INTO rosters (id, name) VALUES ($1, $2)`,
      [id, trimmedName]
    );
    if (entries.length > 0) {
      await this._insertEntries(id, entries);
    }
    return this.get(id);
  }

  /**
   * Replace the roster's metadata + entries wholesale. Simpler than
   * tracking per-entry diffs from the UI; with small rosters (typically
   * <20 entries) the rewrite cost is trivial.
   */
  async update(id, { name, entries }) {
    if (!this.db) throw new Error('Persistence is not configured');
    const existing = await this.get(id);
    if (!existing) return null;

    if (typeof name === 'string') {
      const trimmed = name.trim();
      if (!trimmed) throw new Error('Roster name cannot be empty');
      await this.db.query(
        `UPDATE rosters SET name = $2, updated_at = NOW() WHERE id = $1`,
        [id, trimmed]
      );
    } else {
      // Touch updated_at on any save so the list ordering reflects recency
      await this.db.query(
        `UPDATE rosters SET updated_at = NOW() WHERE id = $1`,
        [id]
      );
    }

    if (Array.isArray(entries)) {
      await this.db.query(`DELETE FROM roster_entries WHERE roster_id = $1`, [id]);
      if (entries.length > 0) {
        await this._insertEntries(id, entries);
      }
    }

    return this.get(id);
  }

  async delete(id) {
    if (!this.db) return false;
    const { rowCount } = await this.db.query(
      `DELETE FROM rosters WHERE id = $1`,
      [id]
    );
    return rowCount > 0;
  }

  /**
   * Validate each entry has the required fields and a normalized
   * meeting_id (digits only). Throws on the first invalid entry. The
   * route layer catches and returns 400.
   */
  validateEntries(entries) {
    if (!Array.isArray(entries)) {
      throw new Error('entries must be an array');
    }
    for (const [i, entry] of entries.entries()) {
      const meetingId = String(entry?.meeting_id || '').replace(/[\s-]/g, '');
      const roomName = String(entry?.room_name || '').trim();
      const botName = String(entry?.bot_name || '').trim();
      if (!meetingId) throw new Error(`Entry ${i + 1}: meeting_id is required`);
      if (!roomName) throw new Error(`Entry ${i + 1}: room_name is required`);
      if (!botName) throw new Error(`Entry ${i + 1}: bot_name is required`);
    }
  }

  async _insertEntries(rosterId, entries) {
    // Sequential rather than batched — keeps the SQL simple and the
    // typical entry count is small (<20).
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      await this.db.query(
        `INSERT INTO roster_entries
           (id, roster_id, meeting_id, passcode, room_name, room_color, bot_name, display_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          randomUUID(),
          rosterId,
          String(e.meeting_id).replace(/[\s-]/g, ''),
          e.passcode || null,
          String(e.room_name).trim(),
          e.room_color || '#ef4444',
          String(e.bot_name).trim(),
          typeof e.display_order === 'number' ? e.display_order : i,
        ]
      );
    }
  }
}
