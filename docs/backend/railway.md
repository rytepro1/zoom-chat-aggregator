# Railway (PaaS)

> Hosts the Chat Aggregator's Express/Socket.io backend and managed Postgres database; current plan is Hobby or Pro (verify in dashboard).

---

## How we use it

### Service topology

One Railway project, one environment (`production`). A single Railway **service** runs the unified Node.js server that serves both the REST API and the static Vite client build. The managed **Postgres plugin** is a second service in the same project, connected via private networking.

| Layer | Railway surface |
|---|---|
| Node.js backend | Service — `npm start` (node src/server/index.js) |
| Postgres database | Managed Postgres plugin in the same project |
| Build | Nixpacks (auto-detected Node.js + npm) |
| Domain | Railway-provisioned `.railway.app` + any custom domain |

### Build pipeline (end to end)

1. Push to the connected GitHub branch → Railway triggers a build.
2. Nixpacks detects `package.json` + `"engines": {"node": ">=18.0.0"}` (`package.json:27`), installs dependencies with `npm ci`.
3. `postinstall` script (`package.json:14`) runs `npm run build` → `cd client && npm install --include=dev && npm run build` — this compiles the Vite/React frontend into `client/dist/`.
4. The built image starts via `railway.json`'s `startCommand: "npm start"` which runs `node src/server/index.js`.
5. Railway injects `PORT` and all configured env vars before the process starts.

### Runtime behavior

- Server binds on `process.env.PORT || 3001` (`src/server/index.js:592`). Railway always sets `PORT`; the `3001` fallback is for local dev only.
- In production (`NODE_ENV=production`), the server serves the compiled Vite client from `client/dist/` as static files and handles `*` with `index.html` for client-side routing (`src/server/index.js:585-590`).
- Socket.io runs over the same HTTP server using the `http` module (`src/server/index.js:30-40`). Railway supports WebSockets over HTTP/1.1 on the same domain — no separate port or TCP proxy needed.
- CORS: in production, `origin: true` (reflects the request origin) — this works because Railway's TLS termination means all inbound requests already arrive via HTTPS from our domain. Tighten this to an explicit allowlist once the domain is stable (`src/server/index.js:34`, `src/server/index.js:74`).

### Database connection

`src/db/index.js:265-312` calls `initDatabase({ databaseUrl: process.env.DATABASE_URL })` at startup (`src/server/index.js:595`).

Key decisions in the connection pool:
```
ssl: /\.proxy\.rlwy\.net/.test(databaseUrl) ? { rejectUnauthorized: false } : false
max: 25
idleTimeoutMillis: 30000
```
(`src/db/index.js:275-280`)

- **Internal hostname** (`*.railway.internal`) → `ssl: false` — WireGuard already encrypts the tunnel, TLS is not needed and not offered on the private port.
- **Public proxy hostname** (`*.proxy.rlwy.net`) → `ssl: { rejectUnauthorized: false }` — Railway's public TCP proxy uses a self-signed cert. This is the only path that works from a developer's local machine via `railway connect` or a direct connection string.
- Pool size bumped to 25 to handle high-volume chat rooms (comment in source: "50+ msgs/sec per room, multiple rooms simultaneously").
- Startup retries: 5 attempts with 2 s delay between each (`src/db/index.js:289-306`). This handles the race condition where Railway starts the web service before Postgres is fully accepting connections.
- Schema is applied idempotently on every startup via `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE … ADD COLUMN IF NOT EXISTS` (`src/db/index.js:18-241`). No migrations framework needed for this schema size.

### Webhook endpoints (must be reachable from the internet)

All three inbound webhook paths must be publicly accessible (no auth in Railway sense — they use their own HMAC verification):

| Path | Caller | Auth method |
|---|---|---|
| `POST /webhook/zoom` | Zoom Marketplace | `x-zm-signature` HMAC-SHA256 (`src/routes/webhook.js:15-42`) |
| `POST /webhook/recall/chat` | Recall.ai (Svix) | `RECALL_WEBHOOK_SECRET` Svix-style HMAC (`src/routes/webhook.js:167-188`) |
| `POST /webhook/recall/status` | Recall.ai (Svix) | same as above (`src/routes/webhook.js:341-364`) |
| `POST /webhook/stripe` | Stripe | `stripe-signature` (`src/routes/webhook.js:213-321`) |

`PUBLIC_WEBHOOK_URL` must be set to the Railway-provided domain (or custom domain) so `RecallBotManager` can register `{PUBLIC_WEBHOOK_URL}/webhook/recall/chat` with Recall when dispatching bots (`src/server/index.js:53`, `.env.example:22`).

---

## Core concepts

### Projects and environments

- **Project**: the top-level container. One project per app.
- **Environment**: an isolated deployment context within a project. Variables, services, and networking are scoped per environment. Default is `production`.
- **Service**: a deployable unit inside an environment (our Node app is one service, Postgres is another).
- PR environments: Railway can spin up ephemeral environments per GitHub PR, cloning all services and provisioning fresh domains. We do not currently configure this.

### Build system: Nixpacks (what we actually use)

Our `railway.json` specifies `"builder": "NIXPACKS"` (`railway.json:4`). Despite Railway's documentation shifting focus toward Railpack, the platform still honors `NIXPACKS` — the field value is the toggle.

Nixpacks for Node.js:
- Detects `package.json` → uses the `node` provider.
- Respects `engines.node` to pin the runtime version.
- Runs `npm install` (or `npm ci` if `package-lock.json` is present).
- Runs `postinstall` scripts automatically — our client build hook fires here.
- Detects `Procfile` `web:` process type as the start command, but `railway.json`'s `startCommand` takes precedence.

Railpack (the newer default) auto-detects Node in the same way but is a different implementation. If we ever remove `"builder": "NIXPACKS"` from `railway.json`, Railway defaults to Railpack. Test before removing — postinstall behavior and layer caching differ.

### Procfile vs railway.json startCommand

Our `Procfile` (`Procfile:1`) contains `web: npm start`. Our `railway.json` also sets `startCommand: "npm start"` (`railway.json:8`). Railway's docs note that Procfile "is not recommended" compared to specifying start commands directly; `railway.json` wins when both are present. The Procfile is a safe redundant fallback but can be removed.

### Private networking

Services in the same Railway environment communicate over an encrypted WireGuard mesh via `<service-name>.railway.internal`. No public exposure required. DNS resolves to internal IPv4 + IPv6 addresses in environments created after October 16, 2025; older environments are IPv6-only.

**Critical**: private networking is only available at **runtime**, not during the build phase. Database migrations (our schema SQL) run in the `start` command, not a `buildCommand`, which is correct — `initDatabase()` is called from `start()` (`src/server/index.js:594-626`).

### Public networking

Railway provides a `*.railway.app` subdomain automatically. HTTPS/TLS is automatic (Let's Encrypt RSA-2048, 90-day cert, renews at 60 days). Plain HTTP GET redirects to HTTPS (301); plain HTTP POST is converted to GET — so any webhook sender must use HTTPS.

Specs:
- Max concurrent connections: 10,000 per domain
- Max RPS: ~11,000 per domain
- Max HTTP request duration: 15 minutes
- Proxy keep-alive timeout: 60 seconds
- Max combined headers: 32 KB
- WebSockets: supported over HTTP/1.1 (same limits as HTTP)

### PORT injection

Railway injects `PORT` into every service's environment. An app must bind on `process.env.PORT` — binding on a hardcoded port means Railway's proxy can never reach the process. Our server does this correctly (`src/server/index.js:592-611`).

### Restart policy

`railway.json:9-10`:
```json
"restartPolicyType": "ON_FAILURE",
"restartPolicyMaxRetries": 10
```
The process is restarted up to 10 times if it exits with a non-zero code. After 10 failures Railway stops retrying. `ALWAYS` would restart even on clean exits (bad for one-off commands). `NEVER` is for fire-and-forget job services.

### Healthchecks

We expose `/health` returning `{ status: 'ok', timestamp: '...' }` (`src/server/index.js:99-101`), but we do **not** configure `healthcheckPath` in `railway.json`. Without a healthcheck, Railway marks a deployment active as soon as the process starts and binds a port — there is no readiness gate. With a healthcheck configured, Railway polls the path until it receives HTTP 200, then cuts traffic over (zero-downtime). The default healthcheck timeout is 300 s.

### Zero-downtime deploys

Railway uses singleton deploys. On a new push the new container starts, the old one receives SIGTERM, then SIGKILL after a configurable drain period (default 0 s — immediately). Socket.io clients will be disconnected during deploys. Set `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` or `railway.json`'s `drainingSeconds` to give WebSocket clients time to reconnect. With a healthcheck configured, the overlap (`overlapSeconds`) keeps the old instance running until the new one is healthy.

---

## API / SDK surface we touch

We do not use a Railway SDK in our application code. Railway is purely a platform concern — the following are all in Railway's dashboard / CLI / railway.json config.

| Surface | We use? | Notes |
|---|---|---|
| `railway.json` build config | Yes | Sets Nixpacks builder + start command + restart policy |
| `Procfile` | Yes (redundant) | `web: npm start` — superseded by `railway.json` |
| `DATABASE_URL` env var | Yes | Injected by managed Postgres plugin; consumed by `src/db/index.js:265` |
| `PORT` env var | Yes | Injected by Railway; consumed by `src/server/index.js:592` |
| `NODE_ENV` env var | Yes | Must be set to `production` manually in Railway dashboard |
| `RAILWAY_PUBLIC_DOMAIN` | Not currently | Available system var — useful for constructing `PUBLIC_WEBHOOK_URL` dynamically |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | Not set | Should be set; see Gotchas |
| healthcheck endpoint | Exists but not wired | `/health` exists; `healthcheckPath` not in `railway.json` |
| GitHub autodeploy | Yes | Push to connected branch → auto-deploy |
| `railway logs` CLI | Operations use | Stream deploy logs |
| `railway run` CLI | Dev use | Load Railway env vars for local testing |
| `railway connect` CLI | Dev use | Opens a `psql` shell to the managed Postgres via TCP proxy |
| `railway variables` CLI | Dev use | Read/set env vars from CLI |
| `railway ssh` CLI | Rarely | SSH into the running container for debugging |
| `railway up` CLI | Manual deploys | Deploy current directory without a git push |
| PR environments | Not configured | Could be enabled for staging |
| Multi-region replicas | Not configured | Available on Pro+ |
| Serverless/sleep mode | Not configured | Would break WebSockets; do not enable |

---

## Auth & secrets

### Env vars required in Railway dashboard

All secrets live in Railway's **Variables** tab for the service (not committed to git; `.env.example` documents the shape):

| Variable | Purpose | Required in prod? |
|---|---|---|
| `DATABASE_URL` | Auto-injected by Railway Postgres plugin | Yes (auto) |
| `NODE_ENV` | Must be `production` for cookie security, static serving, CORS | Yes (manual) |
| `PORT` | Auto-injected by Railway | Yes (auto) |
| `RECALL_API_KEY` | Recall.ai bot dispatch | Yes |
| `RECALL_API_BASE` | `https://us-east-1.recall.ai/api/v1` | Yes |
| `PUBLIC_WEBHOOK_URL` | Base URL for Recall webhook registration — Railway domain | Yes |
| `RECALL_WEBHOOK_SECRET` | Svix signature verification for Recall webhooks | Yes (critical) |
| `ZOOM_WEBHOOK_SECRET_TOKEN` | Zoom webhook HMAC verification | Yes if using Zoom events |
| `ZOOM_CLIENT_ID` / `ZOOM_CLIENT_SECRET` | Zoom App credentials for RTMS legacy path | Legacy |
| `SESSION_SECRET` | Signs session cookies (not currently used — cookie is bare session id) | Yes |
| `STRIPE_SECRET_KEY` | Stripe API | Yes |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook HMAC | Yes |
| `STRIPE_PRICE_ID_SOLO/PRO/STUDIO` | Links plan tiers to Stripe prices | Yes |
| `RESEND_API_KEY` | Transactional email | Yes |
| `EMAIL_FROM` | Sender address | Yes |
| `APP_URL` | Used in email links — should be the Railway domain or custom domain | Yes |

### Reference variables (cross-service)

Railway supports `${{Postgres.DATABASE_URL}}` template syntax to pull a variable from one service into another. The Postgres plugin typically auto-connects `DATABASE_URL` to the web service without manual reference variables, but if it stops injecting, use the reference variable form in the web service's Variables tab.

### How credentials flow

1. Railway injects vars as process environment at container start.
2. `dotenv.config()` (`src/server/index.js:24`) loads `.env` if present — in production there is no `.env` file; Railway vars take precedence via the real environment anyway. `dotenv` is a no-op when the file is absent.
3. All service singletons read vars at construction time (`src/server/index.js:49-62`).

---

## Webhooks / events

Railway itself does not send webhooks to our app. Our app is the **receiver** of webhooks from Zoom, Recall.ai, and Stripe.

**Outbound Railway webhooks** (Railway → us): not configured. Railway can optionally send deployment lifecycle events to an external URL, but we don't use this.

For our inbound webhook signature verification, see the route-level implementations:
- Zoom HMAC: `src/routes/webhook.js:15-42`
- Recall Svix: `src/routes/webhook.js:167-188`, `src/routes/webhook.js:341-364`
- Stripe: `src/routes/webhook.js:213-227`

All three webhook routes set `rawBody` on every request via the `verify` callback on `express.json()` (`src/server/index.js:80-82`) — this is required by both Recall's Svix verifier and Stripe's `stripe.webhooks.constructEvent()`.

---

## Version-specific notes

### Nixpacks vs Railpack migration

Railway is actively migrating the default builder from Nixpacks to Railpack. Our `railway.json` explicitly pins `"builder": "NIXPACKS"` — this is intentional. Railpack is generally compatible but handles postinstall scripts and layer caching differently. Do not remove the `builder` field without testing in a staging environment first.

### Private networking IPv4/IPv6 split

Environments created before October 16, 2025 resolve `.railway.internal` hostnames to IPv6 only. Environments created after that date get dual-stack (IPv4 + IPv6). Node.js `pg` and `node-fetch` handle IPv6 transparently, but if you see connection failures to internal services on a legacy environment, check whether the client is forcing IPv4.

### Deployment draining default

As of current Railway documentation, `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` defaults to **0** — SIGKILL fires immediately after SIGTERM. This means WebSocket clients get hard-disconnected on every deploy. This was not always the default; older Railway deployments had a non-zero grace period.

### Free tier restrictions

Free-tier services are paused during peak hours (8 AM–8 PM local time per region). If we are on the free tier, production will be unavailable during business hours in the hosting region. Verify we are on Hobby or Pro.

---

## Rate limits / quotas / scaling

### Railway platform limits

| Limit | Value |
|---|---|
| Max concurrent connections per domain | 10,000 |
| Max HTTP RPS per domain | ~11,000 |
| Max HTTP request duration | 15 minutes |
| Proxy keep-alive timeout | 60 seconds |
| Max combined header size | 32 KB |
| Log ingestion rate | 500 lines/s per replica |
| Log retention (Hobby) | 7 days |
| Log retention (Pro) | 30 days |
| Ephemeral storage | 1 GB (free) / 100 GB (paid) |

### Postgres pool

Our pool is capped at `max: 25` connections (`src/db/index.js:279`). Railway's managed Postgres has a default connection limit depending on the plan — typically 100 on Hobby Postgres. With 25 from our app pool plus Railway's own internal connections, we have headroom. If we add replicas or run multiple dynos, the pool limit per-instance multiplies: 2 replicas × 25 = 50 connections simultaneously.

### Scaling

We run one replica. Railway supports horizontal scaling (multiple replicas) but does **not** support sticky sessions. Socket.io requires sticky sessions for multi-instance deployments, or an adapter (Redis pub/sub). Before adding a second replica, add `socket.io-redis` or `@socket.io/redis-adapter`. Otherwise, Socket.io events won't reach clients connected to a different instance.

### Serverless mode

Do **not** enable Railway's serverless/sleep mode. Our app maintains:
1. A persistent Postgres connection pool.
2. Persistent WebSocket connections (Socket.io).
3. Active Recall bot connections that send inbound webhooks.

Sleep mode would kill all of these on idle. Railway's docs confirm that an active database connection pool prevents sleep anyway, but the feature should remain explicitly disabled.

---

## Gotchas & failure modes

### 1. No healthcheck configured → no zero-downtime

We have `/health` (`src/server/index.js:99`) but it is not wired into `railway.json`'s `healthcheckPath`. Every deploy instantly cuts traffic to the new instance without waiting for it to be ready. During the startup race (DB connect retries, up to 10 s), real requests will land on an instance that hasn't finished initializing. Fix: add `"healthcheckPath": "/health"` to the `deploy` section in `railway.json`.

### 2. WebSocket clients hard-disconnected on every deploy

`RAILWAY_DEPLOYMENT_DRAINING_SECONDS` is not set → defaults to 0. Every deploy disconnects all Socket.io clients immediately. Socket.io-client reconnects automatically, but users see a brief flash of disconnection during deploys. Fix: set `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=15` (or `drainingSeconds` in `railway.json`) to give clients time to migrate.

### 3. SSL detection fragility for DATABASE_URL

`src/db/index.js:275` uses a hostname regex (`/\.proxy\.rlwy\.net/`) to decide whether to enable SSL. If Railway changes the public proxy hostname format, this silently fails (either connects without SSL when it needs it, or fails to connect at all). A more robust approach: always try `ssl: { rejectUnauthorized: false }` on `postgres://` URLs that aren't `localhost` or `railway.internal`.

### 4. RECALL_WEBHOOK_SECRET not set → open webhook endpoint

If `RECALL_WEBHOOK_SECRET` is missing, both `/webhook/recall/chat` and `/webhook/recall/status` accept any HTTP POST without verification and only log a warning (`src/routes/webhook.js:181`). Any entity that knows our URL can inject arbitrary chat messages and bot status events. This must be set in Railway's Variables before going live.

### 5. NODE_ENV must be set manually

Railway does not set `NODE_ENV=production` automatically. If it is missing or wrong:
- Cookies are set without `secure: true` → session cookies transmitted over HTTP (`src/auth/sessions.js:107`).
- CORS reflects all origins (`origin: true` is already set for production, but the condition check at `src/server/index.js:34` uses `NODE_ENV`).
- The static Vite client is NOT served — clients get 404 on every non-API route (`src/server/index.js:585`).

### 6. Private networking only at runtime — not build phase

If a `buildCommand` or `preDeployCommand` attempts to connect to `*.railway.internal`, it will fail with a DNS resolution error. Our schema migrations run correctly in the start command (runtime), not a build script.

### 7. CORS origin: true in production

`src/server/index.js:34` and `74` set `origin: true` when `NODE_ENV === 'production'`. This reflects the incoming `Origin` header, effectively allowing any origin. It's safe as long as cookies are the auth mechanism (CORS + credentials still requires `credentials: true` on the client, which our frontend uses), but it's broader than necessary. Consider locking to the Railway domain and any custom domain.

### 8. Socket.io multi-instance not supported without Redis adapter

If we ever scale to more than one replica on Railway, Socket.io events emitted by one instance (e.g., `io.to('org:x').emit(...)`) will not reach clients connected to a different instance. This is a silent failure — no error, just some clients don't receive events. See Scaling section.

### 9. Postgres connection pool × replicas

Each Railway replica opens its own pool of up to 25 connections. At 1 replica this is fine. At 2+ replicas we approach Railway Postgres's default connection limit. Monitor `pg_stat_activity` if scaling.

### 10. Build cache not guaranteed

Railway's build cache is best-effort and evicted under load. Client `npm install --include=dev` in the postinstall step can be slow on cache misses. This is not a correctness issue but can extend deploy times by 2-5 minutes.

### 11. `overlapSeconds` not set

Without `overlapSeconds` in `railway.json`, the old instance shuts down before the new one is confirmed healthy. Combined with the missing healthcheck, deploys have a window where neither instance is serving. Fix alongside `healthcheckPath`.

### 12. PORT fallback to 3001

`src/server/index.js:592` falls back to `3001` if `PORT` is unset. Railway always sets `PORT`, so this is unreachable in production. If Railway ever stops injecting `PORT` (extremely unlikely), the server would bind on 3001, which Railway's proxy does not know about, and all traffic would get 502.

---

## Risks / TODOs in our current code

| Risk | Location | Severity |
|---|---|---|
| No `healthcheckPath` configured | `railway.json` | High — deploys are not zero-downtime; traffic hits unready instances |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` not set | `railway.json` or Railway env | Medium — every deploy hard-disconnects all WebSocket clients |
| `RECALL_WEBHOOK_SECRET` not set = open endpoint | `src/routes/webhook.js:173`, `.env.example:28` | High — must be set before production use |
| SSL regex tied to Railway hostname format | `src/db/index.js:275` | Medium — fragile; breaks silently if Railway renames proxy host |
| `origin: true` in production CORS | `src/server/index.js:34`, `74` | Low-Medium — broader than needed; tighten to explicit domain list |
| `SESSION_SECRET` env var declared but not used | `.env.example:53`, `src/auth/sessions.js` | Low — session IDs are random hex; secret signing not implemented |
| Socket.io has no Redis adapter | `src/server/index.js:32-40` | High if scaling — multi-replica breaks silently |
| `overlapSeconds` not configured | `railway.json` | Medium — zero-downtime requires both `healthcheckPath` + `overlapSeconds` |
| `tenant_id` column still in schema alongside `org_id` | `src/db/index.js:118-120`, `250-255` | Low — technical debt; plan to drop after full backfill per MONETIZATION-PLAN.md |
| Webhook routes share `rawBody` via express.json verify callback | `src/server/index.js:80-82` | Low — works correctly; worth a comment that this is load-bearing for Stripe/Recall verification |

---

## Key links

- Railway docs home: https://docs.railway.com/
- Build configuration (Railpack/Nixpacks, railway.json schema): https://docs.railway.com/guides/build-configuration
- Config as code (full railway.json schema reference): https://docs.railway.com/reference/config-as-code
- Private networking: https://docs.railway.com/guides/private-networking
- Private networking how it works (WireGuard, IPv6, DNS): https://docs.railway.com/networking/private-networking/how-it-works
- Public networking specs & limits: https://docs.railway.com/networking/public-networking/specs-and-limits
- CLI guide: https://docs.railway.com/guides/cli
- Managed Postgres guide: https://docs.railway.com/guides/postgresql
- Variables reference: https://docs.railway.com/reference/variables
- Healthchecks: https://docs.railway.com/reference/healthchecks
- Deployments: https://docs.railway.com/reference/deployments
- Scaling: https://docs.railway.com/reference/scaling
- App sleeping / serverless: https://docs.railway.com/reference/app-sleeping
- Logs: https://docs.railway.com/guides/logs
- GitHub autodeploys: https://docs.railway.com/guides/github-autodeploys
- Environments: https://docs.railway.com/guides/environments
- Cost optimization: https://docs.railway.com/guides/optimize-usage
