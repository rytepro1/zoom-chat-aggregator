# Roadmap

What's been shipped, what's parked, and what's worth considering if the
app keeps growing. See [`docs/CHAT-CAPTURE-ARCHITECTURE.md`](docs/CHAT-CAPTURE-ARCHITECTURE.md)
for the deeper architecture context.

---

## ✅ Shipped (May 2026 revival sweep)

### 0. Real chat ingestion — Recall.ai integration
Replaces the prior mock-only chat capture. A Meeting ID + passcode in the
React UI dispatches a Recall bot (named "Chat Capture by RYTE
Productions") which joins the meeting, captures chat, and POSTs it to
our webhook. HMAC-signed via `RECALL_WEBHOOK_SECRET`. Works with
external-host meetings — Recall handles OBF chaperoning on their side.
Commits: `57ff1c9`, `67fa7e7`.

### 1. Display window font sync
Two compounding bugs fixed: SettingsContext now listens for `storage`
events so settings changes in the main window propagate to the
pop-out display in real time; ChatMessage `displayMode` reads
`calc(var(--message-font-size) * var(--display-scale))` instead of
hardcoded Tailwind sizes. New "Display View Scale" preset (1×–3×, 1.5×
default) in Settings → Typography. Commit: `a94221b`.

### 2. Save & export individual chat messages
Bookmark icon on every message → new **Saved** sidebar tab with three
export options:
- **Copy text** — plain-text attribution string
- **PNG** — 1080×1080 (rendered at 2160×2160 for Retina) branded quote
  card with room-color accent, adaptive font size, RYTE footer mark
- **Export CSV / JSON** — bulk download all saved messages
Server-side endpoints: `POST/DELETE /api/messages/:id/save`,
`GET /api/saved`, `GET /api/saved/export.csv`. Commits: `f79cd0f`,
`92afde7`.

### 3. Persistent log + sessions + smart exit dialog
**Storage:** Postgres on Railway (Hobby plan, ~free). Schema:
sessions(id, name, started_at, ended_at) + messages(...) with indices
on session_id, saved, timestamp. MessageAggregator writes through on
every addMessage and hydrates the in-memory ring buffer from the
current session on startup. Railway restart mid-event is invisible.
**Sessions:** SessionHeader in the app header shows current session
name (click to rename), chevron menu with End & Start New / View Past
Sessions actions. Past Sessions modal lists every session with name,
dates, message + saved counts, and per-row CSV export.
**Smart exit:** closing the window just hides the .app (Dock icon
re-shows); ⌘-Q triggers a dialog: **End Session and Quit** / **Keep
Running and Quit** / **Cancel**. Commits: `f79cd0f`, `6bac18d`,
`741ca8a`.

### 4. .app architecture pivot — thin client
Original launcher bundled Node + project + node_modules (~226 MB) and
ran a local server. Replaced with a 1.2 MB Swift WKWebView pointing
directly at Railway. No secrets in the .app, no Node prerequisite on
target Macs. Drag-and-drop installable on any Mac 13+. Commits:
`eb3914f`, `426bad9`, `4ff1927`, `038cac3`, `d24bdd0`, `e4501d1`.

### 5. Presenter display window UX
Pop-out window for the on-air host's confidence monitor:
- Auto-places on the secondary screen if one's connected, otherwise
  opens 1280×720 centered for setup
- Looks borderless (transparent invisible titlebar + hidden traffic
  lights) but drags from anywhere via `mouseDownCanMoveWindow` on a
  WKWebView subclass
- **Double-click** toggles native macOS full-screen with the standard
  zoom animation
- **⎋ Esc** exits full-screen first; second Esc closes the window
- Window menu entry so the operator can re-front it if buried
Commits in the same range as the .app pivot.

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
TL;DR: charge customers per bot-hour with tiered subscriptions to
cover Recall costs + margin. Requires multi-tenant auth (Clerk
recommended), usage tracking (Recall `bot.status_change` webhooks),
and Stripe Billing. ~4–6 weeks of dev + ~2 weeks of legal/policy to
go from current state to "charging real customers." Not urgent —
gather real-event usage data first, then commit to the rebuild.

Two no-regret moves that make the eventual rebuild easier and can
land any time:
- Subscribe to Recall's `bot.status_change` webhook, log join/leave
  times to a simple table. Builds a real-bot-hour dataset to inform
  pricing decisions.
- Add a `tenant_id` placeholder column to sessions / messages /
  saved (default to a constant). Schema migration to real org_ids
  later becomes a one-line UPDATE.

### "Hide cursor in showtime" toggle
Removed the auto-hide-after-3s during the revival because it clashed
with borderless-window setup. A single button in the SessionHeader
(or display view itself) to toggle cursor visibility for an in-progress
show would be the right way to bring it back without the setup
friction.

### Operator-sends-chat (reply-all only)
Recall's bot API supports `POST /api/v1/bot/{id}/send_chat_message/`.
We could surface a "Reply" affordance in the React UI that posts a
message back into the meeting as the bot. Decisions made:
- **Scope:** reply-to-all only for v1. No DMs (privacy/compliance
  risk — see MONETIZATION-PLAN.md).
- **Identity:** operator picks the display name the bot uses per
  meeting (not stuck with "Chat Capture by RYTE Productions").
  Probably a field in the Meeting Manager's connect form, defaulting
  to a session-wide setting.
- **Rate limit:** server-side cap (e.g. 30 messages/minute per bot)
  with a clear error if exceeded. Belt-and-suspenders against
  accidental loops and credential-compromise abuse.
- **Audit log:** every sent message logged with sender (auth user
  once we have auth), bot id, meeting id, timestamp.
- **Reply mechanism:** could be either an inline reply button on each
  ChatMessage (replies-in-context UX) or a dedicated compose box at
  the bottom of the feed. Inline probably feels more natural for
  "answering an audience question."
- **Tier-gating (post-monetization):** Solo = capture only; Pro+ =
  capture + reply.

Effort: ~1 day for the basic "reply to all" wired into the existing
chat flow. Replies round-trip through our own /webhook/recall/chat so
they show up in the feed automatically, no special persistence.

### Multi-operator polish
Multi-operator already works (shared backend → both operators see
the same live state synced via Socket.io and Postgres). Refinements
worth doing eventually:
- **Presence indicator** in the header: "Theo and Sarah are
  moderating." Socket.io makes this trivial — track connected client
  count + identity, emit a presence event on connect/disconnect.
  Probably tier-gated to Pro+ since Solo is single-operator by
  definition.
- **Per-action attribution.** Lands naturally with multi-user auth
  in monetization Phase 1: store `featured_by_user_id`,
  `saved_by_user_id`, etc. on moderation/save events. Surface as a
  tooltip ("featured by Sarah, 2 min ago") on highlighted messages.
- **Conflict UX.** Today's "last write wins" is fine in practice
  (operators talk to each other) but pathological races during a
  hot moment are possible. Could add a brief "Sarah just featured a
  different message" toast notification when a feature changes from
  someone else's hand within 2 seconds of your own intent.
- **Observer mode / role differentiation.** Right now every operator
  has equal moderation powers. Tier-gated as a Pro+ feature later:
  admin/operator/observer roles, with observers seeing the feed but
  unable to feature/save.

Effort: presence indicator is ~half a day standalone. Attribution
piggybacks on the auth rebuild (free if done together). Conflict UX
and observer mode are nice-to-have polish, ~1-2 days each.
