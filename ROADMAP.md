# Roadmap

What's been shipped, what's parked, and what's worth considering if
the app keeps growing. See
[`docs/CHAT-CAPTURE-ARCHITECTURE.md`](docs/CHAT-CAPTURE-ARCHITECTURE.md)
for chat-pipeline context and
[`docs/MONETIZATION-PLAN.md`](docs/MONETIZATION-PLAN.md) for the
SaaS pricing plan (now mostly shipped — see below).

---

## ✅ Shipped — operational features

### Core capture & storage

- **Real chat ingestion via Recall.ai** — operator pastes a Zoom
  Meeting ID + passcode + bot display name, server dispatches a
  Recall bot, chat events stream back via signed webhook.
  HMAC verification on `/webhook/recall/chat`.
- **Persistent Postgres storage** — every message + session writes
  through to Railway Postgres. In-memory ring buffer hydrates from
  current session on startup; Railway restarts mid-event are
  invisible. Schema applied idempotently (`CREATE TABLE IF NOT EXISTS`)
  on every boot.
- **Bot usage tracking** — `bot_usage` table populated on every bot
  dispatch, closed out by `bot.done` / `bot.fatal` workspace
  webhook. Per-bot duration drives billing rollups.

### Sessions

- **Named sessions** with rename / end & start new / past-sessions
  browser. Each session is the unit of "one live event run."
- **Smart exit dialog** — closing the main window hides it; ⌘-Q
  prompts End Session / Keep Running / Cancel.

### Operator outbound chat

- **Reply to a specific room** — inline Reply button on each chat
  message. Goes to the originating meeting only via Recall's
  `/bot/{id}/send_chat_message/`.
- **Broadcast to all rooms** — collapsible inline composer at the
  top of the chat feed. Single message fans out to every active bot
  in parallel.
- **Outgoing messages persist in the feed** with a colored "↩ Reply"
  or "📢 Broadcast" pill.
- **Echo dedup** — Recall sometimes webhooks back the bot's own
  outgoing message; MessageAggregator skips it (matches recent
  outgoing by sender+content+meetingId within 5s).
- **Per-bot outbound rate limit** — token bucket, 20 msgs/min/bot.
- **Sent-message audit log** — every reply + broadcast writes a row
  to `sent_messages`.

### Saved messages + export

- **Bookmark icon on every message** → Saved sidebar tab.
- **Per-message Copy text** — formatted plain-text quote with
  attribution.
- **PNG quote card export** — 1080×1080 (rendered at 2160×2160 for
  Retina), accent-color left stripe + opening quote mark, adaptive
  font sizing, sender name attribution.
- **Operator-configurable brand mark** on PNG exports
  (Settings → Branding).
- **Bulk CSV / JSON export** of saved messages for the current
  session.

### Rosters

- **Pre-built rosters** — operator creates a named list of meetings
  ahead of an event (Meeting ID, passcode, room name, color, bot
  name, registration URL per entry).
- **Show start time** on rosters — when set + >10 min ahead,
  triggers Recall scheduled-bot dispatch (`join_at`), which uses
  dedicated bot instances and never hits `adhoc_pool_depleted` 507
  errors.
- **One-click "Deploy"** dispatches bots to every entry in parallel.
- **Per-entry "Relaunch"** — expand a roster row to see individual
  meetings + relaunch any single one that dropped.
- **Already-connected dedup** — re-deploying a roster doesn't
  duplicate active bots.

### .app (Mac launcher)

- **Thin-client architecture** — 1.3 MB Swift WKWebView pointing at
  the production URL. No bundled Node, no secrets, no Node
  prerequisite. Drag-and-drop installable on any Mac 13+.
- **Single-instance Window** — closing the window hides; Dock click
  reopens.
- **⌘R reload command** — pulls the latest deploy without
  quit-and-relaunch.
- **Native download handler** — auto-saves PNG exports to `~/Downloads`.
- **Native JS dialogs** (alert / confirm / prompt) wired up via
  WKUIDelegate so React `window.alert`/`confirm`/`prompt` just work
  in the .app.

### Presenter display window

- **Auto-places on secondary screen**, borderless, draggable from
  anywhere, double-click for full-screen, Esc to exit / close.
- **Font sync** with main window via storage events + scalable CSS
  variables.
- **Featured chat bubble** — pinned message rendered prominently
  with room-color accent, near-opaque background, pure white text.
- **Presenter notes overlay** — production team sends short notes
  ("Wrap in 5 min") that appear in an amber bar above the featured
  chat. Per-browser auto-dismiss timer (Settings → Typography →
  Production note auto-clear). Org-wide, presenter-only.

---

## ✅ Shipped — SaaS platform (May–June 2026)

The monetization rollout shipped across these phases:

### Phase 1 — Auth backbone
- Lucia-pattern auth: bcryptjs + Postgres sessions + HTTP-only cookies.
  (Lucia npm package was deprecated March 2025; primitives shipped directly.)
- Tables: `organizations`, `users`, `auth_sessions`, `email_tokens`,
  `invitations`.
- `/api/auth/*` — signup, login, logout, /me, verify-email, password-reset.
- Bootstrap rule: first signup with no users claims the `ryte-org`
  admin tier (RYTE Productions, no limits).
- Resend wired for transactional email (with console-log fallback
  when `RESEND_API_KEY` unset).

### Phase 2 — Org isolation + login wall
- `requireAuth` middleware on all `/api/*` (except `/api/auth/*`,
  `/api/status`, `/health`, `/webhook/*`).
- Per-org runtime state via `OrgState` — lazy SessionManager +
  MessageAggregator per org. Two customers on the same server are
  fully isolated.
- Socket.io auth middleware: each socket validates session cookie
  on handshake, auto-joins `org:<id>` room.
- Front-end login wall, signup/verify/reset pages.
- AccountMenu shows email + org + tier badge.

### Phase 3 — Trial enforcement
- Signup → org starts on `trial` plan, 30 min, 1 concurrent bot.
- `TrialEnforcer` ticks every 30s: computes used bot-minutes from
  `bot_usage`, updates DB, emits socket events.
- At 25 min: `trialWarning`. At 30 min: bot posts CTA into meetings,
  force-disconnects, emits `trialExhausted`.
- Admin / Solo / Pro / Studio tiers bypass trial enforcement.

### Phase 4 — Stripe Checkout
- LIVE mode in production. Real cards charged.
- Subscription mode with org metadata flowing through.
- `/webhook/stripe` handles `checkout.session.completed`,
  `customer.subscription.updated`, `customer.subscription.deleted`.
- Stripe Customer Portal for cancel / payment method / tier switch.
- Comp coupon for "first event free" client onboarding.

### Phase 5 — Team panel
- Settings → Team: list members, invite by email, change roles
  (admin / operator), remove members, revoke pending invitations.
- Invitation links via Resend with 7-day token TTL.
- Accept-invite page lands recipient in the existing org.

### Phase 6 — Custom domain
- `zoomchat.ryteproductions.com` with Railway-issued TLS cert.
- Email links, Stripe redirects, .app launcher all point at the
  custom domain.

### Tiers (Pro + Studio added on top of Solo)
- `src/services/tiers.js` is the single source of truth.
- **Solo** — $49.99/mo, 1 concurrent bot.
- **Pro** — $199/mo, 5 concurrent bots.
- **Studio** — $499/mo, 20 concurrent bots.
- Tier resolution at webhook time via `tier_key` metadata or price-id
  lookup as fallback.

### Scheduled bots
- Operator-supplied "Show start time" on Connect form + Rosters.
- When >10 min ahead, server passes `join_at` to Recall →
  dedicated-instance scheduling (immune to adhoc pool depletion).

### Registration URL support (for registration-required meetings/webinars)
- Operator pastes a tokenized Zoom URL into the "Registration URL"
  field (Connect form or roster entry).
- Server auto-resolves shorteners like `joinevent.link` via HEAD
  before passing to Recall.
- Bot joins as a registered attendee, bypassing Zoom's registration
  gate. (Promoting to panelist is still a manual Zoom-side step —
  see Future Ideas for Zoom API automation.)

### Recall bot reliability defaults (June 2026 hardening)
- `automatic_leave` timeouts bumped from default 2-sec / 20-min to
  4 hours across the board. Bots ride through quiet panelist moments
  without being kicked.
- `start_recording_on: 'call_join'` so chat capture begins
  immediately, not waiting for first participant.
- On Recall `bot.done` / `bot.fatal` we clear in-memory bot record
  so the operator can re-dispatch without hitting the duplication
  guard.

### Presenter notes
- `presenter_notes` table + `/api/presenter-notes` + socket events.
- Moderator → presenter direct messaging via amber composer in the
  Moderation panel. Org-wide; appears only on the presenter pop-out
  (not in moderator chat, not in Zoom rooms).
- Operator display name stored in localStorage for attribution.
- Auto-dismiss configurable per-browser in Settings.

---

## ⏸️ Parked (intentionally deferred)

### Rotate the `RECALL_WEBHOOK_SECRET`
Pasted into chat during setup. Low practical risk (webhook signing
secret, not API key). Rotate when convenient via Recall dashboard +
`railway variables --set`.

### Apple Developer signing for the .app
$99/yr — would eliminate the Gatekeeper "unidentified developer"
warning customers see on first launch. Add when client install
volume justifies it.

---

## 💡 Future ideas (not committed to)

### Auto-register bots as Zoom panelists via Zoom API
**The biggest pending UX win.** Currently the operator (or host) has
to manually register the bot via the Zoom web form, copy the
`joinevent.link` URL out of email, and paste it into our app for
each meeting. The Zoom REST API supports `POST /v2/webinars/{id}/panelists`
which would let us register a bot directly and get the tokenized
join URL back as a JSON response.

Sketch:
- Settings → "Zoom integration" section
- Customer creates a Zoom Server-to-Server OAuth app, gives us
  Account ID + Client ID + Client Secret (one-time)
- "Auto-register bots" button on the roster editor fills in all
  `meeting_url` fields with fresh tokenized URLs
- Customer never touches Zoom's registration UI

Estimate: ~half day. Should be the next build for any customer who
runs registration-required webinars (which is most of them).

### React message list virtualization
At sustained 400+ msgs/sec the chat feed chugs because all 500
ring-buffer messages stay in the DOM. `react-window` would render
only the visible ~30 at a time. ~1-2 hrs.

### Aggregate "noise" responses
When 1000 attendees all type "1" in response to "give me a 1 in
chat if you agree," the feed becomes unreadable. Collapse identical
short responses into a single counter row: "*1,047 people sent
'1'*." Probably ~half day for the right UI.

### Multi-org membership per user
Today `users.org_id` is a foreign key — one org per user. Agencies
that want to be a member of multiple client orgs from a single
account (Slack/Linear shape) can't. Needs `org_memberships` join
table + active-org state on the session. ~1-2 days. Wait for a
real customer to ask before building — easy to land the wrong
abstraction otherwise.

### Per-room moderation state
Each room owns its own "featured/highlighted/queued" state instead
of org-wide. Required for "each operator moderates their own room
independently" workflows. ~3-4 hrs. Not asked for yet — the studio
host + remote moderators pattern works fine on org-wide state.

### Past-session message browser (read in app)
Currently you can list past sessions and download saved-message
CSVs, but the full chat log of a past session is only viewable via
Postgres directly. A read-only "load past session" view would close
the loop.

### Multiple PNG export aspect ratios
Quote card is 1:1 (Instagram feed). Could add 9:16 (stories),
1.91:1 (Twitter), 16:9 (presentation slide). Picker in the PNG
button menu.

### Menu bar status indicator
Slack-style — small NSStatusBar icon showing whether a session is
recording at a glance. Useful if operator runs other apps in the
foreground.

### Per-session statistics / after-event report
Auto-generate printable summary at session end: messages by room,
top contributors, message volume over time, saved highlights.
Postgres has the data; just a query + render.

### "Hide cursor in showtime" toggle
Single button in SessionHeader (or display view) to toggle cursor
visibility for in-progress shows.

### Multi-operator polish
Multi-operator works (shared backend, dedup, etc.). Refinements:
- **Presence indicator** in header: "Theo and Sarah are moderating."
- **Per-action attribution** — store `featured_by_user_id` on
  moderation/save events.
- **Conflict UX** — toast when another operator features a different
  message within 2s of yours.
- **Observer role** — non-moderating viewers who watch the feed
  without feature/save powers.

### Migrate off Railway if reliability bites
Railway works but had a few incidents during launch. If it becomes
a pattern, Fly.io is the natural next step — same simple deploy
model, better historical reliability, similar pricing. ~3-5 hrs
of migration work when needed.
