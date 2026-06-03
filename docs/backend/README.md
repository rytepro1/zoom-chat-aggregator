# Chat Aggregator — Backend Reference Library

> Master index and integration map for RYTE Productions' **Chat Aggregator** SaaS backend. This is the navigational entry point: each section points at a per-system doc that carries the detail. Read this first, then drill into the system you care about.

**What the product does:** RYTE dispatches a participant-visible bot (via Recall.ai) into a live Zoom webinar/meeting. The bot captures chat in real time and streams it to an operator console where producers moderate, save, feature, and broadcast messages — plus a borderless presenter pop-out for on-stage talent. The whole stack runs as a single Node process on Railway, fronted by a thin macOS WKWebView launcher.

---

## 1. System inventory

| System | Pinned version | Role | Doc |
|---|---|---|---|
| **Recall.ai** | API v1, region us-east-1 (raw `fetch`, no SDK) | Meeting-bot infra: joins Zoom, captures chat, sends outbound chat | [./recall.md](./recall.md) |
| **Zoom** | REST API v2, S2S OAuth, Event Webhooks, `@zoom/rtms` (mocked) | Upstream chat source; webhook verification + URL-validation today, panelist API planned | [./zoom.md](./zoom.md) |
| **Railway** | Nixpacks builder, single service + managed Postgres | PaaS host: builds Vite client, runs the Node process, injects env + `DATABASE_URL` | [./railway.md](./railway.md) |
| **PostgreSQL / pg** | `pg ^8.21` | Durable store for sessions, messages, billing, rosters, bot-usage | [./postgres.md](./postgres.md) |
| **Stripe** | SDK `stripe ^22.2`, API `2025-04-30.basil` | Subscription billing (Solo/Pro/Studio), checkout, portal, lifecycle webhooks | [./stripe.md](./stripe.md) |
| **Resend** | SDK `resend ^6.12.4` | Transactional auth email (verify, reset, invite) | [./resend.md](./resend.md) |
| **Socket.IO** | server + client `^4.7.5` | Real-time push to operator browsers; org-room fan-out | [./socketio.md](./socketio.md) |
| **Express** | `^4.21` | HTTP framework: REST routes, webhook receivers, static serving | [./express.md](./express.md) |
| **Auth stack** | `bcryptjs ^3.0.3`, `cookie ^0.7.2`, `cookie-parser ^1.4.7` (Lucia pattern, no lib) | Hand-rolled server-side sessions, bcrypt hashing, HTTP-only cookies | [./auth.md](./auth.md) |
| **React / React Router** | `react ^18.3`, `react-router-dom ^7.13` | SPA operator console + presenter display; 8 context providers | [./react-frontend.md](./react-frontend.md) |
| **Build tooling** | `vite ^7.3.1`, `tailwindcss ^3.4.4`, `postcss ^8.4.38`, `html-to-image ^1.11.13` | Client build pipeline + PNG quote-card export | [./build-tooling.md](./build-tooling.md) |
| **macOS launcher** | Swift, WKWebView, macOS 13+, ad-hoc signed | Native `.app` wrapping the Railway UI; presenter pop-out, PNG downloads | [./mac-launcher.md](./mac-launcher.md) |

**Single process, single port.** Express and Socket.IO share one `http.Server` (`src/server/index.js`). In production that same process also serves the compiled Vite client from `client/dist/`. Services are wired together via the Express `app.set()` / `req.app.get()` service-locator pattern.

---

## 2. End-to-end data flows

### a. Inbound chat (Zoom attendee → operator feed)

The core live path. Everything except the Zoom-side capture is our code.

```
Zoom webinar attendee types chat
  → Recall bot (joined via POST /api/v1/bot/) captures it
  → Recall POSTs participant_events.chat_message to our realtime_endpoint
  → POST /webhook/recall/chat                        src/routes/webhook.js:167
      → verifyRecallWebhook() (Svix HMAC)            src/recall/verifyRecallWebhook.js
      → recallBotManager.handleChatEvent(req.body)   fire-and-forget, always 200
  → handleChatEvent()                                src/recall/RecallBotManager.js:437
      → extract botId → lookup meetingId/orgId in botsByMeeting / meetingsByBot (IN-MEMORY)
      → OrgState → that org's MessageAggregator
      → ma.addMessage()                              src/services/MessageAggregator.js:141
          → INSERT INTO messages (best-effort; DB failure never drops the live emit)
          → _queueMessageEmit() → 100ms batch timer
  → io.to('org:<id>').emit('newMessageBatch', [...]) src/services/MessageAggregator.js:47
  → browser SocketContext.jsx newMessageBatch handler appends, slices to 500
  → React ChatFeed re-renders
```

Per-room targeting (`org:<id>:room:<meetingId>`) emits `roomMessageBatch` for filtered views. The 100ms batch window caps re-renders at ~10/sec regardless of chat volume.

### b. Outbound chat (operator reply / broadcast → Zoom)

```
Operator clicks reply / broadcast in console
  → POST /api/meetings/:meetingId/reply  OR  POST /api/broadcast   src/server/index.js:364 / 397
      → requireAuth gate
      → recallBotManager.sendChatToMeeting() / broadcastChat()
          → token-bucket rate limiter (20/min per bot)
          → POST /api/v1/bot/{botId}/send_chat_message/  { to: "everyone", message }
          → _auditSentMessage() → INSERT INTO sent_messages
  → Recall relays into the Zoom chat panel (requires host CMC enabled to be visible)
```

### c. Auth (signup/login → cookie → request + socket gating)

```
POST /api/auth/signup | /login                       src/routes/auth.js
  → bcrypt.hash(plain, 12) / bcrypt.compare()         src/auth/passwords.js
  → createSession(db, userId): 256-bit hex ID, raw PK in auth_sessions, 30-day sliding
  → res.cookie('zoomchat_session', id, { httpOnly, secure(prod), sameSite:'lax' })

Every REST request:
  cookieParser → attachUser(db) (soft, sets req.user/req.org)   src/server/index.js:79,91
  → app.use('/api', requireAuth) hard gate                       src/server/index.js:141
      (mounted AFTER billing + invitations so /api/invitations/accept stays public)

Every Socket.IO handshake:
  io.use() middleware parses zoomchat_session from handshake cookie  src/server/socketHandler.js:35
  → validateSession(db, id): JOIN auth_sessions + users + organizations
  → socket joins org:<orgId> room → structural cross-tenant isolation
```

The same `validateSession` JOIN backs both REST (`attachUser`) and the socket handshake. Org isolation is enforced at the Socket.IO room layer — all server emits are `io.to('org:<id>')`.

### d. Billing (Stripe checkout → org plan → enforcement)

```
POST /api/billing/checkout { tier }                  src/routes/billing.js:35
  → StripeService.getOrCreateCustomer() → checkout.sessions.create (subscription mode)
  → client redirects to Stripe-hosted Checkout
Customer pays
  → Stripe POSTs POST /webhook/stripe                 src/routes/webhook.js:213
      → stripe.webhooks.constructEvent(rawBody, sig, secret)  (rawBody from express.json verify hook)
      → checkout.session.completed:
          tier_key fast path (metadata) or resolveTierFromSubscription() fallback
          → UPDATE organizations SET plan_tier, concurrent_bot_limit, trial_minutes_remaining=NULL, stripe_subscription_id
      → customer.subscription.updated (active|trialing): re-sync tier
      → customer.subscription.deleted: plan_tier='canceled', bot limit 0
At bot dispatch:
  POST /api/meetings/connect → TrialEnforcer.checkCanDispatch()
      reads org.concurrentBotLimit FROM DB (never calls Stripe at request time)
```

All plan enforcement reads the DB copy written by webhooks — Stripe is never on the request hot path.

### e. Deploy (push → Railway build → serve → launcher refresh)

```
git push to connected GitHub branch
  → Railway triggers Nixpacks build (builder pinned in railway.json)
  → npm ci → postinstall → npm run build
       → cd client && npm install --include=dev && npm run build  → client/dist/
  → image starts via railway.json startCommand: npm start → node src/server/index.js
  → start(): initDatabase() (5 retries) → schema/migration SQL → setupSocketHandlers → httpServer.listen(PORT)
  → Express serves client/dist/ + SPA catch-all (NODE_ENV=production)
Operator on the macOS launcher hits Cmd-R
  → reloads kAppURL with .reloadIgnoringLocalAndRemoteCacheData → fresh HTML → newly-hashed JS bundle
```

Note: deploys are **not** zero-downtime today (no `healthcheckPath`, draining defaults to 0s) — WebSocket clients hard-disconnect and auto-reconnect. See risk #5.

---

## 3. Cross-cutting concerns

### Multi-tenancy (`org_id` vs `tenant_id`)
- **`org_id`** (FK → `organizations`) is the live tenant key. All runtime queries filter on it; `validateSession` returns `req.org` / `socket.data.org`; Socket.IO rooms are `org:<id>`.
- **`tenant_id`** is a legacy string column (default `'ryteproductions'`) still present on `sessions`, `messages`, `bot_usage`, `sent_messages`, `rosters`. It is written for backfill compatibility only. `MessageAggregator.js:144` still hardcodes `'ryteproductions'` on inserts — DB-row isolation is incomplete until `tenant_id` is dropped (Phase 7 ticket). Details: [./postgres.md](./postgres.md), [./socketio.md](./socketio.md).

### Secrets / env-var map
Authoritative shape in `.env.example`; values live in Railway Variables (never committed). Quick map (full detail in each doc):

| Var | System | Notes |
|---|---|---|
| `DATABASE_URL` | Postgres/Railway | Auto-injected by Postgres plugin |
| `PORT`, `NODE_ENV` | Railway | `PORT` auto; `NODE_ENV=production` **must be set manually** |
| `RECALL_API_KEY`, `RECALL_API_BASE`, `PUBLIC_WEBHOOK_URL`, `RECALL_WEBHOOK_SECRET` | Recall | webhook secret optional-but-critical; unset = open endpoint |
| `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`, `ZOOM_WEBHOOK_SECRET_TOKEN` | Zoom | `ZOOM_ACCOUNT_ID` **missing** from `.env.example`, needed for S2S OAuth |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID_{SOLO,PRO,STUDIO}` | Stripe | price IDs are mode-specific (test vs live) |
| `RESEND_API_KEY`, `EMAIL_FROM` | Resend | key absent = silent console-log fallback |
| `APP_URL` | Resend/Stripe | email deep-links + checkout success/cancel URLs |
| `SESSION_SECRET` | Auth | **documented but never read** — session IDs are bare random hex |

### Webhook signature verification (four inbound paths, three schemes)
All mounted under `/webhook/*` before `requireAuth`. All rely on `req.rawBody`, captured by the `express.json({ verify })` hook in `src/server/index.js:80` — load-bearing for byte-exact HMAC.

| Path | Scheme | Verifier |
|---|---|---|
| `POST /webhook/zoom` | Zoom HMAC-SHA256 over `v0:{ts}:{body}`, 5-min replay window | inline at `webhook.js:15-42` (**broken — see risk #1**) |
| `POST /webhook/recall/chat` | Svix `webhook-*` headers, HMAC over `{id}.{ts}.{body}`, 300s | `src/recall/verifyRecallWebhook.js` |
| `POST /webhook/recall/status` | same Svix | same |
| `POST /webhook/stripe` | `stripe.webhooks.constructEvent`, 5-min tolerance | Stripe SDK |

Recall's verifier only handles the post-Dec-2025 `webhook-*` header form (no legacy `svix-*` fallback). Recall/Stripe routes return 200 even on internal errors (avoid retries); Stripe returns 400 only on signature failure.

### Single-instance / scaling assumptions
The entire backend assumes **one Railway replica, one process**. Critical in-memory state that does NOT survive restart and is invisible to a second instance:
- `RecallBotManager.botsByMeeting` / `meetingsByBot` — bot→org routing (restart drops inbound chat for active bots)
- Socket.IO default in-memory adapter (no Redis) — multi-replica silently breaks `io.to(room)` fan-out
- `moderationStateByOrg`, `TrialEnforcer.exhaustedOrgs`, `OrgState.byOrg`, `MessageAggregator` ring buffers
Before scaling to 2+ replicas: add `@socket.io/redis-adapter`, persist/rehydrate bot routing from `bot_usage`, and watch the Postgres pool (25 conns × replicas vs `max_connections=100`).

---

## 4. Top consolidated risks / TODOs (ranked)

Merged and ranked across all twelve systems. Each links to the owning doc for the fix.

1. **Zoom webhook verification is functionally broken — `crypto.timingSafeEquals` (trailing "s") does not exist in Node.** Both `src/middleware/webhookAuth.js:44` and `src/routes/webhook.js:38` call a nonexistent method. In the middleware the `try/catch` swallows the `TypeError` and returns 401 (all validations silently fail); in `webhook.js:38` there is no catch and the handler crashes. The deployed `/webhook/zoom` endpoint is broken for any non-challenge event. Fix: `crypto.timingSafeEqual`. [zoom.md](./zoom.md)

2. **`RECALL_WEBHOOK_SECRET` unset = unauthenticated webhook injection.** When absent, `/webhook/recall/chat` and `/webhook/recall/status` accept any POST with only a logged warning — anyone who knows the URL can inject chat or spoof bot termination. Must be set in Railway before production. [recall.md](./recall.md), [railway.md](./railway.md), [express.md](./express.md)

3. **Recall bot routing is in-memory only — a redeploy mid-show silently drops all inbound chat.** `botsByMeeting`/`meetingsByBot` are lost on restart; active bots keep capturing but `handleChatEvent` logs "unknown bot — dropping message". `bot_usage` already has `recall_bot_id` and could seed a recovery map at startup. [recall.md](./recall.md), [postgres.md](./postgres.md)

4. **OBF not implemented — external-host Zoom bots fail as of Feb 23, 2026.** The bot-create body never sets `zoom.obf_token_url` (`RecallBotManager.js:239`). Every RYTE meeting hosted by an external client account will `bot.fatal` with `zoom_obf_user_not_in_meeting`. This is a live production blocker requiring a Zoom OAuth + OBF-callback build. [recall.md](./recall.md)

5. **Deploys are not zero-downtime; WebSocket clients hard-disconnect.** `railway.json` has no `healthcheckPath`, `overlapSeconds`, or draining (defaults to 0s). New traffic hits unready instances during the DB-connect race, and every deploy drops all sockets. Add `healthcheckPath: /health`, `overlapSeconds`, and `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`. [railway.md](./railway.md)

6. **No `helmet`, no global Express error handler, `X-Powered-By` exposed.** Security headers (CSP/HSTS/X-Frame-Options) are absent; an uncaught error leaks an HTML stack trace to JSON clients. Add `helmet()`, a 4-arg error handler, and `app.disable('x-powered-by')`. [express.md](./express.md)

7. **No rate limiting on auth endpoints.** `/api/auth/login` and `/api/auth/password-reset/request` allow unlimited brute-force / reset-email spam. bcrypt cost 12 slows but does not gate. Add `express-rate-limit`. [auth.md](./auth.md), [express.md](./express.md)

8. **Stripe webhook DB failures are silently swallowed (returns 200, no retry).** A Postgres write failure in the handler means the org plan never updates and Stripe won't retry — no dead-letter, no alert. Also: `past_due`/`unpaid` statuses are ignored, so failed-payment customers keep full bot access (billing leak). [stripe.md](./stripe.md)

9. **Resend API-level errors are invisible.** `resend.emails.send()` returns `{ data, error }` but the wrapper only catches network throws — a 403 (unverified domain), 401 (bad key), or 429 (quota) sends zero emails silently. Compounded by: missing `RESEND_API_KEY` activates a silent console-log fallback. Inspect `error` after every send. [resend.md](./resend.md)

10. **Session, email, and invitation tokens are stored unhashed.** Raw 256-bit hex is the PK/column in `auth_sessions`, `email_tokens`, and `invitations.token`. A DB dump yields directly replayable session cookies and account-takeover-capable reset tokens (24h TTL). Lucia's guide recommends SHA-256-at-rest. [auth.md](./auth.md)

11. **Scaling past one replica silently breaks real-time + tenancy state.** No Socket.IO Redis adapter; `moderationStateByOrg`, bot routing, and trial state are all in-process. `io.to(room)` won't reach clients on another instance — no error, just missing events. Gate horizontal scaling on a Redis adapter. [socketio.md](./socketio.md), [railway.md](./railway.md)

12. **Postgres pool has no `connectionTimeoutMillis` and no `statement_timeout`.** Pool exhaustion (`max:25`) queues callers forever instead of erroring; a runaway query holds a slot indefinitely. Multi-statement schema/migration SQL also runs without transactions (partial-apply on crash). Add `connectionTimeoutMillis:5000` and a `statement_timeout` via the `onConnect` callback. [postgres.md](./postgres.md)

13. **Two disconnected `RTMSManager` instances; `messageAggregator` never registered via `app.set()`.** `index.js:48` and `webhook.js:91` create separate instances; `req.app.get('messageAggregator')` returns `undefined` on the legacy Zoom RTMS path. Dead/duplicated `validateZoomWebhook` middleware (also carries the timingSafeEquals bug) and stale RTMS signature/payload formats compound this. RTMS is mock-only today (`useMockMode=true`) so the blast radius is limited, but the path is a trap. [zoom.md](./zoom.md), [express.md](./express.md)

14. **Frontend dead code + missing `credentials:'include'`.** `client/src/hooks/useSocket.js` lacks `withCredentials:true` (breaks prod auth if ever imported — delete it); several context fetches (`MeetingsContext`, `SessionContext`, `SavedContext`) omit `credentials:'include'`, masked only by the same-origin Railway deploy. [react-frontend.md](./react-frontend.md), [socketio.md](./socketio.md)

15. **macOS launcher uses a private KVC API that can crash on any WebKit update.** `webView.setValue(false, forKey:"drawsBackground")` throws `NSUnknownKeyException` if removed; replace with `underPageBackgroundColor = .clear`. Also: no `webViewWebContentProcessDidTerminate` (blank-screen-forever on a content-process crash), and `build.sh` `codesign ... || true` ships unsigned binaries on signing failure. [mac-launcher.md](./mac-launcher.md)

16. **`SESSION_SECRET` is documented as consumed but never read anywhere.** Engineers following `.env.example` believe cookies are HMAC-signed; they are not (bare random hex). Either wire it to `cookieParser(secret)` or remove it from `.env.example`. [auth.md](./auth.md), [railway.md](./railway.md)

---

*Each linked doc carries: how-we-use-it, core concepts, the exact API/SDK surface we touch, auth/secrets, webhooks/events, version-specific notes, rate limits, gotchas, and a full per-system risk register with file:line references.*
