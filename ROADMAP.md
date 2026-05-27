# Roadmap

What's been shipped, what's parked, and what's worth considering if the
app keeps growing. See [`docs/CHAT-CAPTURE-ARCHITECTURE.md`](docs/CHAT-CAPTURE-ARCHITECTURE.md)
for chat-pipeline context and [`docs/MONETIZATION-PLAN.md`](docs/MONETIZATION-PLAN.md)
for the SaaS/billing direction.

---

## ✅ Shipped

### Core capture & storage

- **Real chat ingestion via Recall.ai** — operator pastes a Zoom
  Meeting ID + passcode + chosen bot display name, server dispatches
  a Recall bot, chat events stream back via signed webhook. HMAC
  verification on `/webhook/recall/chat`. (`57ff1c9`, `67fa7e7`)
- **Persistent Postgres storage** — every message + session writes
  through to Railway Postgres. In-memory ring buffer hydrates from
  current session on startup; Railway restarts mid-event are
  invisible. Schema is idempotent (`CREATE TABLE IF NOT EXISTS` on
  every boot). (`f79cd0f`)
- **Bot usage tracking foundation** — `bot_usage` table populated on
  every bot dispatch, closed out by `bot.done` / `bot.fatal` workspace
  webhook (configured Recall-side at
  `/webhook/recall/status`). Per-bot duration ready for billing
  rollups. Disconnect path also closes the row. (`6980d49`)
- **Tenant id placeholder** — `tenant_id` column on sessions /
  messages / bot_usage / rosters / sent_messages, defaulting to
  `'ryteproductions'`. Migration to real org IDs when multi-tenant
  lands is a one-line `UPDATE`. (`6980d49`)

### Sessions

- **Named sessions** with rename / end & start new / past-sessions
  browser. Each session is the unit of "one live event run." Past
  sessions modal lists name, dates, message + saved counts, per-row
  CSV export. (`6bac18d`)
- **Smart exit dialog** — closing the main window hides it; ⌘-Q
  prompts **End Session and Quit** / **Keep Running and Quit** /
  **Cancel**. The "End Session" path calls `POST /api/sessions/end`
  before terminating. (`741ca8a`)

### Operator outbound chat

- **Reply to a specific room** — inline Reply button on each chat
  message, expands to a textarea, ⌘↩ to send. Goes to the originating
  meeting only via Recall's `/bot/{id}/send_chat_message/`. (`6bb3a48`)
- **Broadcast to all rooms** — collapsible inline composer at the top
  of the chat feed (always visible, never scrolls away). Single
  message fans out to every active bot in parallel. (`7d25e40`)
- **Outgoing messages persist in the feed** with a colored "↩ Reply"
  or "📢 Broadcast" pill alongside the bot name, subtle accent
  background, accent left-edge stripe. Operator has visual confirmation
  of what they sent. (`7d25e40`)
- **Echo dedup** — if Recall webhooks back the bot's own outgoing
  message via the chat-message event, MessageAggregator skips it
  (matches recent outgoing by sender+content+meetingId within 5s).
  No duplicates. (`7d25e40`)
- **Per-bot outbound rate limit** — token bucket, 20 messages/min
  per bot, refills every 60s. Belt-and-suspenders against accidental
  loops and credential abuse. (`6bb3a48`)
- **Sent-message audit log** — every reply + every broadcast writes
  a row to `sent_messages` table (id, recall_bot_id, meeting_id,
  session_id, tenant_id, text, is_broadcast, sent_at). (`6bb3a48`)

### Operator identity

- **Operator-chosen bot display name** — required field in the
  Connect form, no vendor-branded default. Persists last-used in
  localStorage so it's pre-filled next time. Means the bot appears
  to meeting participants as e.g. "Audience Q&A" or "Producer
  Theo" — whatever fits the event. (`6bb3a48`)

### Saved messages + export

- **Bookmark icon on every message** → new **Saved** sidebar tab.
- **Per-message Copy text** — formatted plain-text quote with
  attribution.
- **PNG quote card export** — 1080×1080 (rendered at 2160×2160 for
  Retina), accent-color left stripe + opening quote mark, adaptive
  font sizing, sender name attribution. **No room pill, no brand
  footer** (operator can add a custom brand later — see Future
  Ideas). (`92afde7`, `9da9382`)
- **Bulk CSV / JSON export** of saved messages for the current
  session. (`f79cd0f`)

### Rosters (one-click meeting deploy)

- **Pre-built rosters** — operator creates a named list of meetings
  ahead of an event (Meeting ID, passcode, room name, color, bot
  name per entry). Lists in a new **Rosters** sidebar tab.
- **One-click "Deploy"** dispatches bots to every entry in parallel,
  per-entry success/failure feedback.
- **Already-connected dedup** — re-deploying a roster doesn't
  duplicate active bots (no extra Recall cost).
- **Solves quit-and-rejoin pain** — if you ⌘-Q mid-event, just open
  Rosters and click Deploy to reconnect everything at once.
  (`1a6fede`)

### .app (Mac launcher)

- **Thin-client architecture** — 1.2 MB Swift WKWebView pointing at
  the Railway URL. No bundled Node, no secrets in the .app, no
  Node prerequisite on target Macs. Drag-and-drop installable on
  any Mac 13+. (`eb3914f`)
- **Single-instance Window** (not `WindowGroup`) — closing the
  window hides; Dock click or Window menu reopens. Doesn't quit the
  app. (`5e54863`)
- **⌘R reload command** — pulls the latest deploy without
  quit-and-relaunch. ⌘R or **View → Reload**. (`64d9e07`)
- **Native download handler** — WKDownloadDelegate auto-saves
  exported PNGs to `~/Downloads` (timestamp-suffixed if duplicate).
  Fixed silent failure where WKWebView swallows `<a download>`
  clicks on data: URLs. (`d488de6`)

### Presenter display window (pop-out for secondary monitor)

- **Auto-places on secondary screen** if connected, else 1280×720
  centered.
- **Borderless look, draggable from anywhere** — transparent
  invisible titlebar + hidden traffic lights + `mouseDownCanMoveWindow`
  on a WKWebView subclass.
- **Double-click toggles native full-screen** with the standard zoom
  animation.
- **⎋ Esc** exits full-screen first; second Esc closes the window.
- **In Window menu** so the operator can re-front it if buried.
- **Font sync** with main window via storage events + scalable CSS
  variables; "Display View Scale" preset in Typography settings
  (1×–3×, 1.5× default).
  (`a94221b`, `426bad9`, `4ff1927`, `038cac3`, `d24bdd0`, `e4501d1`)

### Architecture pivot docs

- [`docs/CHAT-CAPTURE-ARCHITECTURE.md`](docs/CHAT-CAPTURE-ARCHITECTURE.md)
  records the RTMS → Meeting SDK → Recall decision history. RTMS was
  initially planned but doesn't fit cross-org meetings; Meeting SDK
  was considered; Recall picked because they handle OBF chaperoning
  for us and abstract away the SDK + Docker complexity.
- [`docs/MONETIZATION-PLAN.md`](docs/MONETIZATION-PLAN.md) is the
  end-to-end plan for converting the tool into a SaaS: pricing
  tiers (Solo $49 / Pro $199 / Studio $499 with concurrent-bot
  caps), auth (Clerk vs Lucia decision), Stripe Billing, phased
  implementation (~4-6 weeks dev + ~2 weeks legal).

---

## ⏸️ Parked (intentionally deferred)

### Custom domain `zoomchat.ryteproductions.com`
Cloudflare DNS doesn't currently resolve it. Not urgent because the
.app wraps the URL — no end user ever sees `web-production-92d23.up.railway.app`.
**Only real reason to do it:** insulation against future hosting
migration (if you ever move off Railway, owning the URL means Recall
webhook config doesn't have to change). 5-minute task whenever:
re-auth `railway`, run `railway domain zoomchat.ryteproductions.com`,
add the CNAME (DNS-only, NOT proxied) in Cloudflare, update `kAppURL`
in `launcher-v2/Sources/main.swift`, rebuild .app.

### Rotate the `RECALL_WEBHOOK_SECRET`
Pasted into the chat during setup and visible in scrollback. Low
practical risk (it's a webhook-verification secret, not an API key —
worst case someone can forge inbound chat events to your server) but
worth rotating eventually. Recall dashboard → Developers → API Keys &
Secrets → Create new → `railway variables --set "RECALL_WEBHOOK_SECRET=whsec_..."`.

---

## 💡 Future ideas (not committed to)

These came up during build but weren't asked for. Worth considering as
the tool matures.

### Custom brand mark on PNG quote cards
We removed the hardcoded "RYTE PRODUCTIONS" footer from quote cards
because the operator-pick-everything principle suggests branding
should be operator-chosen too. To bring back configurable branding:

- Add a **Settings → Branding** section (settings panel already has
  most plumbing) with a single text field **"Brand mark (PNG
  exports)"**, defaulting to empty.
- Wire `settings.brandMark` into `QuoteCard.jsx`'s render: when set,
  show in the bottom-right slot we cleared out (~18px, letter-spaced,
  semi-opaque white, same position as the old hardcoded footer).
- When empty (default), no footer renders.
- ~15 minutes of work. Same pattern lets each client put their own
  brand on cards if they want — RYTE could put "RYTE PRODUCTIONS",
  a corporate client could put "Acme Corp Q3 2026", etc.
- **Stretch:** also allow a small logo URL or upload, rendered as a
  semi-opaque image. More work (~1-2 hours to handle file upload,
  hosting, sizing). Not needed for v1.

### Past-session message browser (read in app)
Currently you can list past sessions and download their saved-message
CSV, but the full chat log of a past session is only viewable by
querying Postgres directly. A read-only "load past session" view in
the app would close that loop.

### Multiple PNG export aspect ratios
Quote card is 1:1 (Instagram feed). Could add 9:16 (stories), 1.91:1
(Twitter), 16:9 (presentation slide). Picker in the PNG button menu.

### Menu bar status indicator
Slack-style — a small NSStatusBar icon that shows whether a session
is recording at a glance, with a quick menu to bring up the window or
end the session. Useful if the operator runs other apps in the
foreground during a show.

### Per-session statistics / after-event report
Auto-generate a printable summary at session end: total messages by
room, top contributors, message volume over time, saved highlights.
Postgres has the data already; just a query + render.

### Smart end-session detection
The smart exit dialog asks the operator — but the server could also
auto-suggest "the session has been idle for N minutes, end it?" Could
be a websocket nudge in the React UI.

### Multi-tenant SaaS / monetization
Full plan in [`docs/MONETIZATION-PLAN.md`](docs/MONETIZATION-PLAN.md).
TL;DR: charge customers per bot-hour with tiered subscriptions (Solo
$49 / Pro $199 / Studio $499) to cover Recall costs + margin.
Requires multi-tenant auth (Clerk vs Lucia decision deferred to
Phase 1 start), usage tracking (already gathering via `bot_usage`),
and Stripe Billing. **~4-6 weeks of dev + ~2 weeks of legal/policy**
to go from current state to "charging real customers." Not urgent —
gather real-event usage data first, then commit to the rebuild.

### "Hide cursor in showtime" toggle
Removed the auto-hide-after-3s during the revival because it clashed
with borderless-window setup. A single button in the SessionHeader
(or display view itself) to toggle cursor visibility for an in-progress
show would be the right way to bring it back without the setup
friction.

### Multi-operator polish
Multi-operator already works (shared backend → both operators see
the same live state synced via Socket.io and Postgres, bot dispatch
dedupes so 2 operators on 1 meeting = 1 bot). Refinements worth doing
eventually:
- **Presence indicator** in the header: "Theo and Sarah are
  moderating." Socket.io makes this trivial.
- **Per-action attribution** — store `featured_by_user_id`,
  `saved_by_user_id`, etc. on moderation/save events. Lands free with
  the multi-user auth rebuild.
- **Conflict UX** — toast notification when another operator
  features a different message within 2 seconds of yours.
- **Observer mode** — role differentiation (admin / operator /
  observer) so non-moderating viewers can watch the feed without
  feature/save powers.
