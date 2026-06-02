import { Router } from 'express';
import crypto from 'crypto';

/**
 * Presenter notes — short messages composed by moderators that show
 * only on the presenter pop-out view (not in moderator chat feeds,
 * not in Zoom rooms).
 *
 * Endpoints (all under /api, so the global requireAuth middleware
 * applies):
 *   GET    /api/presenter-notes        — active notes for the org
 *   POST   /api/presenter-notes        — { body, senderDisplay? }
 *   DELETE /api/presenter-notes/:id    — manual dismiss (any role)
 *
 * Socket events emitted to `org:<id>` room:
 *   presenterNote          — { id, body, senderDisplay, sentAt, dismissSeconds }
 *   presenterNoteDismissed — { id }
 *
 * "Active" filter (used by GET + initial socket payload):
 *   dismissed_at IS NULL
 *   AND (dismiss_seconds IS NULL OR sent_at > NOW() - INTERVAL …)
 */
export default function presenterNotesRouter() {
  const router = Router();

  router.get('/', async (req, res) => {
    const db = req.app.get('db');
    if (!db) return res.json({ notes: [], dismissSeconds: 60 });
    try {
      const dismissSeconds = await loadDismissSeconds(db, req.org.id);
      const { rows } = await db.query(
        `SELECT id, sender_display, body,
                EXTRACT(EPOCH FROM sent_at) AS sent_epoch
           FROM presenter_notes
          WHERE org_id = $1
            AND dismissed_at IS NULL
            AND ($2::int IS NULL OR sent_at > NOW() - ($2 || ' seconds')::interval)
          ORDER BY sent_at DESC
          LIMIT 5`,
        [req.org.id, dismissSeconds]
      );
      res.json({
        notes: rows.map(rowToNote),
        dismissSeconds,
      });
    } catch (err) {
      console.error('[presenter-notes] GET failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/', async (req, res) => {
    const db = req.app.get('db');
    const io = req.app.get('io');
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    const body = String(req.body?.body || '').trim();
    if (!body) return res.status(400).json({ error: 'Note body is required' });
    if (body.length > 200) {
      return res.status(400).json({ error: 'Note must be 200 characters or less' });
    }
    const senderDisplay = String(req.body?.senderDisplay || '').trim() || req.user.email;
    try {
      const id = crypto.randomUUID();
      await db.query(
        `INSERT INTO presenter_notes (id, org_id, sender_user_id, sender_display, body)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, req.org.id, req.user.id, senderDisplay, body]
      );
      const dismissSeconds = await loadDismissSeconds(db, req.org.id);
      const payload = {
        id,
        body,
        senderDisplay,
        sentAt: new Date().toISOString(),
        dismissSeconds,
      };
      io.to(`org:${req.org.id}`).emit('presenterNote', payload);
      res.status(201).json({ note: payload });
    } catch (err) {
      console.error('[presenter-notes] POST failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/:id', async (req, res) => {
    const db = req.app.get('db');
    const io = req.app.get('io');
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    try {
      const { rowCount } = await db.query(
        `UPDATE presenter_notes
            SET dismissed_at = NOW()
          WHERE id = $1 AND org_id = $2 AND dismissed_at IS NULL`,
        [req.params.id, req.org.id]
      );
      if (rowCount === 0) return res.status(404).json({ error: 'Note not found or already dismissed' });
      io.to(`org:${req.org.id}`).emit('presenterNoteDismissed', { id: req.params.id });
      res.json({ ok: true });
    } catch (err) {
      console.error(`[presenter-notes] DELETE ${req.params.id} failed:`, err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

/**
 * Helpers used by the auth-gated routes AND by the socket-handler's
 * initial-state hydration. Exported separately so the socket layer
 * can fetch active notes without going through HTTP.
 */
export async function loadDismissSeconds(db, orgId) {
  if (!db) return 60;
  const { rows } = await db.query(
    `SELECT production_note_dismiss_seconds AS s FROM organizations WHERE id = $1`,
    [orgId]
  );
  // null / undefined → 60 (default); explicit 0 → never auto-dismiss
  const s = rows[0]?.s;
  if (s === null || s === undefined) return 60;
  return s === 0 ? null : s;
}

export async function loadActiveNotes(db, orgId) {
  if (!db) return { notes: [], dismissSeconds: 60 };
  const dismissSeconds = await loadDismissSeconds(db, orgId);
  const { rows } = await db.query(
    `SELECT id, sender_display, body,
            EXTRACT(EPOCH FROM sent_at) AS sent_epoch
       FROM presenter_notes
      WHERE org_id = $1
        AND dismissed_at IS NULL
        AND ($2::int IS NULL OR sent_at > NOW() - ($2 || ' seconds')::interval)
      ORDER BY sent_at DESC
      LIMIT 5`,
    [orgId, dismissSeconds]
  );
  return { notes: rows.map(rowToNote), dismissSeconds };
}

function rowToNote(row) {
  return {
    id: row.id,
    body: row.body,
    senderDisplay: row.sender_display,
    sentAt: new Date(Number(row.sent_epoch) * 1000).toISOString(),
  };
}
