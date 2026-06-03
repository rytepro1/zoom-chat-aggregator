# Recall.ai

> Recall.ai is the meeting-bot infrastructure layer that joins Zoom meetings as a participant, captures chat in real time, and fires it to our webhook. Pinned version: **API v1**, region **us-east-1** (raw fetch, no SDK).

---

## How we use it

The `RecallBotManager` class (`src/recall/RecallBotManager.js`) is the sole integration point. It is constructed once at server startup (`src/server/index.js:49-53`) with credentials pulled from env vars, then stored on `app` for access by route handlers.

**Full flow, end to end:**

1. **Operator dispatches a bot** — `POST /api/meetings/connect` (`src/server/index.js:171`) calls `recallBotManager.connect(orgId, meetingId, passcode, roomName, roomColor, botName, scheduledFor, customJoinUrl)`.
2. **URL construction** — `connect()` builds a Zoom URL (`https://zoom.us/j/{meetingId}?pwd={passcode}`) unless a `customJoinUrl` was supplied. Shortener URLs (joinevent.link, etc.) are resolved via a HEAD-only probe (`src/recall/RecallBotManager.js:15-47`) because Recall requires a direct `zoom.us` URL.
3. **Bot create API call** — `POST {RECALL_API_BASE}/bot/` (`src/recall/RecallBotManager.js:276`) with:
   - `meeting_url`
   - `bot_name` (operator-chosen, required)
   - `recording_config.realtime_endpoints` — a single webhook endpoint at `{PUBLIC_WEBHOOK_URL}/webhook/recall/chat` subscribed only to `participant_events.chat_message`
   - `recording_config.start_recording_on: "call_join"` — captures pre-show chat
   - `automatic_leave` timeouts all set to 14400s (4 hours) — overrides Recall's aggressive 2s `everyone_left_timeout` default
   - `join_at` — only set when `scheduledFor` is >10 min in the future (`src/recall/RecallBotManager.js:189-195`)
4. **In-memory tracking** — on success, two maps are populated: `botsByMeeting` (meetingId → botInfo) and `meetingsByBot` (botId → meetingId). These are the sole persistence mechanism for routing inbound webhooks; a process restart loses them.
5. **DB audit row** — `INSERT INTO bot_usage` (`src/recall/RecallBotManager.js:324-330`) records the dispatched bot for billing.
6. **Inbound chat webhook** — Recall POSTs `participant_events.chat_message` events to `/webhook/recall/chat` (`src/routes/webhook.js:167`). The route verifies the Svix signature (`verifyRecallWebhook`) then fires `recallBotManager.handleChatEvent(req.body)` fire-and-forget.
7. **Message routing** — `handleChatEvent()` extracts `botId` from the payload, looks up `meetingId` and `orgId` from in-memory maps, fetches the org's `MessageAggregator` from `OrgState`, and calls `ma.addMessage()` to push the message to the operator UI via Socket.io.
8. **Bot lifecycle webhook** — `/webhook/recall/status` (`src/routes/webhook.js:341`) receives workspace-level `bot.*` events (e.g. `bot.done`, `bot.fatal`). Same Svix verification. `handleStatusChangeEvent()` closes the `bot_usage` row, clears in-memory maps, and emits `meetingDisconnected` to the UI.
9. **Disconnect** — `POST /api/meetings/:id/disconnect` calls `recallBotManager.disconnect()` which POSTs to `{RECALL_API_BASE}/bot/{botId}/leave_call/` and clears maps/DB row immediately, without waiting for the status webhook.
10. **Outbound chat** — `POST /api/meetings/:meetingId/reply` and `POST /api/broadcast` call `recallBotManager.sendChatToMeeting()` / `broadcastChat()`, which POST to `{RECALL_API_BASE}/bot/{botId}/send_chat_message/` with `{ to: "everyone", message: text }`. A token-bucket rate limiter (default 20/min per bot) guards against runaway sends.

---

## Core concepts

**Bot model**: Recall deploys a participant-visible bot (not a silent server tap) that appears in the Zoom participant list under whatever `bot_name` you set. It captures real Zoom chat events via the Zoom Meeting SDK under the hood.

**Two webhook systems, two different configs:**

| System | What it fires | How to configure |
|--------|--------------|-----------------|
| `recording_config.realtime_endpoints` | Per-bot, per-event: `participant_events.*`, `transcript.*`, etc. | Set in the bot create request body. Only fires events about that specific bot's session. |
| Workspace webhooks | Bot lifecycle: `bot.joining_call`, `bot.in_call_recording`, `bot.done`, `bot.fatal`, etc. | Configured once per workspace in the Recall dashboard (Developers → Webhooks). Fires for all bots in the workspace. |

We use **both**: realtime_endpoints for chat messages, workspace webhook for lifecycle (billing + UI cleanup).

**Scheduled vs adhoc bots**: If `join_at` is >10 min in the future, Recall provisions a dedicated machine — guaranteed on-time join and no 507 errors. Otherwise the bot draws from a shared adhoc pool, which can hit 507 `adhoc_pool_depleted` under load. We enforce the 10-min guard at `src/recall/RecallBotManager.js:189-195`.

**Bot lifecycle states** (workspace webhook event name = `data.data.code`):

| Event | Description | Terminal? |
|-------|-------------|-----------|
| `bot.joining_call` | Bot acknowledged join, starting up | No |
| `bot.in_waiting_room` | Bot in Zoom waiting room, awaiting admission | No |
| `bot.in_call_not_recording` | Bot joined, recording not yet active | No |
| `bot.recording_permission_allowed` | Host approved recording | No |
| `bot.recording_permission_denied` | Host denied recording | No |
| `bot.in_call_recording` | Bot actively recording/capturing | No |
| `bot.call_ended` | Bot left the call | No |
| `bot.done` | Bot fully shut down, media uploaded | **Yes** |
| `bot.fatal` | Critical error, bot died | **Yes** |

Billing usage is measured from `joining_call` to `done`. Recall does not charge for bots that terminate in `fatal`.

**OBF (On Behalf Of) tokens**: As of February 23, 2026, Zoom requires an OBF token for any Meeting SDK app joining a meeting where the host is in an *external* Zoom account. The token proves a real authorized participant is present and the bot's session is terminated by Zoom the instant that chaperone user leaves. OBF only applies to Zoom external meetings — internal meetings and other platforms (Google Meet, Teams, etc.) are unaffected.

**Zoom webinars**: Bots join webinars as attendees by default. As an attendee the bot can capture chat but only sees a subset of participants (hosts, co-hosts, panelists — not general attendees). To request recording permissions in a webinar the bot must be pre-added as a panelist by the host before joining, which requires a signed-in Zoom bot (a real Zoom user account, not anonymous credentials). Webinar Q&A is not captured at all. The `tk` parameter in the meeting URL is required for registration-required webinars.

---

## API / SDK surface we touch

We use raw `fetch` throughout (`src/recall/RecallBotManager.js`). Auth header: `Authorization: Token {RECALL_API_KEY}`.

### Endpoints we actively call

| Endpoint | Method | Purpose | File:line |
|----------|--------|---------|-----------|
| `POST /api/v1/bot/` | POST | Create/dispatch a bot to a meeting | `RecallBotManager.js:276` |
| `/api/v1/bot/{id}/leave_call/` | POST | Tell bot to leave a meeting | `RecallBotManager.js:358` |
| `/api/v1/bot/{id}/send_chat_message/` | POST | Send outbound chat from bot | `RecallBotManager.js:640` |

### Bot create key fields (`POST /api/v1/bot/`)

```json
{
  "meeting_url": "https://zoom.us/j/{id}?pwd={passcode}",
  "bot_name": "Operator-chosen (max 100 chars)",
  "join_at": "ISO8601 — omit for adhoc, set >10min future for scheduled",
  "recording_config": {
    "start_recording_on": "call_join",
    "realtime_endpoints": [
      {
        "type": "webhook",
        "url": "https://{host}/webhook/recall/chat",
        "events": ["participant_events.chat_message"]
      }
    ]
  },
  "automatic_leave": {
    "everyone_left_timeout": 14400,
    "noone_joined_timeout": 14400,
    "waiting_room_timeout": 14400
  },
  "zoom": {
    "obf_token_url": "https://your-app.com/recall/obf-callback?..."
  }
}
```

Recall defaults for `automatic_leave` (what you get if you don't set them):
- `everyone_left_timeout`: **2 seconds** (will kill bot when a panelist steps away momentarily)
- `noone_joined_timeout`: 1200s (20 min)
- `waiting_room_timeout`: 1200s (20 min)

We override all three to 14400s (4 hours) — see `RecallBotManager.js:256-265`.

### `send_chat_message` fields

| Field | Required | Notes |
|-------|----------|-------|
| `to` | No | `"everyone"` (default) or a Zoom participant ID for DMs. Cannot target specific participants in webinars. |
| `message` | Yes | 1–4096 characters |
| `pin` | No | Boolean, default false |

We always send `{ to: "everyone", message: text }` (`RecallBotManager.js:647`).

### Events we subscribe to (realtime_endpoints)

| Event | We use it? | Notes |
|-------|-----------|-------|
| `participant_events.chat_message` | **Yes** | Core functionality — every Zoom chat message |
| `participant_events.join` | No | Available but not subscribed |
| `participant_events.leave` | No | Available but not subscribed |
| `transcript.data` | No | Transcription — possible future feature |
| `audio_mixed_raw.data` | No | Raw PCM audio — not needed |
| `video_separate_png.data` | No | Video frames — not needed |

### Workspace webhook events we handle

| Event | Handler | Purpose |
|-------|---------|---------|
| `bot.done` | `handleStatusChangeEvent()` | Close billing row, clear maps, emit `meetingDisconnected` |
| `bot.fatal` | `handleStatusChangeEvent()` | Same as done |
| All other `bot.*` | `handleStatusChangeEvent()` | Update `last_status` in DB, no map clearing |

---

## Auth & secrets

| Env var | Purpose | Where used |
|---------|---------|-----------|
| `RECALL_API_KEY` | Workspace API key — prefixed with `Token ` in every request | `RecallBotManager.js:279` |
| `RECALL_API_BASE` | Base URL for all API calls | `RecallBotManager.js:140`; default `https://us-east-1.recall.ai/api/v1` |
| `PUBLIC_WEBHOOK_URL` | Publicly-reachable HTTPS base URL for Recall to deliver webhooks | `RecallBotManager.js:230`; suffixed with `/webhook/recall/chat` |
| `RECALL_WEBHOOK_SECRET` | Svix workspace secret (`whsec_<base64>`) for verifying inbound webhook signatures | `src/routes/webhook.js:173,349` |

`RECALL_API_KEY` and `PUBLIC_WEBHOOK_URL` are the "configured" gate — `isConfigured()` returns false if either is missing, and the server falls back to mock RTMS mode (`src/server/index.js:54`).

`RECALL_WEBHOOK_SECRET` is optional but critical for security. When unset, the webhook routes accept requests without verification and log a warning on every hit (`src/routes/webhook.js:181`).

Credentials live in Railway environment variables in production. Locally, `.env` (not committed). See `.env.example` for the full set.

---

## Webhooks / events

### Two inbound webhook routes

**`POST /webhook/recall/chat`** (`src/routes/webhook.js:167`)
- Receives `participant_events.chat_message` events from `recording_config.realtime_endpoints`
- Signature verified via `verifyRecallWebhook()` (`src/recall/verifyRecallWebhook.js`)
- Fire-and-forget dispatch to `recallBotManager.handleChatEvent()`
- Always returns 200 so Recall doesn't retry on our parsing failures

**`POST /webhook/recall/status`** (`src/routes/webhook.js:341`)
- Receives workspace-level `bot.*` lifecycle events
- Same Svix signature verification
- Fire-and-forget to `recallBotManager.handleStatusChangeEvent()`
- Always returns 200

### Workspace webhook configuration (manual step)
The `/webhook/recall/status` route is implemented and ready but **requires manual setup in the Recall dashboard** to receive events. Go to: `https://us-east-1.recall.ai/dashboard/webhooks/` → add endpoint URL `{PUBLIC_WEBHOOK_URL}/webhook/recall/status`. This is a one-time workspace-level config, not per-bot. The comment at `RecallBotManager.js:236-238` flags this.

### Signature verification (`src/recall/verifyRecallWebhook.js`)

Uses Svix-style headers (workspaces created after 2025-12-15):

| Header | Value |
|--------|-------|
| `webhook-id` | Unique message ID (`msg_xxx`) |
| `webhook-timestamp` | Unix seconds |
| `webhook-signature` | Space-separated `v1,<base64sig>` entries |

Signed content: `{webhook-id}.{webhook-timestamp}.{rawBody}` (HMAC-SHA256 over the `whsec_`-stripped base64 key). Timestamp tolerance: 300s (5 minutes), hardcoded. Implementation uses `crypto.timingSafeEqual` for constant-time comparison (`verifyRecallWebhook.js:63`).

Legacy workspaces (before 2025-12-15) used `svix-id`, `svix-timestamp`, `svix-signature` headers — **our verifier only handles the new `webhook-*` form.** If we ever need to support a legacy workspace, the verifier needs updating.

### Chat event payload shape (`participant_events.chat_message`)

```json
{
  "event": "participant_events.chat_message",
  "data": {
    "data": {
      "participant": {
        "id": 12345,
        "name": "Jane Smith",
        "is_host": false,
        "platform": "zoom",
        "extra_data": {},
        "email": null
      },
      "timestamp": {
        "absolute": "2026-05-15T20:30:00Z",
        "relative": 142.5
      },
      "data": {
        "text": "Hello from chat",
        "to": "everyone"
      }
    },
    "bot": { "id": "uuid", "metadata": {} },
    "recording": { "id": "uuid", "metadata": {} },
    "realtime_endpoint": { "id": "uuid", "metadata": {} },
    "participant_events": { "id": "uuid", "metadata": {} }
  }
}
```

Our extractor (`extractChatMessage()`, `RecallBotManager.js:71-111`) targets `payload.data.data` for the primary path, with a tolerant fallback over several legacy field names in case the schema drifts.

`botId` extraction (`handleChatEvent()`, `RecallBotManager.js:437-443`) tries five candidate paths in order: `payload.bot.id`, `payload.bot_id`, `payload.data.bot.id`, `payload.data.bot_id`, `payload.data.data.bot.id`. The authoritative location per the documented schema is `payload.data.bot.id`.

### Bot status webhook payload shape

```json
{
  "event": "bot.done",
  "data": {
    "data": {
      "code": "done",
      "sub_code": null,
      "updated_at": "2026-05-15T22:45:00Z"
    },
    "bot": {
      "id": "uuid",
      "metadata": {}
    }
  }
}
```

Our handler (`handleStatusChangeEvent()`, `RecallBotManager.js:484-563`) derives `status` from the event name (`event.slice(4)` after `bot.`) and falls back to `data.data.code`. Terminal states are `done` and `fatal` only.

---

## Version-specific notes

**Pinned to API v1, region us-east-1.** The `.env.example` default is `https://us-east-1.recall.ai/api/v1`.

Available regions and base URLs:
- `https://us-east-1.recall.ai/api/v1` (our default)
- `https://us-west-2.recall.ai/api/v1`
- `https://eu-central-1.recall.ai/api/v1`
- `https://ap-northeast-1.recall.ai/api/v1`

**OBF enforcement date: February 23, 2026.** Starting that date, any Recall bot joining a Zoom meeting where the host is on an external Zoom account needs an OBF token. We do not currently implement OBF (`zoom.obf_token_url` is never set in our bot create payload). See Risks section for impact.

**Webhook signing cutover: December 15, 2025.** Workspaces created before that date use legacy Svix headers (`svix-id`, `svix-timestamp`, `svix-signature`). Our verifier only handles the post-cutover `webhook-*` form. Our workspace was created after this date, so this is fine — but document it if you ever migrate workspaces.

**`start_recording_on: "call_join"` behavior.** We set this so the bot starts capturing the moment it enters the call, not waiting for another participant. This is necessary for pre-show chat capture. The Recall default would be `participant_join` which would miss chat before the first attendee arrives.

**Webhook retry behavior.** For `realtime_endpoints`: up to 60 retries, 1-second interval. For workspace webhooks: retries up to 24 hours with exponential backoff. An endpoint is disabled after 5 consecutive days of failures spanning at least a 12-hour window.

---

## Rate limits / quotas / scaling

| Endpoint | Limit |
|----------|-------|
| `POST /api/v1/bot/` (create) | 120 req/min per workspace |
| `POST /bot/{id}/send_chat_message/` | Not documented by Recall |
| Our self-imposed send rate limiter | 20 messages/min per bot (`RecallBotManager.js:158`) |

**507 `adhoc_pool_depleted`**: Only occurs for adhoc bots (no `join_at`, or `join_at` <10 min in the future). When this error fires, our `describeRecallError()` function (`RecallBotManager.js:117-135`) does not explicitly call it out — the 507 falls through to the generic error message. Scheduled bots never hit this.

**Concurrent bots**: No documented per-workspace limit in public docs. Our system enforces a plan-based `concurrent_bot_limit` per org (enforced by `TrialEnforcer`), independent of Recall's own limits.

**`automatic_leave` 4-hour cap**: We set all timeouts to 14400s. If a production event runs longer, Recall will terminate the bot. There is no documented maximum for these timeout values; 4 hours should be safe in practice.

---

## Gotchas & failure modes

**1. In-memory maps lost on process restart.**
`botsByMeeting` and `meetingsByBot` live only in Node process memory. After a restart, inbound webhook events for bots dispatched before the restart will log "unknown bot — dropping message" and be silently discarded. Bots will keep capturing but nothing routes to any room. There is no recovery path short of disconnecting and reconnecting. See Risks below.

**2. `everyone_left_timeout: 2s` Recall default will kill production bots.**
If we ever deploy a bot without explicitly setting `automatic_leave`, a panelist briefly going off-camera will terminate the bot within 2 seconds. We always set 14400s, but this is a footgun for any code path that constructs the bot create body without inheriting our defaults.

**3. OBF not implemented — bots will fail for external-host Zoom meetings post-Feb 2026.**
As of the OBF enforcement date (Feb 23, 2026), Recall bots joining meetings hosted by external Zoom accounts will fail unless `zoom.obf_token_url` is provided. We do not set this field. The exact failure sub_code will be `zoom_obf_user_not_in_meeting` (bot.fatal). This affects all RYTE use cases where the meeting host is an external client.

**4. Webinar panelist role is not automated.**
For Zoom webinars, if the bot needs to send chat to all attendees or request recording permissions, it must be pre-added as a panelist by the host — before the bot joins. This is a manual step the host must perform. If they forget, the bot joins as an attendee and can only see/message hosts, co-hosts, and other panelists. General attendee chat IS visible to an attendee-role bot but general attendees are NOT in the participant list.

**5. `RECALL_WEBHOOK_SECRET` not set → unauthenticated endpoint.**
When the secret is absent, any party that knows our `/webhook/recall/chat` or `/webhook/recall/status` URL can inject fake messages or spoof bot termination events. Logs a warning but does not block. Set the secret in Railway env vars immediately.

**6. Workspace webhook for `/recall/status` requires manual dashboard config.**
The route handler exists but will never receive events until someone adds the endpoint in the Recall workspace dashboard. If this isn't done, `bot_usage` rows never close, duration_seconds stays NULL, and billing calculations are wrong.

**7. Shortener URL HEAD probe can burn single-use registration tokens.**
`resolveShortenedUrl()` sends a HEAD request to follow redirects. For some Zoom registration flows, the link itself (not just the final URL) may be tied to the registrant identity. A HEAD probe is less risky than a GET (no JS execution), but it's not zero risk. If a customer reports a "your link was already used" error after dispatch, this is a candidate cause.

**8. Continuous Meeting Chat (CMC) requirement for outbound chat.**
Recall's docs note that "Continuous Meeting Chat" must be enabled in the host's Zoom account settings for the bot's messages to appear in the standard chat panel. If a host has CMC disabled, `send_chat_message` calls may silently succeed (200) but attendees won't see messages. There is no feedback mechanism.

**9. `bot_name` over 100 characters will be rejected by Recall.**
The Recall API enforces a 100-character max on `bot_name`. We validate that `botName` is non-empty but do not truncate or reject long names at our layer (`RecallBotManager.js:183`). A name over 100 chars will cause a 400 from Recall with a parsing error.

**10. Svix legacy header support missing.**
Our `verifyRecallWebhook.js` only handles `webhook-id` / `webhook-timestamp` / `webhook-signature` (post-Dec 2025 scheme). It does not fall back to `svix-*` headers. If we migrate to a legacy workspace or Recall reverts the header names, verification will fail with `missing_headers`.

---

## Risks / TODOs in our current code

**`src/recall/RecallBotManager.js:139-140` — Wrong default region in constructor**
The constructor default is `https://us-east-1.recall.ai/api/v1` but `.env.example` also defaults to `us-east-1`. The comment at the top of the file says "region us-east-1." This is consistent — but the doc says we pin `us-west-2`. The actual pinned region should be confirmed and documented; if `RECALL_API_BASE` is unset in Railway, we silently use `us-east-1`. Verify this matches the actual Recall workspace region.

**`src/recall/RecallBotManager.js:239` — bot create body has no `zoom: {}` field**
We never pass `zoom.obf_token_url`. As of Feb 23, 2026, this will cause `zoom_obf_user_not_in_meeting` fatals for all external-host Zoom meetings. Implementing OBF requires: a Zoom OAuth flow for RYTE operators, an OBF callback endpoint that Recall GETs just-in-time, and per-user token storage. This is a significant engineering task and a live production blocker.

**`src/recall/RecallBotManager.js:154` — In-memory maps only, no persistence**
`botsByMeeting` and `meetingsByBot` are lost on process restart. Every webhook event for a pre-restart bot is silently dropped. The `bot_usage` table already records `recall_bot_id` — a recovery path could re-populate these maps from DB at startup. Without this, a Railway redeploy mid-show drops all inbound chat.

**`src/routes/webhook.js:167-188` — Fire-and-forget swallows `handleChatEvent` errors**
`Promise.resolve(...).catch(err => console.error(...))` means errors in `handleChatEvent` (DB failures, OrgState lookup failures) are logged but not retried. If the org state lookup fails transiently, the chat message is permanently lost. Consider a dead-letter mechanism.

**`src/recall/RecallBotManager.js:117-135` — `describeRecallError` misses 507**
The 507 `adhoc_pool_depleted` error isn't handled in `describeRecallError()`. An operator hitting 507 gets a generic "Recall API returned 507: ..." with no actionable hint. Add a case for `status === 507` pointing at the scheduled-bot path.

**`src/recall/RecallBotManager.js:183` — No `bot_name` length validation**
Recall enforces ≤100 characters. Names over 100 chars produce a 400 that surfaces to the operator as a generic error. Add a `if (cleanBotName.length > 100)` check.

**`src/routes/webhook.js:341` — `/recall/status` workspace webhook never registered**
The handler exists but the Recall workspace dashboard entry pointing at it has not been created (per code comment at `RecallBotManager.js:236-238`). Until registered: `bot_usage.left_at` and `duration_seconds` are never set by Recall events (only by operator-initiated disconnect), making billing calculations incomplete.

**`src/recall/verifyRecallWebhook.js:58-63` — `timingSafeStringEqual` pads via Buffer**
`Buffer.from(a)` and `Buffer.from(b)` use UTF-8 encoding, and the function returns `false` for different-length strings before calling `timingSafeEqual`. This is correct — an attacker cannot learn length from a short-circuit because we return false immediately for length mismatch, which is the standard approach. Not a bug, but worth documenting to avoid future "why not just `===`?" confusion.

**`src/server/index.js:49-53` — `recallBotManager` constructed without `orgState` and `db`**
Both are patched in lazily at first connect (`src/server/index.js:196-200`) and again in `start()` (`src/server/index.js:598-599`). This works but if a webhook fires before the first connect call and after startup but before `start()` completes, `orgState` could be null and chat events would be dropped. In practice `start()` completes before any webhooks arrive, but it's fragile.

---

## Key links

- [Recall.ai Docs home](https://docs.recall.ai)
- [Bot Create API reference](https://docs.recall.ai/reference/bot_create)
- [Real-Time Event Payloads](https://docs.recall.ai/docs/real-time-event-payloads)
- [Real-Time Webhook Endpoints](https://docs.recall.ai/docs/real-time-webhook-endpoints)
- [Bot Status Change Events (workspace webhooks)](https://docs.recall.ai/docs/bot-status-change-events)
- [Bot Sub-codes](https://docs.recall.ai/docs/sub-codes)
- [Webhook signature verification](https://docs.recall.ai/docs/authenticating-requests-from-recallai)
- [Zoom OBF tokens](https://docs.recall.ai/docs/zoom-obf)
- [Zoom webinars & registration-required meetings](https://docs.recall.ai/docs/zoom-webinars)
- [Zoom Signed-in Bots](https://docs.recall.ai/docs/zoom-signed-in-bots)
- [Creating and scheduling bots](https://docs.recall.ai/docs/creating-and-scheduling-bots)
- [API error codes](https://docs.recall.ai/reference/errors)
- [Automatic leaving behavior](https://docs.recall.ai/docs/automatic-leaving-behavior)
- [Sending chat messages](https://docs.recall.ai/docs/sending-chat-messages)
- [Recall.ai OBF blog post](https://www.recall.ai/blog/zoom-obf)
