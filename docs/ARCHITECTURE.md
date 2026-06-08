# Zoom Chat Aggregator — Master Architecture & Spec

> **Purpose of this doc:** the single document you'd want to read before
> working on this system from scratch, or before lifting its capabilities
> into another platform. It explains *what* the product is, *how* it's
> built, the *contracts* between its parts, and *how to reuse* it.
>
> For exhaustive per-system detail (exact API surfaces, version notes,
> risk registers with `file:line`), this doc links into the reference
> library at [`docs/backend/`](./backend/README.md). Start here; drill there.

---

## 0. TL;DR — the five things to understand first

1. **It's a real-time Zoom-chat capture + moderation console.** A
   participant-visible bot (via **Recall.ai**) joins a live Zoom
   webinar/meeting, captures chat, and streams it to an operator console
   and a borderless presenter display. Operators moderate, feature,
   save, and reply/broadcast back into Zoom.
2. **One Node process does everything.** Express + Socket.IO share one
   HTTP server (`src/server/index.js`); in production it also serves the
   built React client. State is wired via the Express service-locator
   (`app.set()` / `req.app.get()`).
3. **The chat pipeline is the heart.** Zoom → Recall bot → signed webhook
   → `RecallBotManager` → per-org `MessageAggregator` → batched Socket.IO
   emit → React. Everything else (auth, billing, AI, rosters) is a layer
   around that pipeline.
4. **Multi-tenant by `org`.** Every user belongs to one `organization`;
   all runtime state and Socket.IO rooms are keyed by `org_id`. Two
   customers on the same process are isolated.
5. **It assumes a single process/replica.** Critical routing state
   (`botsByMeeting`) is in-memory; a restart orphans live bots. This is
   the #1 operational gotcha (see §13).

---

## 1. Tech stack

| Layer | Tech | Notes |
|---|---|---|
| Runtime | Node ≥18, ES modules | global `fetch` used (no axios) |
| HTTP | Express `^4.21` | REST + webhook receivers + static client |
| Realtime | Socket.IO `^4.7.5` | shares the Express HTTP server |
| DB | PostgreSQL via `pg ^8.21` | Railway-managed; schema applied idempotently on boot |
| Meeting bots | **Recall.ai** API v1 (raw `fetch`) | joins Zoom, captures + sends chat |
| Zoom | REST v2, S2S OAuth, Event Webhooks, `@zoom/rtms` (mocked) | panelist registration; RTMS inactive |
| Billing | **Stripe** `^22.2`, API `2025-04-30.basil` | subscriptions, checkout, portal, webhooks |
| Email | **Resend** `^6.12` | transactional auth email |
| AI | `@anthropic-ai/sdk ^0.70`, `claude-haiku-4-5` | Smart Auto-Responder (opt-in, inert without key) |
| Frontend | React `^18.3`, react-router `^7.13`, Vite `^7.3`, Tailwind `^3.4` | SPA console + presenter pop-out |
| Secrets at rest | Node `crypto` AES-256-GCM (`secretBox.js`) | encrypts per-org Zoom client secrets |
| Host | **Railway** | deploy-on-push from `main`; Nixpacks build |
| Desktop | Swift **WKWebView** thin client | wraps the prod URL; macOS 13+ |

Repo: `~/Dev/chat-aggregator`. Production: `https://zoomchat.ryteproductions.com` (auto-deploys on push to `main`).

---

## 2. High-level architecture

```
                         ┌─────────────────────────── Zoom Cloud ───────────────────────────┐
                         │  Webinars / Meetings  (attendees, panelists, host)                │
                         └───────▲───────────────────────────────┬──────────────────────────┘
              outbound chat      │ bot joins + captures           │ inbound chat
              (send_chat_message)│                                │ (participant_events.chat_message)
                         ┌───────┴──────────── Recall.ai ─────────▼──────────┐
                         │  Bot infra: dispatch, capture, send, lifecycle     │
                         └───────▲───────────────────────────────┬───────────┘
                  REST (dispatch)│                  signed webhook│ (Svix HMAC)
   ┌─────────────────────────────┴───────────────────────────────▼─────────────────────────────┐
   │                       ONE NODE PROCESS  (src/server/index.js)                                │
   │  Express  ───────────────────────────────────────────────  Socket.IO (same http.Server)     │
   │   • /webhook/* (recall, zoom, stripe — signature-verified, pre-auth)                         │
   │   • /api/*    (requireAuth gate)                                                              │
   │   • serves client/dist/ (prod)                                                               │
   │                                                                                              │
   │  Singletons:  RecallBotManager · RosterManager · ZoomCredentialsService · StripeService      │
   │               TrialEnforcer · AIClient · RTMSManager(mock) · OrgState                        │
   │                                                                                              │
   │  OrgState  ── lazy, per org ──►  { SessionManager, MessageAggregator, AIResponder }          │
   └───────▲───────────────────────────────────────────────────────────────▲────────────────────┘
           │ pg                                                              │ Socket.IO (org rooms)
   ┌───────┴────────┐                                              ┌─────────┴───────────────────┐
   │  PostgreSQL    │                                              │  Browsers / macOS launcher  │
   │ (Railway)      │                                              │  • Operator console (SPA)   │
   └────────────────┘                                              │  • Presenter pop-out window │
   Stripe ⇄ /webhook/stripe   Resend ⇄ auth email                  └─────────────────────────────┘
```

**Key idea:** the server is stateless-per-request for HTTP but holds
**per-org live state** in `OrgState` (ring buffer of recent messages,
current session, AI responder). Recall bot→org routing also lives in
process memory (`RecallBotManager`).

---

## 3. Domain model / glossary

| Concept | Meaning |
|---|---|
| **Organization (org)** | The tenant + unit of billing. Every user belongs to exactly one. `plan_tier` ∈ `trial \| solo \| pro \| studio \| admin`. |
| **User** | Belongs to an org; `role` ∈ `operator \| admin`. Admin gates billing, team, integrations. |
| **Session** | "One live event run." Messages are scoped to the current session; rename / end-and-start-new / browse past. |
| **Room / Meeting** | A single Zoom meeting or webinar the bot is in. Keyed by Zoom `meeting_id`. Has a display name + accent color. |
| **Bot** | A Recall.ai bot instance in one meeting. Tracked in-memory by `meetingId ↔ botId ↔ orgId`. |
| **Roster** | A saved, pre-built list of meeting entries (id, passcode, room name/color, bot name, panelist opt-in) deployable in one click. |
| **Message** | A chat line. `type` ∈ `chat` (inbound) \| `reply` \| `broadcast` \| `ai_reply` (outbound, echo-deduped). |
| **Moderation state** | Per-org: `highlightedIds`, `queue[]`, `featuredMessage`. Synced across operator windows via Socket.IO. |
| **Featured message** | The one message pinned onto the presenter display. |
| **Presenter note** | Short production→talent message shown only on the presenter pop-out (not in Zoom, not in the moderator feed). |
| **FAQ (AI)** | Session-scoped Q→A the auto-responder matches against. `status` ∈ `pending \| active \| paused \| dismissed`. |

---

## 4. Data model (PostgreSQL)

Schema lives in `src/db/index.js` as one idempotent `CREATE TABLE IF NOT
EXISTS` / `ALTER … ADD COLUMN IF NOT EXISTS` block applied on every boot
(no migration framework). 15 tables:

**Capture & sessions**
- `sessions` — one row per event run (`name`, `started_at`, `ended_at`).
- `messages` — every chat line. FK `session_id`; carries `sender`,
  `room`, `room_color`, `meeting_id`, `content`, `type`, `saved`,
  `saved_at`, `note`, `org_id`. Indexed on session, saved, timestamp.
- `bot_usage` — per-bot dispatch record (`recall_bot_id`, `meeting_id`,
  `session_id`, `org_id`, `joined_at`, `left_at`, `duration_seconds`,
  `last_status`, `billed`). Basis for billing rollups; **the natural
  source for restart recovery of bot routing (see §13).**
- `sent_messages` — outbound audit (reply/broadcast/ai_reply).

**Rosters**
- `rosters` — named list (`name`, `scheduled_for`, `org_id`).
- `roster_entries` — `meeting_id`, `passcode`, `room_name`, `room_color`,
  `bot_name`, `meeting_url` (pre-registered join URL), `panelist_email`
  (explicit override), `register_panelist` (webinar opt-in), `display_order`.

**Tenancy & auth**
- `organizations` — tenant + plan. Columns include `plan_tier`,
  `concurrent_bot_limit`, `trial_minutes_remaining`,
  `stripe_customer_id/subscription_id`, `production_note_dismiss_seconds`,
  `ai_enabled`, `ai_match_threshold`, `ai_cooldown_seconds`,
  `ai_recurring_threshold`, `notetaker_filter_enabled`.
- `users` — `org_id`, `email`, `password_hash` (bcrypt 12), `role`,
  `email_verified`.
- `auth_sessions` — server-side sessions; PK is a 256-bit hex id stored
  in an HTTP-only cookie. 30-day sliding.
- `email_tokens` — single-use, time-limited verify/reset tokens.
- `invitations` — team invites (`token`, 7-day TTL).

**Integrations & features**
- `org_zoom_credentials` — per-org Zoom S2S creds. `account_id`,
  `client_id`, `client_secret_enc` (**AES-256-GCM at rest**, key
  `CRED_ENCRYPTION_KEY`), `panelist_email_base`.
- `presenter_notes` — `org_id`, `sender_display`, `body`, `sent_at`,
  `dismissed_at`.
- `ai_faqs` — session-scoped FAQ KB (`status`, `created_by_user_id`).
- `ai_faq_events` — append-only AI audit (`detected`, `auto_replied`,
  `suppressed`, `complaint`, `paused`, `resumed`).

**Multi-tenancy note.** `org_id` (FK → `organizations`) is the live
tenant key. A legacy `tenant_id` string column (default
`'ryteproductions'`) still exists on the capture tables for backfill
compatibility and is slated for removal once `org_id` backfill is
confirmed. Detail: [`docs/backend/postgres.md`](./backend/postgres.md).

---

## 5. The chat pipeline (core)

### 5a. Inbound (Zoom attendee → operator + presenter)

```
Zoom attendee types chat
 → Recall bot captures it
 → Recall POSTs participant_events.chat_message → POST /webhook/recall/chat   src/routes/webhook.js
     • verifyRecallWebhook() — Svix HMAC over {id}.{ts}.{body}                src/recall/verifyRecallWebhook.js
     • recallBotManager.handleChatEvent(body) — fire-and-forget, always 200
 → handleChatEvent()                                                          src/recall/RecallBotManager.js
     • extract botId + sender + text + participant.id
     • botId → meetingId → orgId via in-memory botsByMeeting / meetingsByBot
     • OrgState.get(orgId) → that org's MessageAggregator
 → MessageAggregator.addMessage()                                            src/services/MessageAggregator.js
     • DROP if notetaker (sender OR content match) and filter enabled        src/services/notetakerFilter.js
     • DROP if echo of a recent outbound (reply/broadcast/ai_reply)
     • push to 500-item ring buffer; best-effort INSERT INTO messages
     • feed to AIResponder.ingest() (if armed)
     • _queueMessageEmit() → 100ms batch
 → io.to('org:<id>').emit('newMessageBatch', [...])  (+ roomMessageBatch per meeting)
 → React SocketContext appends → ChatFeed + presenter DisplayView re-render
```

The message object shape (the realtime contract):
```js
{ id, sender, content, room, roomColor, meetingId, timestamp,
  type: 'chat'|'reply'|'broadcast'|'ai_reply', saved, note, participantId }
```

### 5b. Outbound (operator/AI reply or broadcast → Zoom)

```
Operator reply/broadcast  OR  AIResponder auto-reply
 → POST /api/meetings/:meetingId/reply | POST /api/broadcast   (requireAuth)
 → recallBotManager.sendChatToMeeting() / broadcastChat()
     • token-bucket rate limit: 20/min per bot
     • POST /api/v1/bot/{botId}/send_chat_message/ { to:'everyone', message }
     • _auditSentMessage() → INSERT INTO sent_messages
 → Recall relays into the Zoom chat panel
```

`to: 'everyone'` is used (works in meetings **and** webinars). Recall
can't target an individual attendee in a webinar — so all replies are
public/room-wide.

---

## 6. Server architecture

**Startup (`start()` in `src/server/index.js`):**
1. `initDatabase()` (≤5 retries) → apply schema + migration SQL.
2. Inject `db` into every singleton (`orgState.db`, `recallBotManager.db`, …).
3. `setupSocketHandlers(io, { db, orgState })`.
4. `trialEnforcer.start()` (30s tick).
5. `httpServer.listen(PORT)`.

**Singletons (constructed once, shared via `app.set`):**
- `RecallBotManager` — dispatch/connect/disconnect bots, inbound routing,
  outbound send, rate limiting, lifecycle webhook handling. **Holds the
  in-memory `botsByMeeting`/`meetingsByBot` routing maps.**
- `RosterManager` — roster CRUD (org-scoped, per-call orgId).
- `ZoomCredentialsService` — per-org Zoom S2S creds + `ZoomApiClient` factory.
- `StripeService` — checkout/portal/customer.
- `TrialEnforcer` — ticks every 30s; computes used bot-minutes; enforces caps.
- `AIClient` — shared Anthropic wrapper (inert without `ANTHROPIC_API_KEY`).
- `RTMSManager` — legacy Zoom RTMS path, **mock-only** today.
- `OrgState` — **lazy per-org** `{ SessionManager, MessageAggregator, AIResponder }`.

**Middleware order (matters):**
`cors` → `cookieParser` → `express.json({ verify: capture rawBody })` →
request logger → `attachUser` (soft auth) → public routes (`/health`,
`/api/status`, `/webhook/*`, `/api/auth/*`, `/api/billing`,
`/api/invitations`) → **`app.use('/api', requireAuth)`** (hard gate) →
authenticated `/api/*` → static client + SPA catch-all (prod).
`req.rawBody` is load-bearing for every webhook HMAC.

---

## 7. Realtime (Socket.IO)

- **Handshake auth:** `io.use()` parses the `zoomchat_session` cookie →
  `validateSession()` (same JOIN that backs REST `attachUser`) → socket
  joins `org:<orgId>`. Rejected if no valid session.
- **Rooms:** `org:<id>` (all org traffic) and `org:<id>:room:<meetingId>`
  (per-room filtered views). Every server emit is room-scoped → structural
  tenant isolation.
- **Event catalog (server → client), grouped:**
  - *Chat:* `newMessageBatch`, `roomMessageBatch`, `newMessage` (legacy),
    `initialState`, `history`, `messagesCleared`.
  - *Rooms/stats:* `roomAdded`, `roomRemoved`, `rooms`, `stats`,
    `meetingConnected`, `meetingDisconnected`.
  - *Moderation:* `moderationState` (hydrate), `moderationUpdate`.
  - *Sessions:* `sessionStarted`, `sessionRenamed`, `sessionEnded`.
  - *Presenter notes:* `presenterNotesInitial` (+ note add/dismiss events).
  - *Trial:* `trialUpdate`, `trialWarning`, `trialExhausted`.
  - *AI:* `ai:state`, `ai:settings`, `ai:faqPending`, `ai:faqUpdated`,
    `ai:faqDismissed`, `ai:autoReplied`, `ai:feedbackAlert`.
  - *Errors:* `serverError`.
- **Client → server:** `getModerationState`, `moderationUpdate`
  (moderation is operator-authored and broadcast org-wide).

Batching: inbound messages are collected for 100ms and shipped as one
`newMessageBatch` — caps client re-renders at ~10/sec regardless of chat
volume (designed for hundreds of msgs/sec).

---

## 8. REST API surface (grouped)

All under one server. `/api/*` requires a valid session cookie except
the explicitly public auth/billing/invitation-accept routes. Admin-only
routes check `role === 'admin'`.

- **Auth** (`src/routes/auth.js`): `POST /api/auth/signup|login|logout`,
  `GET /api/auth/me`, email-verify + password-reset request/confirm.
- **Meetings:** `GET /api/meetings`, `POST /api/meetings/connect`,
  `POST /api/meetings/:id/disconnect`, `POST /api/meetings/:meetingId/reply`,
  `POST /api/broadcast`.
- **Sessions:** `GET /api/sessions`, `GET /api/sessions/current`,
  `PATCH /api/sessions/current` (rename), `POST /api/sessions/end`.
- **Saved/export:** `POST|DELETE /api/messages/:id/save`, `GET /api/saved`,
  `GET /api/saved/export.csv`.
- **Rosters:** `GET|POST /api/rosters`, `GET|PATCH|DELETE /api/rosters/:id`,
  `POST /api/rosters/:id/deploy`, `POST /api/rosters/:id/register-panelists`.
- **Zoom integration** (admin write): `GET|PUT|DELETE /api/zoom/credentials`,
  `POST /api/zoom/credentials/test`.
- **Org settings:** `GET /api/org/settings`, `PATCH /api/org/settings`
  (admin) — e.g. `notetakerFilterEnabled`.
- **Presenter notes** (`src/routes/presenterNotes.js`): list / send / dismiss.
- **AI** (`src/routes/ai.js`): `/api/ai/settings` (GET/PATCH admin),
  FAQ CRUD + approve/pause/resume/seed, events.
- **Billing** (`src/routes/billing.js`): `POST /api/billing/checkout`,
  customer-portal link.
- **Invitations** (`src/routes/invitations.js`): list/create/revoke (admin),
  `…/accept/:token` (public).
- **Webhooks** (`src/routes/webhook.js`, pre-auth, signature-verified):
  `POST /webhook/recall/chat`, `/webhook/recall/status`, `/webhook/zoom`,
  `/webhook/stripe`.
- **Ops:** `GET /health`, `GET /api/status` (public; counts only).

---

## 9. External integrations (contracts + gotchas)

Deep dives in `docs/backend/<system>.md`. Summary:

### Recall.ai — the meeting-bot layer (most critical)
- **Dispatch:** `POST /api/v1/bot/` with `meeting_url`, `bot_name`,
  `recording_config.realtime_endpoints` (`webhook`, events
  `participant_events.chat_message`), `start_recording_on: 'call_join'`,
  `automatic_leave` timeouts bumped to **4h** (so quiet panelist periods
  don't kick the bot). `join_at` for scheduled dispatch (dodges
  `adhoc_pool_depleted` 507s).
- **Inbound:** realtime webhook → `/webhook/recall/chat`. **Lifecycle**
  (`bot.done`/`bot.fatal`) is a *separate workspace webhook* →
  `/webhook/recall/status` — **must be configured in the Recall
  dashboard**; if absent, `bot_usage` close-out and any restart/auto-reconnect
  logic never fire.
- **Outbound:** `POST /api/v1/bot/{id}/send_chat_message/`.
- **Signing:** Svix `webhook-*` HMAC; secret `RECALL_WEBHOOK_SECRET`
  (unset = open endpoint — must set in prod).
- Region pinned by `RECALL_API_BASE` (prod: `us-west-2`). One workspace
  key serves all orgs. Detail: [`recall.md`](./backend/recall.md).

### Zoom
- **Webinar vs meeting:** in a **webinar**, attendee chat goes to
  *panelists* — a bot joined as an *attendee* can't see attendee chat.
  So bots must be **panelists**. Meetings have no such restriction.
- **Panelist auto-registration** (per-org **S2S OAuth**): `POST
  /v2/webinars/{id}/panelists` then `GET …/panelists` to retrieve
  `join_url` (the POST doesn't return it). Requires scopes
  `webinar:read:admin` + `webinar:write:admin` (granular:
  `webinar:read:list_panelists:admin` + `webinar:write:panelist:admin`)
  and the account's **Webinar add-on**. One S2S app covers all users in
  that Zoom account (admin scope). Detail: [`zoom.md`](./backend/zoom.md).
- **RTMS** (`@zoom/rtms`) is **mock-only**; would only be worth real
  integration for a future media/"Tiles" surface.

### Stripe, Resend, Railway
- **Stripe:** subscription checkout + customer portal; webhooks
  (`checkout.session.completed`, `customer.subscription.updated/deleted`)
  write the org's `plan_tier`/`concurrent_bot_limit` to the DB. **Plan
  enforcement reads the DB copy — Stripe is never on the request hot path.**
  Tiers in `src/services/tiers.js` (Solo $49.99/1 bot, Pro $199/5, Studio
  $499/20). [`stripe.md`](./backend/stripe.md).
- **Resend:** transactional auth email; console-log fallback when
  `RESEND_API_KEY` unset. [`resend.md`](./backend/resend.md).
- **Railway:** deploy-on-push from `main`; Nixpacks build runs
  `postinstall → vite build`; managed Postgres; env via Variables.
  [`railway.md`](./backend/railway.md).

---

## 10. Feature specs (capabilities layered on the pipeline)

- **Rosters + Deploy** — pre-build meetings; "Deploy" dispatches bots to
  all in parallel; per-entry **Relaunch** re-dispatches a single dropped
  bot; "Register & Deploy" combines panelist registration + deploy.
- **Panelist auto-registration** — per-org S2S creds (encrypted) entered
  in Settings → Zoom Integration with a **Test connection** check.
  Webinar entries opt in via a checkbox; emails auto-derive from a system
  base (`PANELIST_EMAIL_BASE`, e.g. `zoomchat@…`) as
  `zoomchat+<orgslug>-<roomslug>-<token>@base` (token = deterministic
  hash of the webinar id → globally unique, stable). Register fetches the
  `join_url` and stores it on the entry so Deploy joins the bot as a panelist.
- **Moderation** — per-message highlight / queue / **feature**; queue
  reorder; "Feature Next." State synced org-wide via Socket.IO so multiple
  operators stay in sync.
- **Presenter display** (`/display` pop-out, separate window + own socket)
  — borderless, secondary-screen, scalable typography; renders the
  **featured** message prominently; a broadcast-style **queue "bug"** in
  the lower-right shows live pending-question count (amber at 5+, pulsing
  red at 10+).
- **Presenter notes** — production→talent messages on the pop-out only
  (amber bar), org-wide, auto-dismiss configurable.
- **Notetaker filter** — drops third-party notetaker chatter (Otter,
  Fireflies, …) by **sender name OR content signature** (e.g. the
  `otter.ai/pricing` upsell posted under a real attendee's name) before
  it hits the feed/DB/AI. Per-org toggle (`notetaker_filter_enabled`,
  Settings → Chat Filters) + env `NOTETAKER_FILTER_DISABLED/EXTRA/CONTENT_EXTRA`.
- **AI auto-responder** (opt-in) — detects recurring questions →
  moderator approves the canonical answer → auto-replies to matches →
  self-heals (pauses on complaints). Model only advises; deterministic JS
  gates every send. Full spec: [`ai.md`](./backend/ai.md).
- **Saved messages + export** — bookmark to a Saved tab; per-message copy;
  **PNG quote-card** export (1080² via `html-to-image`); bulk CSV/JSON.
- **Trial + billing** — new orgs start on a 30-min/1-bot trial; tiers
  bypass enforcement; `TrialEnforcer` ticks and force-disconnects at limit.

---

## 11. Auth & multi-tenancy

- **Lucia-*pattern*** (the npm package was deprecated; primitives shipped
  directly): bcryptjs (cost 12), server-side sessions in `auth_sessions`,
  HTTP-only `zoomchat_session` cookie (Secure in prod, SameSite lax).
- `attachUser` (soft) runs on every request; `requireAuth` hard-gates
  `/api/*`; `requireAdmin` gates billing/team/integrations.
- **Bootstrap rule:** the first signup with no users claims the `ryte-org`
  admin tier (no limits).
- **Isolation:** every runtime query filters `org_id`; Socket.IO rooms are
  `org:<id>`; per-org `OrgState`. Detail: [`auth.md`](./backend/auth.md).

---

## 12. Frontend architecture

- **React 18 SPA**, context-per-domain: `Auth`, `Socket`, `Settings`,
  `Meetings`, `Moderation`, `Saved`, `Rosters`, `PresenterNotes`, `AI`.
- **Pages:** operator console (default), `/display` (presenter pop-out —
  a *separate window* with its own socket + provider stack), plus
  auth/verify/reset/accept-invite/upgrade pages.
- **Presenter sync:** the pop-out is a distinct React tree; it gets
  featured message / notes / queue count via its own Socket.IO connection
  (same org room), and typography via `localStorage` storage events.
- **macOS launcher:** Swift WKWebView thin client pointing at the prod
  URL (no bundled JS). ⌘R reloads to pick up deploys; native download
  handler saves PNGs; WKUIDelegate wires JS alert/confirm/prompt. Detail:
  [`mac-launcher.md`](./backend/mac-launcher.md).

---

## 13. Deployment & ops

- **Deploy:** `git push origin main` → Railway rebuilds (Nixpacks;
  `postinstall` runs the Vite client build) → restarts the Node process.
  Operators ⌘R the launcher to pick up the new bundle.
- **⚠️ Not zero-downtime, and the #1 operational gotcha:** a restart
  **wipes `RecallBotManager.botsByMeeting`**. Bots stay live in Zoom but
  their inbound chat is dropped (`unknown bot — dropping message`), and
  they show falsely "live" in the UI. **Recovery today is manual:**
  redeploy the roster (fresh, tracked bots) and `leave_call` the orphaned
  pre-restart bots via Recall. **The durable fix** (logged, not yet built)
  is to reseed routing from `bot_usage` (open rows) on startup — note it
  needs room name/color/bot name persisted too, since `bot_usage` alone
  lacks them.
- **Required env in prod:** `NODE_ENV=production`, `DATABASE_URL` (auto),
  `RECALL_API_KEY`/`RECALL_API_BASE`/`PUBLIC_WEBHOOK_URL`/`RECALL_WEBHOOK_SECRET`,
  `CRED_ENCRYPTION_KEY` (panelist secrets), `PANELIST_EMAIL_BASE`,
  Stripe + Resend keys. Full map: §3 of [`docs/backend/README.md`](./backend/README.md).

---

## 14. Config / env vars (quick map)

| Var | Purpose | Unset behavior |
|---|---|---|
| `DATABASE_URL` | Postgres | in-memory only, no persistence |
| `NODE_ENV` | prod gating (static serve, secure cookies) | dev behavior |
| `RECALL_API_KEY` / `_BASE` | bot dispatch + region | bot path disabled (RTMS mock) |
| `PUBLIC_WEBHOOK_URL` | where Recall posts chat | bots can't route chat back |
| `RECALL_WEBHOOK_SECRET` | webhook HMAC | **open endpoint (warn-only)** |
| `ZOOM_CLIENT_ID/SECRET`, `ZOOM_WEBHOOK_SECRET_TOKEN` | Zoom app + webhook verify | Zoom webhook/RTMS path off |
| `CRED_ENCRYPTION_KEY` | AES key for per-org Zoom secrets | panelist save fails |
| `PANELIST_EMAIL_BASE` | system default bot panelist alias base | per-org/explicit only |
| `STRIPE_SECRET_KEY` / `_WEBHOOK_SECRET` / `_PRICE_ID_*` | billing | billing disabled |
| `RESEND_API_KEY` / `EMAIL_FROM` | auth email | console-log fallback |
| `ANTHROPIC_API_KEY` | AI auto-responder | feature fully inert |
| `APP_URL` | email deep-links + Stripe redirects | — |
| `NOTETAKER_FILTER_DISABLED` / `_EXTRA` / `CONTENT_EXTRA` | notetaker filter tuning | filter on, default list |
| `SESSION_SECRET` | documented but **currently unused** | — |

---

## 15. Known limitations & risks (top — full list in the reference library)

The reference library's [README §4](./backend/README.md) carries the
ranked, `file:line`-cited risk register. The ones that most affect anyone
reusing this:

1. **In-memory bot routing lost on restart** (§13) — design around it.
2. **`RECALL_WEBHOOK_SECRET` unset = unauthenticated webhook** — always set it.
3. **Recall lifecycle webhook (`/webhook/recall/status`) may not be
   configured** — without it, bot-usage close-out and any restart/
   auto-reconnect logic never fire.
4. **Zoom `/webhook/zoom` verify is broken** (`crypto.timingSafeEquals`
   typo) — but that path is the inactive RTMS path; the live Recall path
   uses a correct verifier.
5. **Single-replica assumption** — no Socket.IO Redis adapter; scaling
   horizontally silently breaks `io.to(room)` fan-out and in-memory state.
6. **OBF not implemented** — external-host Zoom bots can fail OBF
   enforcement; relevant if dispatching into accounts you don't own.
7. **Tokens (session/email/invite) stored unhashed**; no auth rate
   limiting; no `helmet`. Standard hardening gaps.

---

## 16. How to incorporate this into another platform

What you're really reusing is the **real-time Zoom-chat capture engine**.
Everything else is optional scaffolding.

### The reusable core (the crown jewel)
`RecallBotManager` + `MessageAggregator` + the webhook receiver +
Socket.IO emit. The minimal viable subset:
1. **Dispatch a bot:** `POST /api/v1/bot/` with a realtime webhook
   pointing at your server (see §9 Recall for the exact body).
2. **Receive chat:** an HTTP endpoint that verifies the Svix HMAC and
   extracts `{ text, sender, participant.id, botId }` (see
   `extractChatMessage` in `RecallBotManager.js`).
3. **Route & fan out:** map `botId → your tenant`, push into your UI
   (Socket.IO, SSE, whatever). The message contract is in §5a.
4. **Send outbound:** `POST /api/v1/bot/{id}/send_chat_message/`.

That's a few hundred lines and one Recall account. Persistence (Postgres),
moderation, presenter display, AI, billing are all **additive layers** on
top of that contract.

### What to keep vs. drop when porting
- **Keep** if you want full capability: `MessageAggregator` (ring buffer +
  batched emit + filters), the notetaker filter, moderation state model,
  the presenter-display contract (featured message + queue count).
- **Drop / replace** if the host platform already has them: the SaaS layer
  (auth, `organizations`, Stripe billing, trial enforcement, invitations),
  the macOS launcher, Resend email. Map your platform's tenant → `org_id`.
- **Re-key tenancy:** everything hangs off `org_id` and Socket.IO
  `org:<id>` rooms. If your platform has its own tenancy, substitute that
  key throughout (one cohesive change — it's already centralized in
  `OrgState` + `validateSession`).

### External dependencies you must bring
- A **Recall.ai** account (API key + a *publicly reachable* webhook URL).
- For **webinar** capture: per-account Zoom **S2S OAuth** app with the
  webinar panelist scopes + Webinar add-on (or accept attendee-only
  capture, which misses webinar attendee chat).
- Postgres if you want persistence/saved/export/billing; the live feed
  works in-memory without it.
- Anthropic key only if you want the AI auto-responder.

### Architectural patterns worth carrying over
- **Webhook → fire-and-forget → always 200** (never let processing block
  or fail the webhook ack; Recall/Stripe retry on 5xx).
- **DB write is best-effort and never blocks the live emit** (chat shows
  even if Postgres hiccups).
- **Batched emits (100ms)** to survive high-volume rooms.
- **Deterministic gates around the LLM** (the model advises; JS decides) —
  see the AI safety boundary in [`ai.md`](./backend/ai.md).
- **Plan/enforcement reads a local DB copy**, written by billing webhooks —
  external billing is never on the request hot path.

### Pitfalls to design out from day one (we hit these)
- **Persist bot→tenant routing** (don't keep it only in memory) so a
  restart/redeploy doesn't orphan live bots — the single biggest
  operational pain here.
- **Configure the bot lifecycle webhook** so you actually learn when bots
  drop.
- **Plan for one process** unless you add a Socket.IO Redis adapter +
  externalize the in-memory maps.
- **Webinar ≠ meeting** for chat visibility — bots need panelist status in
  webinars.

---

*Maintained alongside the per-system reference library in
[`docs/backend/`](./backend/README.md). When behavior changes, update both.*
