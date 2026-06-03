# Zoom (REST v2 + S2S OAuth + Webhooks + RTMS)

> Zoom is used as the source of live webinar/meeting chat data, with webhook event verification for the legacy RTMS path and planned integration for bot-based chat capture (Recall.ai) for cross-org meetings. Pinned surface: REST API v2 (`https://api.zoom.us/v2/`), Server-to-Server OAuth, Event Webhooks, and @zoom/rtms (mocked, inactive).

---

## How we use it

### Active today (production)

1. **Webhook signature validation** — `src/middleware/webhookAuth.js` and `src/routes/webhook.js` both implement full HMAC-SHA256 signature verification over incoming Zoom webhook events. All non-validation-challenge events are rejected without a valid `x-zm-signature` header (`webhookAuth.js:6-58`, `webhook.js:15-42`).

2. **URL validation challenge** — `src/routes/webhook.js:47-68` handles the `endpoint.url_validation` handshake Zoom sends when you register a webhook endpoint. It hashes the `plainToken` from the payload body with `ZOOM_WEBHOOK_SECRET_TOKEN` and returns `{ plainToken, encryptedToken }`.

3. **Webhook event dispatch** — `src/routes/webhook.js:73-122` receives `meeting.rtms_started`, `meeting.rtms_stopped`, `meeting.started`, and `meeting.ended` events and dispatches them to `RTMSManager`. Today, because `RTMSManager.useMockMode = true` (`src/rtms/RTMSManager.js:13`), these webhook events trigger mock message generation instead of a real RTMS stream connection.

4. **RTMS mock mode** — `src/rtms/RTMSManager.js:25-42` skips the real `@zoom/rtms` connection entirely and spawns a `setInterval` that emits synthetic chat messages every 3–8 seconds. This is the only currently active Zoom-touching code path in production.

### Active today (credential-derived)

5. **RTMS signature generation** — `src/middleware/webhookAuth.js:64-77` and `src/rtms/RTMSManager.js:101-109` both expose `generateRTMSSignature(meetingId, timestamp)` which computes `HMAC-SHA256(ZOOM_CLIENT_SECRET, "{meetingId}:{timestamp}")`. **This format is WRONG for real RTMS** — see Risks section.

### Planned / not yet built

6. **Add-panelist flow (roadmap #1)** — the primary build target. When RYTE hosts a webinar, the plan is to use `POST /v2/webinars/{webinarId}/panelists` via S2S OAuth to register a Recall.ai bot (or our own SDK bot) as a panelist, receive back a `join_url`, and pass that to the bot for joining. No code exists yet for this.

7. **Real RTMS connection** — `src/rtms/RTMSManager.js:44-75` contains commented-out scaffolding and a `throw` guard (`line 95`) blocking the real path until `@zoom/rtms` is installed and `useMockMode` is flipped to `false`.

---

## Core concepts

### Webinar participant roles

Zoom webinars have four distinct roles, and **each role has different visibility into the chat feed**:

| Role | Can send chat | Can see all messages |
|---|---|---|
| Host | Yes | Yes — all chat (host/panelist/attendee) |
| Co-host | Yes | Yes |
| Panelist | Yes | Panelist-to-panelist + host + attendee public |
| Attendee | Yes (if enabled) | Only public messages |

A bot joining as an **attendee** only sees public attendee messages — it will miss panelist-only chat. A bot joining as a **panelist** sees all non-private messages. For full chat capture, the bot must be a panelist or co-host.

### Meeting vs Webinar model

- **Meetings**: all participants are peers. Chat is symmetric — anyone can send to everyone.
- **Webinars**: asymmetric. Panelists/host interact on-stage; attendees watch. Chat is one-directional unless the host enables "attendees can chat."

Our app targets webinars. The `POST /v2/webinars/{webinarId}/panelists` endpoint is therefore the critical path for any real bot integration.

### S2S OAuth (Server-to-Server)

No end-user authorization flow. The app authenticates as the Zoom account that owns the Marketplace App. Generates a bearer token by presenting account credentials to `POST https://zoom.us/oauth/token`. Tokens expire in 3600 seconds (exactly 1 hour). No refresh token — you must re-request.

Because a RYTE producer is always in the meeting anyway, we qualify for the OBF chaperone model if we go the Meeting SDK bot route (but see the Recall.ai preference in `docs/CHAT-CAPTURE-ARCHITECTURE.md`).

### RTMS vs Meeting SDK bot

| | RTMS | Meeting SDK bot |
|---|---|---|
| Initiated by | Zoom (host-side) | Us (participant-side) |
| Auth requirement | App installed on host's Zoom org | Meeting credentials + OBF chaperone |
| Cross-org support | No | Yes |
| Chat data available | Yes (media type 16) — but gated | Yes via `IMeetingChatController` |
| Current status in our code | Mock only | Via Recall.ai (active) |

**RTMS does support chat** (media type integer `16` in the stream type enum), but it requires Developer Pack account gating, host-org app installation, and a 30-day trial + paid subscription. RTMS is not our active chat path.

---

## API / SDK surface we touch

### REST API v2

Base URL: `https://api.zoom.us/v2/`

| Endpoint | Method | Purpose | Status in our code |
|---|---|---|---|
| `/oauth/token` | POST | Mint S2S bearer token (grant_type=account_credentials) | Not implemented yet — needed for panelist management |
| `/v2/webinars/{webinarId}/panelists` | POST | Add a panelist (name + email); returns `id` + `join_url` (after separate GET) | Not implemented yet — roadmap #1 |
| `/v2/webinars/{webinarId}/panelists` | GET | List panelists + their `join_url`s | Not implemented yet |
| `/v2/webinars/{webinarId}/panelists/{panelistId}` | DELETE | Remove a panelist | Not implemented yet |
| `/v2/users/me/meetings` | GET | Sample endpoint shown in docs | Not used |

**Add panelist request body:**
```json
{
  "panelists": [
    { "name": "Bot Display Name", "email": "bot@example.com" }
  ]
}
```

**Known issue:** The `POST /v2/webinars/{webinarId}/panelists` response returns only `{ updated_at, id }` — the `join_url` documented in the spec is not in the POST response. You must follow up with `GET /v2/webinars/{webinarId}/panelists` to retrieve `join_url` for each panelist.

**Recurring webinar note:** For a recurring webinar series, panelists added at the series level apply to all occurrences. You cannot target individual occurrences with the panelist endpoint. (The `occurrence_id` parameter exists on registrant endpoints but not panelists — this is a separate model.)

### Webhook events consumed

| Event | Handler | What we do |
|---|---|---|
| `endpoint.url_validation` | `webhook.js:47-68` | Hash `plainToken`, respond `{ plainToken, encryptedToken }` within 3s |
| `meeting.rtms_started` | `webhook.js:96-98, 127-145` | Pass `rtms_stream_url` to `RTMSManager.connect()` (currently mock) |
| `meeting.rtms_stopped` | `webhook.js:101-103, 151-157` | Disconnect + remove room |
| `meeting.started` | `webhook.js:106-109` | Log only, no action |
| `meeting.ended` | `webhook.js:111-113` | `rtmsManager.disconnect(meetingId)` |

**Payload shape for `meeting.rtms_started`** (documented structure, `payload.payload` nesting):
```json
{
  "event": "meeting.rtms_started",
  "event_ts": 1234567890000,
  "payload": {
    "account_id": "abc",
    "object": {
      "id": "meeting_id_string",
      "uuid": "base64==",
      "topic": "My Meeting",
      "rtms_stream_url": "wss://..."  // legacy field — may be payload.payload.server_urls in newer format
    },
    "payload": {
      "meeting_uuid": "base64==",
      "rtms_stream_id": "stream-id",
      "server_urls": "wss://signaling.zoom.us/...",
      "signature": "hex_string"
    }
  }
}
```

**Parsing caveat:** Multiple forum reports confirm the real RTMS connection fields (`server_urls`, `rtms_stream_id`, `signature`) live inside the **nested `payload.payload`** object, not `payload.object`. Our current `webhook.js:128-129` reads `payload.object.id` and `payload.object.rtms_stream_url` — the `rtms_stream_url` field path may be stale. When we implement real RTMS, verify the exact nesting against a live event.

### @zoom/rtms SDK (Node.js)

Minimum Node.js 22.0.0 (Node 24 LTS recommended). The SDK requires:
- `ZM_RTMS_CLIENT` (OAuth client ID)
- `ZM_RTMS_SECRET` (OAuth client secret)

Core API pattern:
```javascript
import rtms from "@zoom/rtms";
rtms.onWebhookEvent(({ event, payload }) => {
  if (event !== "meeting.rtms_started") return;
  const client = new rtms.Client();
  client.onTranscriptData((data, ts, meta) => { /* ... */ });
  client.join(payload);
});
```

Chat events are media type `16` in the RTMS stream type enum. No `onChatData()` callback is shown in the published Node.js SDK docs — the primary demonstrated callbacks are `onAudioData()` and `onTranscriptData()`. Confirm chat callback name against the actual `@zoom/rtms` package docs before building.

---

## Auth & secrets

### Environment variables

| Variable | Purpose | Where set |
|---|---|---|
| `ZOOM_CLIENT_ID` | Marketplace App client ID; also the first component in the RTMS WebSocket signature message | `.env` / Railway env |
| `ZOOM_CLIENT_SECRET` | Used for RTMS WebSocket HMAC signature generation (`webhookAuth.js:65`, `RTMSManager.js:102`) | `.env` / Railway env |
| `ZOOM_WEBHOOK_SECRET_TOKEN` | Webhook HMAC key — verifies all incoming Zoom webhooks (`webhook.js:19`, `webhookAuth.js:14`) | `.env` / Railway env |

`ZOOM_ACCOUNT_ID` is **not in `.env.example`** but will be needed for S2S OAuth token minting (`POST /oauth/token` requires `account_id` in the request body). Add it before implementing the panelist flow.

### S2S OAuth token flow

```
POST https://zoom.us/oauth/token
Authorization: Basic base64(client_id:client_secret)
Content-Type: application/x-www-form-urlencoded
Body: grant_type=account_credentials&account_id=<ZOOM_ACCOUNT_ID>

Response: { "access_token": "...", "expires_in": 3600, "token_type": "bearer" }
```

Token lifetime: **3600 seconds, no refresh token**. Production best practice (per Zoom blog): cache the token in Redis with a TTL of `expires_in - 300` (5-minute safety buffer). For our scale (handful of API calls per event), a simple in-memory cache with expiry timestamp is sufficient.

Use the token: `Authorization: Bearer <access_token>` on all REST API calls.

**Scopes required for webinar panelist management** (S2S OAuth app must have these configured in Marketplace App settings):
- `webinar:write:admin` — "View and manage all user Webinars"
- `webinar:read:admin` — needed to list panelists / retrieve join_url after add

**Important:** `webinar:write:admin` requires the Zoom user associated with the S2S app to have **Zoom Webinar add-on** enabled on their account. S2S OAuth authenticates as the account owner — if that account doesn't have the Webinar add-on, webinar endpoints return 403.

---

## Webhooks / events

### Signature verification (all non-challenge events)

Our implementation in `src/middleware/webhookAuth.js:36-46` and `src/routes/webhook.js:15-42`:

```
message = "v0:" + x-zm-request-timestamp + ":" + JSON.stringify(req.body)
expectedSig = "v0=" + HMAC-SHA256(ZOOM_WEBHOOK_SECRET_TOKEN, message).hex()
compare timingSafeEqual(x-zm-signature, expectedSig)
```

**Timestamp replay guard:** Requests where `|currentTime - requestTimestamp| > 300` seconds are rejected (`webhookAuth.js:30`, `webhook.js:27`).

**Constant-time comparison:** Both files *intend* a constant-time compare but call `crypto.timingSafeEquals()` — a typo (no such function; correct is `crypto.timingSafeEqual`, no trailing "s"). This path is the legacy Zoom-webhook/RTMS path and is currently inactive, but the bug must be fixed before that path is used. See Risks #6. (The live Recall chat path uses `verifyRecallWebhook` → `crypto.timingSafeEqual`, which is correct.)

### URL validation challenge (one-time + re-validation)

Zoom re-validates registered webhook endpoints every **72 hours**. If your endpoint is down or responds incorrectly two consecutive times, Zoom sends a warning email; four consecutive failures risks app suspension.

Our handler `webhook.js:47-68`:
1. Reads `req.body.payload.plainToken`
2. Computes `HMAC-SHA256(ZOOM_WEBHOOK_SECRET_TOKEN, plainToken).hex()`
3. Returns `{ plainToken, encryptedToken }` with HTTP 200

Must respond within **3 seconds**. No signature check required on the challenge event itself (Zoom sends it unsigned — we correctly skip validation via `webhookAuth.js:8-10` and `webhook.js:77-79`).

### Retry behavior

Zoom retries delivery on HTTP 5xx responses:
- +5 minutes
- +20 minutes after that
- +60 minutes after that

Client errors (4xx) and redirects do not retry. Always return 200/204 on accepted events even if your internal processing fails, to avoid spurious retries (we do this correctly in all webhook handlers).

### Regional API URL

Access token responses include an `api_url` field that may indicate a regional endpoint (EU, AU, CA). For most S2S apps operating in a single region, the global `https://api.zoom.us/v2/` endpoint is fine.

---

## Version-specific notes

**REST API version:** v2 (current, no known deprecation announced). Previous v1 was fully sunset.

**JWT app type deprecated:** Zoom deprecated the JWT app type (separate from S2S OAuth) in June 2023. Our app uses S2S OAuth — this is the current recommended approach and is not deprecated.

**RTMS @zoom/rtms package (Node.js):** Published on npm. Requires Node.js 22+. Platforms: `darwin-arm64`, `linux-x64`. No `linux-arm64` (relevant if deploying on AWS Graviton/ARM Railway instances).

**OBF enforcement (Meeting SDK):** As of March 2, 2026, Meeting SDK apps joining meetings outside their own Zoom account **must** use an OBF token. Apps on SDK < 5.17.5 that attempt anonymous join on external meetings will be refused. If we ever build our own Meeting SDK bot (Path B in `CHAT-CAPTURE-ARCHITECTURE.md`), OBF is mandatory.

**RTMS 30-day trial + Developer Pack:** RTMS now has a free 30-day trial (form at `https://www.zoom.com/en/realtime-media-streams/`), after which it requires a paid Developer Pack contract. During the trial, RTMS webhook fields (`server_urls`, `rtms_stream_id`) may stop being delivered once the trial expires — this is the root cause of the forum issue where `meeting.rtms_started` was missing connection fields.

---

## Rate limits / quotas / scaling

Zoom rate limits are per-account and per-plan tier. All endpoints are classified Light / Medium / Heavy / Resource-intensive:

| Category | Free QPS | Pro QPS | Business+ QPS | Daily cap (approximate) |
|---|---|---|---|---|
| Light | 4/s | 30/s | 80/s | 6,000 (Free) / uncapped (Pro+) |
| Medium | 2/s | 20/s | 60/s | 2,000 (Free) |
| Heavy | 1/s | 10/s | 40/s | 1,000 (Free) |
| Resource-intensive | 10/min | 10/min | 20/min | 30,000 (Free) / 60,000 (Biz) |

On a 429 response, check `X-RateLimit-Category`, `X-RateLimit-Type` (Daily-limit or per-second), `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `Retry-After` headers.

**Webinar registrant add endpoints** are documented to have very low daily limits on some plans (as low as 3/day seen in dev forum posts for certain registrant endpoints). The panelist add endpoint has not shown this specific limit but be aware that per-minute rate limits on webinar management APIs are stricter than on meeting APIs.

**For RYTE's expected scale** (handful of panelist adds per event, ~5 concurrent rooms): rate limits are not a concern. No token pool needed.

---

## Gotchas & failure modes

1. **`POST /v2/webinars/{webinarId}/panelists` does not return `join_url` in its response.** The Zoom API spec documents it as being in the response body, but the actual API returns only `{ updated_at, id }`. You must call `GET /v2/webinars/{webinarId}/panelists` after adding to retrieve the `join_url`. This is a documented spec mismatch, not a transient bug. ([devforum thread](https://devforum.zoom.us/t/adding-webinar-panelists-does-not-return-join-url-via-api/2754))

2. **Adding a panelist whose email is already a registered Zoom account may fail silently.** The API returns success but the panelist is not added when the email matches an existing Zoom account in some configurations. Unknown/unregistered emails succeed. ([devforum thread](https://devforum.zoom.us/t/unable-to-add-panelist-via-api/106549)) — verify with a live test when implementing.

3. **RTMS webhook fields live in `payload.payload`, not `payload.object`.** The actual RTMS connection fields (`server_urls`, `rtms_stream_id`, `signature`) are nested one level deeper than our current `webhook.js` code reads. Our code currently reads `payload.object.rtms_stream_url` — this is the legacy field name and may not match the current payload structure. Always parse with `payload.payload.server_urls` for real RTMS connections.

4. **RTMS trial expiry silently breaks webhook delivery.** When the RTMS Developer Pack trial expires, Zoom stops including the connection fields in `meeting.rtms_started`. The event still fires but the WebSocket URL fields are absent. This can be misdiagnosed as a parsing bug. ([devforum thread](https://devforum.zoom.us/t/meeting-rtms-started-webhook-missing-websocket-url-stream-id/141905))

5. **Webhook URL re-validation every 72 hours.** If your server is down when Zoom re-validates, two consecutive failures will generate a warning email; four will risk app suspension. On Railway, ensure health checks keep the server alive and the `/webhook/zoom` route responds within 3 seconds.

6. **S2S OAuth tokens expire in exactly 3600 seconds with no refresh mechanism.** Any code that fetches a token at startup and holds it indefinitely will fail ~1 hour in. Implement a cache with a 5-minute pre-expiry buffer (`expires_in - 300`).

7. **Multiple S2S tokens are valid simultaneously.** Generating a new token does not invalidate existing ones. This means you can safely generate a new token ahead of expiry without a race condition, but old tokens will still work for their remaining lifetime.

8. **RTMS is audio/video/transcript, plus chat (media type 16) — but chat is commonly omitted from examples.** Official Zoom blog posts and the `@zoom/rtms` SDK README emphasize transcript/audio use cases. The chat stream callback name is not prominently documented for the Node.js SDK. Confirm `onChatData` or equivalent callback name before building.

9. **@zoom/rtms requires Node.js 22+ and only supports `linux-x64` and `darwin-arm64`.** Railway instances running on ARM architecture (linux-arm64) will not run the package. If switching from Recall.ai to RTMS, verify Railway's instance type.

10. **Webinar Zoom add-on is required for all webinar API endpoints.** If the S2S OAuth app's Zoom account doesn't have the Webinar add-on, all `/v2/webinars/` calls return 403. This includes listing, managing panelists, and everything else.

---

## Risks / TODOs in our current code

1. **Wrong RTMS signature format** — `src/rtms/RTMSManager.js:101-109` and `src/middleware/webhookAuth.js:64-77` compute `HMAC-SHA256(ZOOM_CLIENT_SECRET, "{meetingId}:{timestamp}")`. The actual RTMS WebSocket handshake signature format is `HMAC-SHA256(client_secret, "{client_id},{meeting_uuid},{rtms_stream_id}")` — three comma-separated components, not two colon-separated. If real RTMS is ever enabled, both of these functions will produce invalid signatures. Fix before flipping `useMockMode = false`.

2. **`webhook.js` reads wrong payload field** — `src/routes/webhook.js:128-129` reads `payload.object.rtms_stream_url` from the `meeting.rtms_started` event. Current RTMS SDK docs show the connection fields are in the nested `payload.payload` object (`server_urls`, `rtms_stream_id`, `signature`). The `rtms_stream_url` field name is legacy. If RTMS is ever activated, this field extraction will return `undefined` and the `RTMSManager.connect()` call will receive a null stream URL.

3. **`ZOOM_ACCOUNT_ID` missing from `.env.example`** — `.env.example` includes `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`, and `ZOOM_WEBHOOK_SECRET_TOKEN` but not `ZOOM_ACCOUNT_ID`. S2S OAuth token minting requires `account_id` in the POST body. Add `ZOOM_ACCOUNT_ID=` to `.env.example` before implementing the panelist flow.

4. **No S2S token minting / caching implemented** — there is no `ZoomApiClient` or equivalent service for making authenticated REST API calls. When panelist management is added, this will need to be built from scratch. Recommend a class with an internal cache that pre-fetches a new token 5 minutes before expiry.

5. **`RTMSManager` in `webhook.js` is module-level mutable state** — `src/routes/webhook.js:10` declares `let rtmsManager = null` at module scope and lazily initializes it from `req.app.get('messageAggregator')` on first webhook call. Meanwhile, `src/server/index.js:48` also instantiates `new RTMSManager()` (without a `messageAggregator` argument) and registers it on `app.set('rtmsManager', ...)`. These are two separate instances, and the one created in `webhook.js` will fail with a null `messageAggregator` reference if any real message processing is attempted. Either pass `messageAggregator` at construction time in `index.js` or have the route use `req.app.get('rtmsManager')` consistently.

6. **`crypto.timingSafeEquals` typo risk** — `src/middleware/webhookAuth.js:44` uses `crypto.timingSafeEquals` (should be `crypto.timingSafeEqual` — no 's'). In Node.js this will throw `TypeError: crypto.timingSafeEquals is not a function` at runtime on the first non-challenge webhook. The `try/catch` at line 43-56 will catch this and return 401 rather than crashing, but this means **all signature validations will fail silently** when the `validateZoomWebhook` middleware is actually used. The function in `webhook.js:38` correctly uses `crypto.timingSafeEquals` (same typo) — check the actual Node.js crypto API (`timingSafeEqual`, no 's') and fix both locations.

7. **Duplicate signature validation logic** — webhook signature verification is implemented twice: once in `src/middleware/webhookAuth.js:6-59` (intended as Express middleware) and again inline in `src/routes/webhook.js:15-42`. The middleware version has the typo bug above. The route uses its own inline copy. The middleware exported from `webhookAuth.js` is never actually `app.use()`'d in `index.js` — only `webhookRoutes` is mounted. The unused middleware (`validateZoomWebhook`) is dead code but could mislead a developer into thinking it's active.

---

## Key links

- Zoom REST API overview: https://developers.zoom.us/docs/api/
- Using Zoom APIs (base URL, errors, pagination): https://developers.zoom.us/docs/api/using-zoom-apis/
- API rate limits: https://developers.zoom.us/docs/api/rate-limits/
- Server-to-Server OAuth: https://developers.zoom.us/docs/internal-apps/s2s-oauth/
- S2S token management (caching guide): https://developers.zoom.us/blog/s2s-token-management/
- Webhooks (signature verification, retry, URL validation): https://developers.zoom.us/docs/api/webhooks/
- Webinar API reference (panelists, registrants): https://developers.zoom.us/docs/api/rest/reference/zoom-api/methods/
- RTMS overview: https://developers.zoom.us/docs/rtms/
- RTMS WebSocket connection walkthrough: https://developers.zoom.us/blog/realtime-mediastreams-websockets/
- @zoom/rtms Node.js SDK docs: https://zoom.github.io/rtms/js/
- @zoom/rtms on npm: https://www.npmjs.com/package/@zoom/rtms
- Meeting SDK auth / OBF: https://developers.zoom.us/docs/meeting-sdk/auth/
- OBF FAQ: https://developers.zoom.us/docs/meeting-sdk/obf-faq/
- Add panelist `join_url` missing (known issue): https://devforum.zoom.us/t/adding-webinar-panelists-does-not-return-join-url-via-api/2754
- RTMS `meeting.rtms_started` missing fields (trial expiry): https://devforum.zoom.us/t/meeting-rtms-started-webhook-missing-websocket-url-stream-id/141905
- Internal architecture decision (RTMS vs SDK bot): `docs/CHAT-CAPTURE-ARCHITECTURE.md`
- RTMS approach abandoned rationale: `docs/RTMS-INTEGRATION.md`
