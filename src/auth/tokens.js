import crypto from 'crypto';

/**
 * One-shot email tokens for verification and password reset. The token
 * the user clicks in their email IS the database row id — single-use
 * (used_at is stamped on consume), time-limited (24h), and deleted
 * cascade-style when the user is deleted.
 *
 * Types: 'verify' (sent at signup) | 'reset' (sent on forgot-password)
 */

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function newTokenId() {
  return crypto.randomBytes(32).toString('hex');
}

export async function createEmailToken(db, userId, type) {
  if (!['verify', 'reset'].includes(type)) {
    throw new Error(`Invalid token type: ${type}`);
  }
  const id = newTokenId();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  await db.query(
    `INSERT INTO email_tokens (id, user_id, type, expires_at) VALUES ($1, $2, $3, $4)`,
    [id, userId, type, expiresAt]
  );
  return id;
}

/**
 * Look up + atomically consume a token. Returns { userId } if valid,
 * else null. Token can only be consumed once.
 */
export async function consumeEmailToken(db, token, expectedType) {
  if (!token) return null;
  const { rows } = await db.query(
    `UPDATE email_tokens
        SET used_at = NOW()
      WHERE id = $1
        AND type = $2
        AND used_at IS NULL
        AND expires_at > NOW()
      RETURNING user_id`,
    [token, expectedType]
  );
  if (rows.length === 0) return null;
  return { userId: rows[0].user_id };
}
