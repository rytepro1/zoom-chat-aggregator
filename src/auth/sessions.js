import crypto from 'crypto';

/**
 * Server-side session storage. The session id (random 256-bit hex) lives
 * in an HTTP-only cookie; the row in `auth_sessions` is the source of
 * truth for who's signed in. Cheap to revoke (DELETE the row), no JWT
 * key rotation, no stale-token problem.
 *
 * Session lifetime: 30 days, sliding (touched on every authenticated
 * request via SESSION_TOUCH_THRESHOLD_MS).
 */

const SESSION_COOKIE_NAME = 'zoomchat_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// If a session is more than half-expired when used, extend it. Avoids a
// write on every request while still keeping active users signed in.
const SESSION_TOUCH_THRESHOLD_MS = SESSION_TTL_MS / 2;

function newSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

export async function createSession(db, userId) {
  const id = newSessionId();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.query(
    `INSERT INTO auth_sessions (id, user_id, expires_at) VALUES ($1, $2, $3)`,
    [id, userId, expiresAt]
  );
  return { id, expiresAt };
}

/**
 * Look up a session by id and return { user, org } if valid, else null.
 * Joins users + organizations in one round-trip so middleware has both
 * available on req.user / req.org.
 */
export async function validateSession(db, sessionId) {
  if (!sessionId) return null;
  const { rows } = await db.query(
    `SELECT s.id           AS session_id,
            s.expires_at   AS session_expires_at,
            u.id           AS user_id,
            u.email        AS user_email,
            u.role         AS user_role,
            u.email_verified AS user_email_verified,
            o.id           AS org_id,
            o.name         AS org_name,
            o.plan_tier    AS org_plan_tier,
            o.concurrent_bot_limit    AS org_concurrent_bot_limit,
            o.trial_minutes_remaining AS org_trial_minutes_remaining,
            o.stripe_customer_id      AS org_stripe_customer_id,
            o.stripe_subscription_id  AS org_stripe_subscription_id
       FROM auth_sessions s
       JOIN users u         ON u.id = s.user_id
       JOIN organizations o ON o.id = u.org_id
      WHERE s.id = $1`,
    [sessionId]
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  const expiresAt = new Date(row.session_expires_at);
  if (expiresAt.getTime() < Date.now()) {
    await db.query(`DELETE FROM auth_sessions WHERE id = $1`, [sessionId]);
    return null;
  }
  // Sliding expiry: bump if more than halfway used.
  const remaining = expiresAt.getTime() - Date.now();
  if (remaining < SESSION_TOUCH_THRESHOLD_MS) {
    const newExpiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await db.query(`UPDATE auth_sessions SET expires_at = $1 WHERE id = $2`, [newExpiresAt, sessionId]);
  }
  return {
    sessionId: row.session_id,
    user: {
      id: row.user_id,
      email: row.user_email,
      role: row.user_role,
      emailVerified: row.user_email_verified,
    },
    org: {
      id: row.org_id,
      name: row.org_name,
      planTier: row.org_plan_tier,
      concurrentBotLimit: row.org_concurrent_bot_limit,
      trialMinutesRemaining: row.org_trial_minutes_remaining,
      stripeCustomerId: row.org_stripe_customer_id,
      stripeSubscriptionId: row.org_stripe_subscription_id,
    },
  };
}

export async function invalidateSession(db, sessionId) {
  if (!sessionId) return;
  await db.query(`DELETE FROM auth_sessions WHERE id = $1`, [sessionId]);
}

export async function invalidateAllSessionsForUser(db, userId) {
  await db.query(`DELETE FROM auth_sessions WHERE user_id = $1`, [userId]);
}

// Cookie helpers — keep all the cookie shape decisions in one place.

export function setSessionCookie(res, sessionId, expiresAt) {
  res.cookie(SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    expires: expiresAt,
    path: '/',
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
}

export function readSessionCookie(req) {
  return req.cookies?.[SESSION_COOKIE_NAME] || null;
}

export const COOKIE_NAME = SESSION_COOKIE_NAME;
