# PostgreSQL + node-postgres (pg)

> Durable persistence layer for all sessions, messages, billing state, and rosters — node-postgres (`pg`) **^8.21** connecting to a Railway-managed PostgreSQL instance.

---

## How we use it

### Initialization (`src/db/index.js`)

`initDatabase()` (called once in `src/server/index.js:595`) constructs a single `Pool`, runs a connectivity probe (`SELECT 1`), then fires the full `SCHEMA_SQL` block followed by `MIGRATION_SQL` in series. Both blocks are idempotent (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, `INSERT … ON CONFLICT DO NOTHING`, and conditional `UPDATE`s), so redeploying never re-runs destructive changes.

The function returns a thin wrapper `{ query, end }` — every service in the codebase receives this wrapper, never the raw pool. If `DATABASE_URL` is absent the wrapper returns `null`; every service checks `if (!this.db)` before any DB call and falls back to in-memory operation (`src/db/index.js:7-11`).

```
Pool config (src/db/index.js:271-281)
  connectionString: process.env.DATABASE_URL
  ssl: { rejectUnauthorized: false }  — when hostname ends in .proxy.rlwy.net
       false                          — internal Railway private-network URL
  max: 25
  idleTimeoutMillis: 30000
```

A `pool.on('error')` handler (`src/db/index.js:284-286`) absorbs unexpected idle-client errors so a stale backend connection never crashes the process. Startup failures are retried up to 5 times with a 2-second delay before the server falls back to in-memory mode (`src/db/index.js:288-311`).

### MessageAggregator (`src/services/MessageAggregator.js`)

Every inbound chat message from a Recall bot webhook calls `addMessage()`, which fires an `INSERT INTO messages` (`src/services/MessageAggregator.js:141-161`). Errors are caught and logged — a DB write failure never drops the live Socket.io broadcast.

`hydrate()` is called once per org on startup and loads the last `maxMessages` (500) rows for the active session into the in-memory ring buffer so reconnecting clients see the session-so-far without a round-trip on every message (`src/services/MessageAggregator.js:83-97`).

`setSaved()` issues an `UPDATE messages … RETURNING` with org-scoping (`src/services/MessageAggregator.js:176-195`); `getSavedMessages()` queries `WHERE saved = TRUE AND org_id = $2` (`src/services/MessageAggregator.js:209-217`).

### SessionManager (`src/services/SessionManager.js`)

One instance per org. `init()` searches for an open session (`ended_at IS NULL AND org_id = $1`) and reopens it, or creates a new one. `end()` sets `ended_at = NOW()` and immediately creates the next session. `rename()` and `list()` are thin `UPDATE`/`SELECT` calls. All queries carry `($n::text IS NULL OR org_id = $n)` guards so a `null` orgId (legacy single-tenant code) still works without filtering (`src/services/SessionManager.js:50-58`).

### RosterManager (`src/services/RosterManager.js`)

Singleton; `orgId` is passed per-call rather than stored. `_insertEntries()` loops and fires individual `INSERT INTO roster_entries` — one query per row, no batch INSERT (`src/services/RosterManager.js:134-154`). `update()` does a full delete-and-reinsert for entries rather than a MERGE/upsert (`src/services/RosterManager.js:104-108`).

### RecallBotManager (`src/recall/RecallBotManager.js`)

`connect()` writes a `bot_usage` row on every bot dispatch (`src/recall/RecallBotManager.js:323-331`). `disconnect()` and `handleStatusChangeEvent()` (called by `/webhook/recall/status`) both close the row with COALESCE-guarded `UPDATE` so whichever fires first wins and the second is a no-op:

```sql
UPDATE bot_usage
   SET left_at          = COALESCE(left_at, NOW()),
       duration_seconds = COALESCE(duration_seconds, CAST(EXTRACT(EPOCH FROM (NOW() - joined_at)) AS INTEGER)),
       last_status      = COALESCE(last_status, 'disconnected_by_operator')
 WHERE recall_bot_id = $1
```

`_auditSentMessage()` inserts a `sent_messages` row on every outbound chat (`src/recall/RecallBotManager.js:679-700`).

### Stripe webhook (`src/routes/webhook.js`)

Three `UPDATE organizations` queries update `plan_tier`, `concurrent_bot_limit`, `stripe_subscription_id`, and `trial_minutes_remaining` in response to `checkout.session.completed`, `customer.subscription.updated`, and `customer.subscription.deleted` events (`src/routes/webhook.js:255-309`). The `db` handle comes from `app.get('db')` passed into the route at mount time.

---

## Core concepts

**Connection pool**: The `Pool` manages a bounded set of TCP connections to Postgres (max 25 here). `pool.query()` checks out an idle client, runs the query, and returns the client automatically — safe for independent statements. For a transaction you must hold a dedicated client: `pool.connect()` → `BEGIN` → queries → `COMMIT`/`ROLLBACK` → `client.release()`.

**Parameterized queries**: All user-controlled values must go through the `$1, $2, …` placeholder syntax. pg sends the parameter values out-of-band from the query text; PostgreSQL's server-side substitution prevents SQL injection. Dynamic identifiers (table/column names) cannot be parameterized — use `pg-format` if you ever need dynamic DDL.

**Query result shape**: Every `pool.query()` / `client.query()` call returns `{ rows: Object[], rowCount: number, fields: FieldDef[] }`. `rowCount` is the number of rows affected (INSERT/UPDATE/DELETE) or returned (SELECT); `rows` is always an array (empty for zero-result queries). `RETURNING` on DML populates `rows` exactly like a SELECT.

**Idempotent schema**: We use the `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE … ADD COLUMN IF NOT EXISTS` pattern plus `INSERT … ON CONFLICT DO NOTHING` instead of a versioned migration framework. This is correct for a small, append-only schema but carries risks described in **Risks / TODOs** below.

**Multi-tenancy columns**: `tenant_id` (legacy string, default `'ryteproductions'`) and `org_id` (FK → `organizations.id`) live side-by-side on `sessions`, `messages`, `bot_usage`, `sent_messages`, and `rosters`. Phase 2 backfills `org_id`; Phase 7+ drops `tenant_id`. All runtime queries filter on `org_id`; `tenant_id` is only written for backfill compatibility.

**COALESCE-based idempotent updates**: The bot_usage close-out pattern `SET left_at = COALESCE(left_at, NOW())` is used intentionally so two concurrent updaters (operator disconnect + Recall status webhook) cannot stomp each other.

---

## API / SDK surface we touch

| Method / Object | Where used | Notes |
|---|---|---|
| `new Pool({ connectionString, ssl, max, idleTimeoutMillis })` | `src/db/index.js:271` | Our only Pool constructor call |
| `pool.query(text, params)` | Wrapped by `db.query` everywhere | Used for every statement |
| `pool.on('error', fn)` | `src/db/index.js:284` | Prevents process crash on idle-client errors |
| `pool.end()` | `src/db/index.js:309` | Called on startup failure to drain the pool before returning null |
| `pool.connect()` | NOT USED | Required for transactions — none in our codebase yet |
| `client.release()` | NOT USED | Required if you ever call `pool.connect()` manually |
| `pool.totalCount` / `idleCount` / `waitingCount` | NOT USED | Useful for health-check endpoint monitoring |
| `onConnect` callback (pg@8.20+) | NOT USED | Could set per-connection `SET statement_timeout` defaults |

We do **not** use: cursors, prepared statements (`name` property on QueryConfig), streaming, `LISTEN`/`NOTIFY`, the native `pg-native` bindings, or the `pg-pool` package independently.

---

## Auth & secrets

| Variable | Purpose | Where read |
|---|---|---|
| `DATABASE_URL` | Full connection string (postgres://user:pass@host:port/db) | `src/server/index.js:595`, `src/db/index.js:265` |

`DATABASE_URL` is the single credential. It is set in Railway's environment variables panel and injected automatically when the app service references the Postgres plugin. It is never logged; the pool only ever logs `err.message` on failures.

**SSL detection** (`src/db/index.js:274-276`): The code tests whether `DATABASE_URL` contains `.proxy.rlwy.net`. If yes, `ssl: { rejectUnauthorized: false }` is used — necessary because Railway's public TCP proxy presents a self-signed certificate. For the private internal URL (no `.proxy.rlwy.net` in the hostname) `ssl: false` is set, which is safe because traffic stays within Railway's internal network.

No other Postgres credentials (PGUSER, PGPASSWORD, etc.) are used. Railway also exposes individual `PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE` variables, but we only consume `DATABASE_URL`.

---

## Webhooks / events

PostgreSQL `LISTEN`/`NOTIFY` is not used. There are no pg-level event subscriptions in our codebase. Recall bot lifecycle events arrive over HTTP webhooks and are persisted to `bot_usage` inside those route handlers. Socket.io handles realtime push to the client.

---

## Version-specific notes

Pinned: `pg ^8.21.0` (package.json).

| Version | What changed | Impact on our code |
|---|---|---|
| **8.21.0** | `scramMaxIterations` config option; `client.getTransactionStatus()`; Node.js 26 support; improved SASL SCRAM error responses | None required; safe upgrade |
| **8.20.0** | `onConnect` pool callback for async new-client initialization | We could use this to `SET statement_timeout` globally; currently not wired |
| **8.19.0** | Internal query queue deprecated; connection params passed to password callback | Negligible: we don't use the internal queue directly |
| **8.18.0** | `pool.connect()` now returns the client (previously void) | No impact — we never use `pool.connect()` |
| **8.16.0** | `min` pool size now respected (creates connections up-front) | We don't set `min`; default is 0 (lazy) |
| **8.15.0** | Native ESM `import` support | We use ESM throughout; this is why `import pg from 'pg'` works |
| **8.13.0** | Per-query `query_timeout` on QueryConfig | We could use this for safety on long `SELECT` in `list()` |

**No breaking changes** from 8.13.0 → 8.21.0. The `^8.21.0` range allows minor/patch upgrades automatically.

---

## Rate limits / quotas / scaling

**Railway Postgres `max_connections`**: Railway's default PostgreSQL template ships with PostgreSQL's default `max_connections = 100`. Our pool is capped at `max: 25` (`src/db/index.js:279`). With a single Railway web service this is well within the limit. With multiple replicas (Railway horizontal scaling), each replica opens up to 25 connections: 4 replicas × 25 = 100 connections, saturating the Postgres server. At that point, either reduce `max`, scale up the database, or put PgBouncer in front.

**`idleTimeoutMillis: 30000`**: Idle connections are released after 30 s. The pg default is 10 s; we bumped it to 30 s to reduce reconnect churn during quiet periods in an always-on server. This means under low load, up to 25 connections could sit idle for up to 30 s before being released back to Postgres.

**`connectionTimeoutMillis`**: Not set — defaults to `0` (wait forever for a connection from the pool). In practice this means a code path that holds a pool connection indefinitely will never surface an error; it will just queue other requests silently. See Risks below.

**No Railway-side query rate limit** is documented; the practical ceiling is Postgres's `max_connections` × query parallelism.

---

## Gotchas & failure modes

**1. `pool.query()` cannot span a transaction.** We currently have no transaction usage, but the Stripe webhook `checkout.session.completed` handler (`src/routes/webhook.js:253-265`) issues two logically related writes (`UPDATE organizations` + implicit Stripe state) without a transaction. If the process crashes between them, the org row could be updated without the Stripe ID written, or vice versa. Any multi-step write should wrap the two statements in `BEGIN`/`COMMIT` with a dedicated client.

**2. `ssl: { rejectUnauthorized: false }` in production.** Required for Railway's public TCP proxy (`*.proxy.rlwy.net`) but disables certificate chain verification, leaving connections theoretically MITM-able on the proxy leg. The internal private-network URL (`DATABASE_PRIVATE_URL` / no `.proxy.rlwy.net` hostname) does not need SSL at all. Prefer the private URL in production and reserve the proxy URL for local dev.

**3. No `connectionTimeoutMillis`.** If the pool is exhausted under high load, `pool.query()` callers queue silently forever. Set `connectionTimeoutMillis: 5000` to surface this as a real error instead of a silent hang.

**4. Schema applied on every startup in a single connection.** `SCHEMA_SQL` and `MIGRATION_SQL` run serially in the same `pool.query()` call on startup. Because `ALTER TABLE … ADD COLUMN IF NOT EXISTS` takes an `AccessExclusiveLock`, concurrent deploys of two instances could deadlock briefly. This is safe for single-instance Railway deployments but could cause a 30–60 s startup delay if a migration runs while another instance is under traffic.

**5. `ALTER TABLE … ADD COLUMN … NOT NULL DEFAULT` adds a rewrite lock.** In Postgres ≥ 11 adding a column with a `DEFAULT` that is a constant is instant (stored as a catalog entry). Our schema uses `NOT NULL DEFAULT 'ryteproductions'` and `NOT NULL DEFAULT FALSE` — these are constant defaults, so the lock is brief. This breaks down if we ever add a column with a volatile default or a function call.

**6. Roster entry inserts are serial, not batched.** `RosterManager._insertEntries()` loops and calls `this.db.query()` once per entry (`src/services/RosterManager.js:135-154`). For a 20-entry roster that's 20 round-trips. Not a problem at current scale but would be ~200 ms at P95 on a loaded Railway instance.

**7. Process restart drops in-memory bot tracking.** `RecallBotManager.botsByMeeting` / `meetingsByBot` are in-memory maps. After a Railway redeploy, bots still active in Zoom will continue sending webhooks but the server has no record of which org or meeting they belong to — `handleChatEvent()` logs "unknown bot — dropping message" for every event. The `bot_usage` table survives the restart but the live routing doesn't. Recovery requires the operator to manually re-connect each meeting.

**8. `SCHEMA_SQL` runs as a single multi-statement string.** `pool.query()` with a string containing multiple `;`-separated statements is supported by `node-postgres` (it forwards to libpq's `PQexec`), but it bypasses parameterization entirely and runs outside any caller-managed transaction. An error midway through the schema block leaves the schema in a partially-applied state with no rollback.

**9. No `statement_timeout` set.** A runaway query (e.g., a `SELECT` with a missing index on a large `messages` table) will hold a pool connection until PostgreSQL or the TCP connection times out. Add `statement_timeout` either via `onConnect` on the Pool (pg@8.20+) or as a `SET` in `initDatabase`.

---

## Risks / TODOs in our current code

| # | File:line | Issue |
|---|---|---|
| 1 | `src/db/index.js:279` | `max: 25` with no `connectionTimeoutMillis` — pool exhaustion is a silent hang, not an error. Add `connectionTimeoutMillis: 5000`. |
| 2 | `src/db/index.js:265-311` | No `statement_timeout` on the pool. A long-running query holds a slot forever. Set via `onConnect: async (client) => client.query("SET statement_timeout = '10s'")` (pg@8.20+). |
| 3 | `src/db/index.js:271-281` | `ssl: { rejectUnauthorized: false }` is required for the public Railway TCP proxy but silently disables cert verification. Switch to `DATABASE_PRIVATE_URL` (Railway's internal URL) in production; the proxy URL is only needed for local/external dev. |
| 4 | `src/routes/webhook.js:253-309` | Stripe `checkout.session.completed` does two writes without a transaction: `UPDATE organizations` followed by implicit state. Use `BEGIN`/`COMMIT` or accept the small risk of partial failure. |
| 5 | `src/services/MessageAggregator.js:144` | `COALESCE($10, 'ryteproductions')` uses `$10` (the `org_id`) for the `tenant_id` fallback — this silently writes `NULL` as `tenant_id` when `orgId` is `null` and `COALESCE` returns `NULL`. Should be `COALESCE($10, 'ryteproductions')` — this is actually correct because `COALESCE(NULL, 'ryteproductions')` = `'ryteproductions'`; but verify intent vs. `COALESCE($10::text, 'ryteproductions')` for explicitness. |
| 6 | `src/services/RosterManager.js:135-154` | `_insertEntries()` issues one `INSERT` per entry in a loop — no transaction wrapping. If the loop fails mid-way, the roster has partial entries. Wrap in `BEGIN`/`COMMIT` or use a multi-row VALUES INSERT. |
| 7 | `src/db/index.js:291-295` | `SCHEMA_SQL` is a single multi-statement string with no transaction. A mid-block failure leaves a partially-applied schema. Wrap in explicit `BEGIN`/`COMMIT` or split into individual `pool.query()` calls. |
| 8 | `src/services/SessionManager.js:111-128` | `list()` query uses `COUNT(m.id)` with a `LEFT JOIN messages` — no `LIMIT` on the join side. For a session with 100k messages this is a full aggregation scan; add an index or a sub-select with limit. The outer `LIMIT $2` limits sessions returned but not the rows joined. |
| 9 | `src/db/index.js:118-121` | `tenant_id` columns on `sessions` and `messages` are now redundant (superseded by `org_id`). Document a Phase 7 ticket to `DROP COLUMN tenant_id` once backfill is confirmed complete and no queries reference it. |
| 10 | `src/recall/RecallBotManager.js:148-155` | `botsByMeeting` and `meetingsByBot` are in-memory only. A Railway redeploy clears them while bots remain active in Zoom — orphaned webhooks are dropped. Consider persisting active-bot state to a `active_bots` table or re-hydrating from `bot_usage WHERE left_at IS NULL` on startup. |
| 11 | `src/db/index.js:247-256` | `MIGRATION_SQL` uses five separate `UPDATE` statements — one per table — with no transaction. If the process crashes mid-migration, some tables have `org_id` set and others don't. Wrap in a transaction. |

---

## Key links

- [node-postgres home](https://node-postgres.com/)
- [Pool API reference](https://node-postgres.com/apis/pool)
- [Client API reference](https://node-postgres.com/apis/client)
- [Queries (parameterized, result shape)](https://node-postgres.com/features/queries)
- [SSL/TLS configuration](https://node-postgres.com/features/ssl)
- [Transactions](https://node-postgres.com/features/transactions)
- [Pool sizing guide](https://node-postgres.com/guides/pool-sizing)
- [pg changelog (GitHub)](https://github.com/brianc/node-postgres/blob/master/CHANGELOG.md)
- [pg npm page](https://www.npmjs.com/package/pg)
- [Railway PostgreSQL docs](https://docs.railway.com/databases/postgresql)
- [PostgreSQL 17 release notes](https://www.postgresql.org/docs/release/17.0/)
- [PostgreSQL partial indexes](https://www.postgresql.org/docs/current/indexes-partial.html)
- [PostgreSQL idempotent deployment wiki](https://wiki.postgresql.org/wiki/Idempotent_Deployment)
