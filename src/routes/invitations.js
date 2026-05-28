import { Router } from 'express';
import crypto from 'crypto';
import { requireAuth, requireAdmin } from '../auth/middleware.js';
import { hashPassword } from '../auth/passwords.js';
import { createSession, setSessionCookie } from '../auth/sessions.js';
import { sendInvitationEmail } from '../auth/email.js';

/**
 * Team invitation routes — admins invite users by email, recipients
 * accept via a tokenized link to create their account in the org.
 *
 * Auth model:
 *   - List / create / revoke require requireAdmin (org admin role)
 *   - GET /accept/:token (public) — validates the token and returns the
 *     invite metadata so the signup form can show "you've been invited to
 *     {org}"
 *   - POST /accept (public) — completes signup: creates the user row,
 *     sets the session cookie, marks the invite consumed
 *
 * Invite lifetime is 7 days (set when the row is created).
 */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export default function invitationsRouter() {
  const router = Router();

  // ---- Admin-only: list invitations and team members ----

  router.get('/', requireAuth, requireAdmin, async (req, res) => {
    const db = req.app.get('db');
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    try {
      const members = await db.query(
        `SELECT id, email, role, email_verified, created_at, last_login_at
           FROM users
          WHERE org_id = $1
          ORDER BY created_at ASC`,
        [req.org.id]
      );
      const pending = await db.query(
        `SELECT id, email, role, created_at, expires_at
           FROM invitations
          WHERE org_id = $1 AND accepted_at IS NULL AND expires_at > NOW()
          ORDER BY created_at DESC`,
        [req.org.id]
      );
      res.json({ members: members.rows, invitations: pending.rows });
    } catch (err) {
      console.error('[invitations] GET / failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/', requireAuth, requireAdmin, async (req, res) => {
    const db = req.app.get('db');
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    const { email, role = 'operator' } = req.body || {};
    const cleanEmail = normalizeEmail(email);
    if (!cleanEmail) return res.status(400).json({ error: 'Valid email is required' });
    if (!['admin', 'operator'].includes(role)) {
      return res.status(400).json({ error: 'Role must be admin or operator' });
    }

    try {
      // Already a member of this org? Block.
      const existingUser = await db.query(
        `SELECT 1 FROM users WHERE email = $1 AND org_id = $2`,
        [cleanEmail, req.org.id]
      );
      if (existingUser.rows.length > 0) {
        return res.status(409).json({ error: `${cleanEmail} is already a member of this organization.` });
      }
      // Already invited (still pending)? Resend (replace existing token).
      await db.query(
        `DELETE FROM invitations WHERE org_id = $1 AND email = $2 AND accepted_at IS NULL`,
        [req.org.id, cleanEmail]
      );

      const id = crypto.randomUUID();
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
      await db.query(
        `INSERT INTO invitations (id, org_id, email, role, invited_by, token, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, req.org.id, cleanEmail, role, req.user.id, token, expiresAt]
      );

      sendInvitationEmail({
        to: cleanEmail,
        token,
        orgName: req.org.name,
        inviterEmail: req.user.email,
      });

      res.status(201).json({
        invitation: { id, email: cleanEmail, role, expiresAt },
      });
    } catch (err) {
      console.error('[invitations] POST / failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
    const db = req.app.get('db');
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    try {
      const { rowCount } = await db.query(
        `DELETE FROM invitations WHERE id = $1 AND org_id = $2 AND accepted_at IS NULL`,
        [req.params.id, req.org.id]
      );
      if (rowCount === 0) return res.status(404).json({ error: 'Invitation not found' });
      res.json({ ok: true });
    } catch (err) {
      console.error(`[invitations] DELETE ${req.params.id} failed:`, err);
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/members/:userId', requireAuth, requireAdmin, async (req, res) => {
    const db = req.app.get('db');
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    if (req.params.userId === req.user.id) {
      return res.status(400).json({ error: "You can't remove yourself. Have another admin do it, or delete your org." });
    }
    try {
      const { rowCount } = await db.query(
        `DELETE FROM users WHERE id = $1 AND org_id = $2`,
        [req.params.userId, req.org.id]
      );
      if (rowCount === 0) return res.status(404).json({ error: 'Member not found' });
      res.json({ ok: true });
    } catch (err) {
      console.error(`[invitations] DELETE member ${req.params.userId} failed:`, err);
      res.status(500).json({ error: err.message });
    }
  });

  router.patch('/members/:userId', requireAuth, requireAdmin, async (req, res) => {
    const db = req.app.get('db');
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    const { role } = req.body || {};
    if (!['admin', 'operator'].includes(role)) {
      return res.status(400).json({ error: 'Role must be admin or operator' });
    }
    try {
      const { rowCount } = await db.query(
        `UPDATE users SET role = $3 WHERE id = $1 AND org_id = $2`,
        [req.params.userId, req.org.id, role]
      );
      if (rowCount === 0) return res.status(404).json({ error: 'Member not found' });
      res.json({ ok: true });
    } catch (err) {
      console.error(`[invitations] PATCH member ${req.params.userId} failed:`, err);
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Public: accept-invite landing ----

  router.get('/accept/:token', async (req, res) => {
    const db = req.app.get('db');
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    try {
      const { rows } = await db.query(
        `SELECT i.id, i.email, i.role, i.expires_at, o.name AS org_name
           FROM invitations i
           JOIN organizations o ON o.id = i.org_id
          WHERE i.token = $1 AND i.accepted_at IS NULL AND i.expires_at > NOW()`,
        [req.params.token]
      );
      if (rows.length === 0) {
        return res.status(404).json({ error: 'Invitation is invalid or expired.' });
      }
      const inv = rows[0];
      res.json({
        invitation: {
          email: inv.email,
          role: inv.role,
          orgName: inv.org_name,
          expiresAt: inv.expires_at,
        },
      });
    } catch (err) {
      console.error('[invitations] GET /accept failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/accept', async (req, res) => {
    const db = req.app.get('db');
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    const { token, password } = req.body || {};
    if (!token) return res.status(400).json({ error: 'Token is required' });
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    try {
      // Atomically consume the invite. Returning row gives us org_id + role
      // + email; if no row returned, token was invalid/expired/used.
      const { rows: invRows } = await db.query(
        `UPDATE invitations SET accepted_at = NOW()
          WHERE token = $1 AND accepted_at IS NULL AND expires_at > NOW()
       RETURNING id, org_id, email, role`,
        [token]
      );
      if (invRows.length === 0) {
        return res.status(400).json({ error: 'Invitation is invalid, expired, or already used.' });
      }
      const inv = invRows[0];

      // If a user with this email already exists somewhere — refuse. The
      // recipient should sign in to that account and we'll add a "join
      // existing user to org" flow later if needed.
      const existing = await db.query(`SELECT 1 FROM users WHERE email = $1`, [inv.email]);
      if (existing.rows.length > 0) {
        // Unconsume the invite so the admin can retry once the conflict
        // resolves.
        await db.query(`UPDATE invitations SET accepted_at = NULL WHERE id = $1`, [inv.id]);
        return res.status(409).json({ error: 'A user with this email already exists. Sign in to that account instead.' });
      }

      const userId = crypto.randomUUID();
      const passwordHash = await hashPassword(password);
      await db.query(
        `INSERT INTO users (id, org_id, email, password_hash, role, email_verified)
         VALUES ($1, $2, $3, $4, $5, TRUE)`,
        [userId, inv.org_id, inv.email, passwordHash, inv.role]
      );

      const { id: sessionId, expiresAt } = await createSession(db, userId);
      setSessionCookie(res, sessionId, expiresAt);
      await db.query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [userId]);

      res.status(201).json({
        user: { email: inv.email, role: inv.role, emailVerified: true },
        org: { id: inv.org_id },
      });
    } catch (err) {
      console.error('[invitations] POST /accept failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

function normalizeEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const trimmed = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null;
  return trimmed;
}
