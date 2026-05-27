import { Router } from 'express';
import crypto from 'crypto';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import {
  createSession,
  invalidateSession,
  invalidateAllSessionsForUser,
  setSessionCookie,
  clearSessionCookie,
  readSessionCookie,
} from '../auth/sessions.js';
import { createEmailToken, consumeEmailToken } from '../auth/tokens.js';
import {
  sendVerificationEmail,
  sendPasswordResetEmail,
} from '../auth/email.js';

/**
 * Auth routes — signup, login, logout, /me, email verification, password
 * reset. Mounted under /api/auth in src/server/index.js.
 *
 * All DB-touching handlers require req.app.get('db') to be set. If it's
 * null (DATABASE_URL not configured), auth is a no-op — the existing
 * unauthenticated app keeps working in local dev without Postgres.
 */
export default function authRouter() {
  const router = Router();

  router.post('/signup', async (req, res) => {
    const db = req.app.get('db');
    if (!db) return res.status(503).json({ error: 'Auth requires the database to be configured.' });

    const { email, password, orgName } = req.body || {};
    const cleanEmail = normalizeEmail(email);
    if (!cleanEmail) return res.status(400).json({ error: 'Valid email is required' });
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    try {
      const existing = await db.query(`SELECT 1 FROM users WHERE email = $1`, [cleanEmail]);
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'An account with that email already exists.' });
      }

      const passwordHash = await hashPassword(password);
      const userId = crypto.randomUUID();
      const orgId = crypto.randomUUID();
      const orgDisplayName = (orgName && String(orgName).trim()) || cleanEmail.split('@')[1] || 'My Organization';

      // First signup with no users yet → bootstrap as RYTE admin if they're
      // signing up against the existing ryte-org (no users attached yet).
      // Otherwise, a new org is created on the trial plan.
      const ryteOrgEmpty = await db.query(
        `SELECT 1 FROM organizations o
          WHERE o.id = 'ryte-org'
            AND NOT EXISTS (SELECT 1 FROM users u WHERE u.org_id = o.id)`
      );

      let finalOrgId;
      let finalRole;
      if (ryteOrgEmpty.rows.length > 0) {
        // Bootstrap: first ever signup claims the RYTE admin org.
        finalOrgId = 'ryte-org';
        finalRole = 'admin';
      } else {
        await db.query(
          `INSERT INTO organizations (id, name, plan_tier, concurrent_bot_limit, trial_minutes_remaining)
           VALUES ($1, $2, 'trial', 1, 30)`,
          [orgId, orgDisplayName]
        );
        finalOrgId = orgId;
        finalRole = 'admin';
      }

      await db.query(
        `INSERT INTO users (id, org_id, email, password_hash, role)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, finalOrgId, cleanEmail, passwordHash, finalRole]
      );

      // Send verification email (fire-and-forget — failure is logged
      // but doesn't block signup; user can request resend).
      const token = await createEmailToken(db, userId, 'verify');
      sendVerificationEmail({ to: cleanEmail, token });

      // Create session + set cookie so the user is signed in immediately.
      const { id: sessionId, expiresAt } = await createSession(db, userId);
      setSessionCookie(res, sessionId, expiresAt);

      await db.query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [userId]);

      return res.status(201).json({
        user: { email: cleanEmail, role: finalRole, emailVerified: false },
        org: { id: finalOrgId, name: orgDisplayName },
      });
    } catch (err) {
      console.error('[auth] /signup failed:', err);
      return res.status(500).json({ error: err.message || 'Signup failed' });
    }
  });

  router.post('/login', async (req, res) => {
    const db = req.app.get('db');
    if (!db) return res.status(503).json({ error: 'Auth requires the database to be configured.' });

    const { email, password } = req.body || {};
    const cleanEmail = normalizeEmail(email);
    if (!cleanEmail || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    try {
      const { rows } = await db.query(
        `SELECT id, password_hash FROM users WHERE email = $1`,
        [cleanEmail]
      );
      if (rows.length === 0) {
        // Use the same wording for "no such user" and "wrong password" to
        // not leak which one it was.
        return res.status(401).json({ error: 'Invalid email or password' });
      }
      const ok = await verifyPassword(password, rows[0].password_hash);
      if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

      const { id: sessionId, expiresAt } = await createSession(db, rows[0].id);
      setSessionCookie(res, sessionId, expiresAt);
      await db.query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [rows[0].id]);

      return res.json({ ok: true });
    } catch (err) {
      console.error('[auth] /login failed:', err);
      return res.status(500).json({ error: 'Login failed' });
    }
  });

  router.post('/logout', async (req, res) => {
    const db = req.app.get('db');
    const sessionId = readSessionCookie(req);
    if (db && sessionId) {
      await invalidateSession(db, sessionId).catch((e) => console.error('[auth] logout:', e.message));
    }
    clearSessionCookie(res);
    return res.json({ ok: true });
  });

  router.get('/me', async (req, res) => {
    // attachUser middleware already populated req.user / req.org if signed in.
    if (!req.user) return res.json({ user: null, org: null });
    return res.json({ user: req.user, org: req.org });
  });

  router.post('/verify-email', async (req, res) => {
    const db = req.app.get('db');
    if (!db) return res.status(503).json({ error: 'Auth requires the database to be configured.' });
    const { token } = req.body || {};
    const result = await consumeEmailToken(db, token, 'verify');
    if (!result) return res.status(400).json({ error: 'Invalid or expired verification link.' });
    await db.query(`UPDATE users SET email_verified = TRUE WHERE id = $1`, [result.userId]);
    return res.json({ ok: true });
  });

  router.post('/resend-verification', async (req, res) => {
    const db = req.app.get('db');
    if (!db) return res.status(503).json({ error: 'Auth requires the database to be configured.' });
    if (!req.user) return res.status(401).json({ error: 'Sign in first.' });
    if (req.user.emailVerified) return res.json({ ok: true });
    const token = await createEmailToken(db, req.user.id, 'verify');
    sendVerificationEmail({ to: req.user.email, token });
    return res.json({ ok: true });
  });

  router.post('/password-reset/request', async (req, res) => {
    const db = req.app.get('db');
    if (!db) return res.status(503).json({ error: 'Auth requires the database to be configured.' });
    const { email } = req.body || {};
    const cleanEmail = normalizeEmail(email);
    // Always return ok to avoid leaking which emails are registered.
    if (!cleanEmail) return res.json({ ok: true });

    const { rows } = await db.query(`SELECT id FROM users WHERE email = $1`, [cleanEmail]);
    if (rows.length > 0) {
      const token = await createEmailToken(db, rows[0].id, 'reset');
      sendPasswordResetEmail({ to: cleanEmail, token });
    }
    return res.json({ ok: true });
  });

  router.post('/password-reset/confirm', async (req, res) => {
    const db = req.app.get('db');
    if (!db) return res.status(503).json({ error: 'Auth requires the database to be configured.' });
    const { token, password } = req.body || {};
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    const result = await consumeEmailToken(db, token, 'reset');
    if (!result) return res.status(400).json({ error: 'Invalid or expired reset link.' });
    const passwordHash = await hashPassword(password);
    await db.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [passwordHash, result.userId]);
    // Sign out everywhere — anyone with a stolen session for this user
    // gets booted when the password changes.
    await invalidateAllSessionsForUser(db, result.userId);
    return res.json({ ok: true });
  });

  return router;
}

function normalizeEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const trimmed = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null;
  return trimmed;
}
