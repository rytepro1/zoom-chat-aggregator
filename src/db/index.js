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

-- Per-bot usage tracking for the eventual SaaS billing layer.
-- Populated by RecallBotManager.connect (joined_at) and updated by
-- /webhook/recall/status when the bot reaches a terminal state, OR by
-- RecallBotManager.disconnect when the operator removes the bot manually.
-- See docs/MONETIZATION-PLAN.md.
CREATE TABLE IF NOT EXISTS bot_usage (
  id                TEXT PRIMARY KEY,
  recall_bot_id     TEXT NOT NULL,
  meeting_id        TEXT,
  session_id        TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  tenant_id         TEXT NOT NULL DEFAULT 'ryteproductions',
  joined_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  left_at           TIMESTAMPTZ,
  duration_seconds  INTEGER,
  last_status       TEXT,
  billed            BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_bot_usage_recall_bot_id ON bot_usage(recall_bot_id);
CREATE INDEX IF NOT EXISTS idx_bot_usage_session       ON bot_usage(session_id);
CREATE INDEX IF NOT EXISTS idx_bot_usage_billing       ON bot_usage(tenant_id, billed, left_at);

-- Outbound chat audit log. Every message sent via the bot (reply or
-- broadcast) writes a row here. Provides post-hoc evidence of what
-- went out + becomes the basis for "who sent it" attribution once auth
-- lands. is_broadcast distinguishes single-room reply (false) from
-- multi-room broadcast (true — multiple rows written, one per bot).
CREATE TABLE IF NOT EXISTS sent_messages (
  id              TEXT PRIMARY KEY,
  recall_bot_id   TEXT NOT NULL,
  meeting_id      TEXT,
  session_id      TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  tenant_id       TEXT NOT NULL DEFAULT 'ryteproductions',
  text            TEXT NOT NULL,
  is_broadcast    BOOLEAN NOT NULL DEFAULT FALSE,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sent_messages_bot         ON sent_messages(recall_bot_id);
CREATE INDEX IF NOT EXISTS idx_sent_messages_tenant_time ON sent_messages(tenant_id, sent_at);

-- Saved meeting rosters — operator pre-builds a list of meetings
-- (with IDs, passcodes, room names, colors, bot display names) and
-- deploys them all at once. Useful for recurring shows and for
-- recovering quickly after a quit-and-relaunch (just deploy the same
-- roster instead of re-typing each meeting).
CREATE TABLE IF NOT EXISTS rosters (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  tenant_id   TEXT NOT NULL DEFAULT 'ryteproductions',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS roster_entries (
  id            TEXT PRIMARY KEY,
  roster_id     TEXT NOT NULL REFERENCES rosters(id) ON DELETE CASCADE,
  meeting_id    TEXT NOT NULL,
  passcode      TEXT,
  room_name     TEXT NOT NULL,
  room_color    TEXT NOT NULL DEFAULT '#ef4444',
  bot_name      TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_rosters_tenant       ON rosters(tenant_id);
CREATE INDEX IF NOT EXISTS idx_roster_entries_order ON roster_entries(roster_id, display_order);

-- Tenant id placeholder on existing tables. Default value is a stand-in
-- until multi-tenant auth lands; the migration to real org ids is then
-- "UPDATE … SET tenant_id = <real org>", not a schema change. See
-- docs/MONETIZATION-PLAN.md, "What we could do right now to make
-- Phase 1 easier later".
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'ryteproductions';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'ryteproductions';
CREATE INDEX IF NOT EXISTS idx_sessions_tenant ON sessions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_messages_tenant ON messages(tenant_id);

-- ============================================
-- MONETIZATION SCHEMA (Phase 1)
-- See docs/MONETIZATION-PLAN.md for the design rationale.
-- ============================================

-- Organizations are the unit of billing. Every user belongs to exactly
-- one org. plan_tier='admin' is a permanent RYTE-only tier that bypasses
-- trial limits; 'trial' is the default for new signups (30 min, 1 bot);
-- 'solo' is the paid $49/mo tier.
CREATE TABLE IF NOT EXISTS organizations (
  id                       TEXT PRIMARY KEY,
  name                     TEXT NOT NULL,
  plan_tier                TEXT NOT NULL DEFAULT 'trial',
  concurrent_bot_limit     INTEGER NOT NULL DEFAULT 1,
  trial_minutes_remaining  INTEGER,
  stripe_customer_id       TEXT UNIQUE,
  stripe_subscription_id   TEXT UNIQUE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email           TEXT UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'operator',
  email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id);

-- Server-side sessions. The session id (random 256-bit hex) is stored
-- in an HTTP-only cookie; row is looked up on every authenticated
-- request. Cheaper than JWT for revocation (just DELETE the row).
CREATE TABLE IF NOT EXISTS auth_sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user    ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);

-- One-shot tokens for email verification and password reset. Tokens are
-- single-use (used_at gets stamped) and time-limited (expires_at).
CREATE TABLE IF NOT EXISTS email_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON email_tokens(user_id);

-- Team invitations. Admin generates a link, recipient clicks → signup.
CREATE TABLE IF NOT EXISTS invitations (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'operator',
  invited_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  token        TEXT UNIQUE NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  accepted_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_invitations_org   ON invitations(org_id);
CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations(email);

-- Add org_id to existing tenant-scoped tables. Lives alongside the old
-- tenant_id column for now — Phase 2 backfills, Phase 7+ drops tenant_id.
ALTER TABLE sessions      ADD COLUMN IF NOT EXISTS org_id TEXT REFERENCES organizations(id);
ALTER TABLE messages      ADD COLUMN IF NOT EXISTS org_id TEXT REFERENCES organizations(id);
ALTER TABLE bot_usage     ADD COLUMN IF NOT EXISTS org_id TEXT REFERENCES organizations(id);
ALTER TABLE sent_messages ADD COLUMN IF NOT EXISTS org_id TEXT REFERENCES organizations(id);
ALTER TABLE rosters       ADD COLUMN IF NOT EXISTS org_id TEXT REFERENCES organizations(id);
CREATE INDEX IF NOT EXISTS idx_sessions_org      ON sessions(org_id);
CREATE INDEX IF NOT EXISTS idx_messages_org      ON messages(org_id);
CREATE INDEX IF NOT EXISTS idx_bot_usage_org     ON bot_usage(org_id);
CREATE INDEX IF NOT EXISTS idx_sent_messages_org ON sent_messages(org_id);
CREATE INDEX IF NOT EXISTS idx_rosters_org       ON rosters(org_id);
`;

// One-shot data migration: create the RYTE org and backfill org_id on
// all existing rows tagged with tenant_id='ryteproductions'. Idempotent
// — re-running is a no-op once everything has org_id set.
const MIGRATION_SQL = `
INSERT INTO organizations (id, name, plan_tier, concurrent_bot_limit, trial_minutes_remaining)
VALUES ('ryte-org', 'RYTE Productions', 'admin', 999, NULL)
ON CONFLICT (id) DO NOTHING;

UPDATE sessions      SET org_id = 'ryte-org' WHERE org_id IS NULL AND tenant_id = 'ryteproductions';
UPDATE messages      SET org_id = 'ryte-org' WHERE org_id IS NULL AND tenant_id = 'ryteproductions';
UPDATE bot_usage     SET org_id = 'ryte-org' WHERE org_id IS NULL AND tenant_id = 'ryteproductions';
UPDATE sent_messages SET org_id = 'ryte-org' WHERE org_id IS NULL AND tenant_id = 'ryteproductions';
UPDATE rosters       SET org_id = 'ryte-org' WHERE org_id IS NULL AND tenant_id = 'ryteproductions';
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
      await pool.query(MIGRATION_SQL);
      console.log('[DB] connected, schema applied, migrations run');
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
