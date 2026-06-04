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
      `SELECT r.id, r.name, r.scheduled_for, r.created_at, r.updated_at,
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
      `SELECT id, name, scheduled_for, created_at, updated_at
         FROM rosters
        WHERE id = $1 AND org_id = $2`,
      [id, orgId]
    );
    if (rosterRes.rows.length === 0) return null;
    const roster = rosterRes.rows[0];
    const entriesRes = await this.db.query(
      `SELECT id, meeting_id, passcode, room_name, room_color, bot_name, meeting_url, panelist_email, register_panelist, display_order
         FROM roster_entries
        WHERE roster_id = $1
        ORDER BY display_order ASC, id ASC`,
      [id]
    );
    roster.entries = entriesRes.rows;
    return roster;
  }

  async create(orgId, { name, entries = [], scheduledFor = null }) {
    if (!this.db) throw new Error('Persistence is not configured');
    if (!orgId) throw new Error('orgId required');
    const trimmedName = String(name || '').trim();
    if (!trimmedName) throw new Error('Roster name is required');
    const schedTs = normalizeScheduled(scheduledFor);

    const id = randomUUID();
    await this.db.query(
      `INSERT INTO rosters (id, name, scheduled_for, org_id, tenant_id)
       VALUES ($1, $2, $3, $4, COALESCE($4, 'ryteproductions'))`,
      [id, trimmedName, schedTs, orgId]
    );
    if (entries.length > 0) await this._insertEntries(id, entries);
    return this.get(orgId, id);
  }

  async update(orgId, id, { name, entries, scheduledFor }) {
    if (!this.db) throw new Error('Persistence is not configured');
    if (!orgId) throw new Error('orgId required');
    const existing = await this.get(orgId, id);
    if (!existing) return null;

    // Build the SET clause dynamically so callers can update any
    // subset of fields without nulling the others.
    const sets = ['updated_at = NOW()'];
    const params = [id, orgId];
    if (typeof name === 'string') {
      const trimmed = name.trim();
      if (!trimmed) throw new Error('Roster name cannot be empty');
      params.push(trimmed);
      sets.push(`name = $${params.length}`);
    }
    if (scheduledFor !== undefined) {
      // null / empty string → clear; otherwise normalize to a Date
      params.push(normalizeScheduled(scheduledFor));
      sets.push(`scheduled_for = $${params.length}`);
    }
    await this.db.query(
      `UPDATE rosters SET ${sets.join(', ')} WHERE id = $1 AND org_id = $2`,
      params
    );

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
           (id, roster_id, meeting_id, passcode, room_name, room_color, bot_name, meeting_url, panelist_email, register_panelist, display_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          randomUUID(),
          rosterId,
          String(e.meeting_id).replace(/[\s-]/g, ''),
          e.passcode || null,
          String(e.room_name).trim(),
          e.room_color || '#ef4444',
          String(e.bot_name).trim(),
          (e.meeting_url && String(e.meeting_url).trim()) || null,
          (e.panelist_email && String(e.panelist_email).trim().toLowerCase()) || null,
          e.register_panelist === true,
          typeof e.display_order === 'number' ? e.display_order : i,
        ]
      );
    }
  }

  /**
   * Record the result of registering an entry as a panelist: stores the
   * returned join URL in meeting_url (so Deploy joins the bot as a
   * panelist) and the resolved panelist email (which may be an
   * auto-derived alias) for auditability.
   */
  async updateEntryRegistration(entryId, meetingUrl, panelistEmail) {
    if (!this.db) throw new Error('Persistence is not configured');
    await this.db.query(
      `UPDATE roster_entries
          SET meeting_url    = $2,
              panelist_email = COALESCE($3, panelist_email)
        WHERE id = $1`,
      [
        entryId,
        (meetingUrl && String(meetingUrl).trim()) || null,
        (panelistEmail && String(panelistEmail).trim().toLowerCase()) || null,
      ]
    );
  }
}

/**
 * Normalize a scheduled-for value (string | Date | null | empty) to either
 * a Date for the DB or null for "no schedule". Empty strings collapse to
 * null so the UI clearing the field clears the schedule.
 */
function normalizeScheduled(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  const d = new Date(value);
  if (isNaN(d.getTime())) {
    throw new Error('scheduled_for must be a valid date');
  }
  return d;
}
