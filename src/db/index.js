import pg from 'pg';

const { Pool } = pg;

/**
 * Database layer — Postgres via `pg`. Falls back to a no-op stub when
 * DATABASE_URL is not set, so the server stays usable in local dev
 * without a database (the in-memory MessageAggregator still works,
 * just without persistence).
 *
 * Schema is applied on first connection (CREATE TABLE IF NOT EXISTS),
 * so deploys are idempotent and we don't need a migrations framework
 * for a schema this small.
 */

let pool = null;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  timestamp   TIMESTAMPTZ NOT NULL,
  sender      TEXT NOT NULL,
  room        TEXT NOT NULL,
  room_color  TEXT,
  meeting_id  TEXT,
  content     TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'chat',
  saved       BOOLEAN NOT NULL DEFAULT FALSE,
  saved_at    TIMESTAMPTZ,
  note        TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_saved      ON messages(saved) WHERE saved = TRUE;
CREATE INDEX IF NOT EXISTS idx_messages_timestamp  ON messages(timestamp);
`;

/**
 * Initialize the connection pool and apply the schema. Returns a wrapped
 * pool with helper methods, or null if DATABASE_URL is not configured.
 *
 * Retries connection a few times because on Railway the web service can
 * start before Postgres is fully reachable.
 */
export async function initDatabase({ databaseUrl, retries = 5, retryDelayMs = 2000 } = {}) {
  if (!databaseUrl) {
    console.warn('[DB] DATABASE_URL not set — running without persistence');
    return null;
  }

  pool = new Pool({
    connectionString: databaseUrl,
    // Railway's internal Postgres doesn't need TLS; the public proxy
    // does. Detect by hostname.
    ssl: /\.proxy\.rlwy\.net/.test(databaseUrl) ? { rejectUnauthorized: false } : false,
    // Keep the pool small — single web service, ephemeral writes.
    max: 5,
    idleTimeoutMillis: 30000,
  });

  // Don't crash on unexpected pool errors — log and keep trying.
  pool.on('error', (err) => {
    console.error('[DB] Unexpected pool error:', err.message);
  });

  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query('SELECT 1');
      await pool.query(SCHEMA_SQL);
      console.log('[DB] connected and schema applied');
      return {
        query: (text, params) => pool.query(text, params),
        end: () => pool.end(),
      };
    } catch (err) {
      lastErr = err;
      console.warn(`[DB] connection attempt ${i + 1}/${retries} failed: ${err.message}`);
      if (i < retries - 1) {
        await new Promise(r => setTimeout(r, retryDelayMs));
      }
    }
  }

  console.error('[DB] giving up after retries — running without persistence:', lastErr?.message);
  await pool.end().catch(() => {});
  pool = null;
  return null;
}
