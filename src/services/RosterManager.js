import { randomUUID } from 'node:crypto';

/**
 * Manages saved meeting rosters — pre-built lists of meetings the
 * operator can deploy in one click.
 *
 * Scoping (Phase 2): every read/write is filtered by `orgId`. A roster
 * created in one org is invisible to other orgs even though they share
 * the rosters table. RosterManager is a singleton — the orgId is passed
 * per-call (not stored on the instance) since rosters are CRUD-only
 * (unlike SessionManager/MessageAggregator which hold per-org runtime
 * state).
 */
export class RosterManager {
  constructor({ db } = {}) {
    this.db = db || null;
  }

  isAvailable() {
    return Boolean(this.db);
  }

  async list(orgId) {
    if (!this.db) return [];
    if (!orgId) throw new Error('orgId required');
    const { rows } = await this.db.query(
      `SELECT r.id, r.name, r.created_at, r.updated_at,
              COUNT(e.id)::int AS entry_count
         FROM rosters r
    LEFT JOIN roster_entries e ON e.roster_id = r.id
        WHERE r.org_id = $1
        GROUP BY r.id
        ORDER BY r.updated_at DESC, r.created_at DESC`,
      [orgId]
    );
    return rows;
  }

  async get(orgId, id) {
    if (!this.db) return null;
    if (!orgId) throw new Error('orgId required');
    const rosterRes = await this.db.query(
      `SELECT id, name, created_at, updated_at
         FROM rosters
        WHERE id = $1 AND org_id = $2`,
      [id, orgId]
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

  async create(orgId, { name, entries = [] }) {
    if (!this.db) throw new Error('Persistence is not configured');
    if (!orgId) throw new Error('orgId required');
    const trimmedName = String(name || '').trim();
    if (!trimmedName) throw new Error('Roster name is required');

    const id = randomUUID();
    await this.db.query(
      `INSERT INTO rosters (id, name, org_id, tenant_id)
       VALUES ($1, $2, $3, COALESCE($3, 'ryteproductions'))`,
      [id, trimmedName, orgId]
    );
    if (entries.length > 0) await this._insertEntries(id, entries);
    return this.get(orgId, id);
  }

  async update(orgId, id, { name, entries }) {
    if (!this.db) throw new Error('Persistence is not configured');
    if (!orgId) throw new Error('orgId required');
    const existing = await this.get(orgId, id);
    if (!existing) return null;

    if (typeof name === 'string') {
      const trimmed = name.trim();
      if (!trimmed) throw new Error('Roster name cannot be empty');
      await this.db.query(
        `UPDATE rosters SET name = $2, updated_at = NOW()
          WHERE id = $1 AND org_id = $3`,
        [id, trimmed, orgId]
      );
    } else {
      await this.db.query(
        `UPDATE rosters SET updated_at = NOW()
          WHERE id = $1 AND org_id = $2`,
        [id, orgId]
      );
    }

    if (Array.isArray(entries)) {
      await this.db.query(`DELETE FROM roster_entries WHERE roster_id = $1`, [id]);
      if (entries.length > 0) await this._insertEntries(id, entries);
    }

    return this.get(orgId, id);
  }

  async delete(orgId, id) {
    if (!this.db) return false;
    if (!orgId) throw new Error('orgId required');
    const { rowCount } = await this.db.query(
      `DELETE FROM rosters WHERE id = $1 AND org_id = $2`,
      [id, orgId]
    );
    return rowCount > 0;
  }

  validateEntries(entries) {
    if (!Array.isArray(entries)) throw new Error('entries must be an array');
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
