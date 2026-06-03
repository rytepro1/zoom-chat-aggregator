# Express

> HTTP server framework powering all REST API routes and static file serving for the Chat Aggregator backend. Pinned at `^4.21` (`package.json`).

---

## How we use it

### App creation and server wrapping

`src/server/index.js:29-31` creates the Express app, then wraps it in a plain `http.Server` so Socket.io can share the same port:

```js
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { ... });
```

Express never calls `app.listen()` directly — `httpServer.listen(PORT)` is called inside the async `start()` function at line 611 once the DB is initialized.

### app.set() as a service locator

Singletons are stored on the app instance via `app.set()` (`index.js:64-70`) and retrieved in route handlers via `req.app.get()`. This is our primary dependency-injection pattern — no DI container, no globals:

| Key | Value |
|---|---|
| `rosterManager` | `RosterManager` instance |
| `rtmsManager` | `RTMSManager` instance |
| `recallBotManager` | `RecallBotManager` instance |
| `orgState` | `OrgState` instance |
| `trialEnforcer` | `TrialEnforcer` instance |
| `stripeService` | `StripeService` instance |
| `io` | Socket.io `Server` instance |
| `db` | `pg.Pool` set at startup after DB init |

### Middleware stack (in registration order)

```
1. cors()                          index.js:73   — sets CORS headers on every response
2. cookieParser()                  index.js:79   — populates req.cookies
3. express.json({ verify })        index.js:80   — parses JSON + captures rawBody
4. express.urlencoded({ extended }) index.js:83  — parses form bodies
5. request logger (custom)         index.js:85   — console.log every request
6. attachUser(db) (soft auth)      index.js:91   — populates req.user / req.org from session cookie
```

After middleware, public routes are registered, then `app.use('/api', requireAuth)` at `index.js:141` gates everything below it.

### Raw body capture for webhook signature verification

`express.json()` is called with a `verify` callback (`index.js:81`) that stashes the raw `Buffer` on `req.rawBody` before JSON parsing:

```js
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
```

Both the Recall webhook (`webhook.js:175`) and the Stripe webhook (`webhook.js:223`) consume `req.rawBody` for HMAC/Svix signature verification. This is the **only** correct approach — once `JSON.parse` runs, byte-exact verification is impossible.

### Route table

| Method | Path | Auth | Handler location |
|--------|------|------|-----------------|
| GET | `/health` | none | `index.js:99` |
| GET | `/api/status` | none | `index.js:103` |
| POST | `/webhook/zoom` | HMAC (`ZOOM_WEBHOOK_SECRET_TOKEN`) | `webhook.js:73` |
| POST | `/webhook/recall/chat` | Svix HMAC (`RECALL_WEBHOOK_SECRET`) | `webhook.js:167` |
| POST | `/webhook/recall/status` | Svix HMAC (`RECALL_WEBHOOK_SECRET`) | `webhook.js:341` |
| POST | `/webhook/stripe` | Stripe sig (`STRIPE_WEBHOOK_SECRET`) | `webhook.js:213` |
| POST | `/api/auth/signup` | none | `routes/auth.js:29` |
| POST | `/api/auth/login` | none | `routes/auth.js:103` |
| POST | `/api/auth/logout` | none | `routes/auth.js:137` |
| GET | `/api/auth/me` | none (returns null if unauthed) | `routes/auth.js:147` |
| POST | `/api/auth/verify-email` | none | `routes/auth.js:153` |
| POST | `/api/auth/resend-verification` | session required | `routes/auth.js:163` |
| POST | `/api/auth/password-reset/request` | none | `routes/auth.js:173` |
| POST | `/api/auth/password-reset/confirm` | none | `routes/auth.js:189` |
| GET/POST | `/api/billing/*` | `requireAuth` | `routes/billing.js` |
| GET/POST | `/api/invitations/*` | mixed (per-route) | `routes/invitations.js` |
| GET | `/api/meetings` | `requireAuth` | `index.js:154` |
| POST | `/api/meetings/connect` | `requireAuth` | `index.js:171` |
| POST | `/api/meetings/:id/disconnect` | `requireAuth` | `index.js:232` |
| GET | `/api/sessions/current` | `requireAuth` | `index.js:252` |
| PATCH | `/api/sessions/current` | `requireAuth` | `index.js:257` |
| GET | `/api/sessions` | `requireAuth` | `index.js:272` |
| POST | `/api/sessions/end` | `requireAuth` | `index.js:283` |
| POST | `/api/messages/:id/save` | `requireAuth` | `index.js:297` |
| DELETE | `/api/messages/:id/save` | `requireAuth` | `index.js:311` |
| GET | `/api/saved` | `requireAuth` | `index.js:324` |
| GET | `/api/saved/export.csv` | `requireAuth` | `index.js:336` |
| POST | `/api/meetings/:meetingId/reply` | `requireAuth` | `index.js:364` |
| POST | `/api/broadcast` | `requireAuth` | `index.js:397` |
| GET/POST/PATCH/DELETE | `/api/rosters/*` | `requireAuth` | `index.js:434–581` |
| POST | `/api/rosters/:id/deploy` | `requireAuth` | `index.js:502` |
| GET | `/api/presenter-notes/*` | `requireAuth` | `routes/presenterNotes.js` |
| GET | `*` (production only) | none | `index.js:587` — SPA fallback |

The `requireAuth` gate at `app.use('/api', requireAuth)` (`index.js:141`) means routes registered **before** that line but under `/api/` (billing, invitations) are also gated — the billing router at `index.js:128` is mounted before the gate, but every billing endpoint internally requires auth anyway.

**Critical ordering note**: `/api/invitations` is mounted at `index.js:133` — before the `requireAuth` gate at line 141 — specifically so that `/api/invitations/accept/:token` and `POST /api/invitations/accept` remain public. Per-route `requireAdmin` guards are applied inside `invitationsRouter()` for admin operations.

### Static file serving

In production only (`NODE_ENV=production`), `express.static` serves the Vite build from `client/dist/` and a catch-all `app.get('*')` sends `index.html` for client-side routing (`index.js:585-590`). In development Vite runs on its own port (5173) and Express never touches static files.

---

## Core concepts

**Middleware is ordered, synchronous registration.** `app.use()` registers middleware in the order it is called; each handler is invoked in that order per request. A handler that doesn't call `next()` or send a response will hang the request — no timeout by default.

**`app.use(path, ...)` is prefix matching, not exact matching.** `app.use('/api', requireAuth)` fires for `/api/`, `/api/meetings`, `/api/anything`. `app.get('/api/status', ...)` is exact.

**Error-handling middleware requires exactly 4 args.** The signature `(err, req, res, next)` tells Express to treat it as an error handler. We have no global error handler registered — unhandled async throws in route handlers will currently crash silently or leave requests hanging (see Risks below).

**Express 4 does not catch async rejections.** Every `async` route handler wraps its body in `try/catch` manually (`index.js:193-229`, `index.js:235-248`, etc.). This is the correct Express 4 pattern. Express 5 auto-catches rejected promises, but we are not on Express 5.

**`req.user` / `req.org` are custom — not Express builtins.** They are attached by our `attachUser` middleware (`auth/middleware.js:8-24`) after reading `req.cookies.zoomchat_session`, validating it against `auth_sessions`, and joining `users + organizations`. They are `undefined` on unauthenticated requests. `requireAuth` checks `req.user` and returns 401 if absent.

**`app.set()` / `app.get()` for settings vs service locator.** Express uses `app.set()` for its own settings (e.g., `trust proxy`, `view engine`) and we re-use the same API to store service singletons. This is a well-known Express pattern, not a hack.

---

## API / SDK surface we touch

### Methods used

| Method | Where | Purpose |
|--------|-------|---------|
| `express()` | `index.js:29` | App factory |
| `app.set(key, val)` | `index.js:64-70` | Service locator storage |
| `app.get(key)` | route handlers via `req.app.get(key)` | Service locator retrieval |
| `app.use(path?, mw)` | `index.js:73-141` | Middleware + router mounting |
| `app.get(path, handler)` | `index.js:99,103,154,…` | GET routes |
| `app.post(path, handler)` | `index.js:171,232,…` | POST routes |
| `app.patch(path, handler)` | `index.js:257,471,…` | PATCH routes |
| `app.delete(path, handler)` | `index.js:311,488,…` | DELETE routes |
| `express.json({ verify })` | `index.js:80` | Body parsing + rawBody capture |
| `express.urlencoded({ extended: true })` | `index.js:83` | Form body parsing |
| `express.static(root)` | `index.js:586` | SPA static assets (prod) |
| `express.Router()` | `routes/auth.js:2`, `routes/webhook.js:7` | Modular router instances |
| `res.json(obj)` | everywhere | JSON responses |
| `res.status(n).json(obj)` | everywhere | Statusful JSON responses |
| `res.setHeader(name, val)` | `index.js:348-349` | CSV download headers |
| `res.send(body)` | `index.js:349` | CSV body send |
| `res.sendFile(path)` | `index.js:588` | SPA index.html fallback |
| `res.cookie(name, val, opts)` | `auth/sessions.js:105` | Session cookie set |
| `res.clearCookie(name, opts)` | `auth/sessions.js:115` | Session cookie clear |
| `req.body` | route handlers | Parsed JSON payload |
| `req.rawBody` | `webhook.js:175,223` | Raw buffer for signature verification |
| `req.cookies` | `auth/sessions.js:119` | Session cookie read |
| `req.params` | route handlers | URL path params |
| `req.query` | `index.js:325,337` | Query string params |
| `req.headers` | `webhook.js:21,172` | Webhook signature headers |
| `req.app.get(key)` | `routes/auth.js`, `routes/webhook.js` | Service locator retrieval inside routers |

### Methods NOT used (notable absences)

- **`app.engine()` / `res.render()`** — no template engine; all responses are JSON or static files
- **`express-session`** — we implement our own DB-backed session layer (`auth/sessions.js`)
- **`helmet`** — not installed; security headers are not set (see Risks)
- **`app.listen()`** — we use `httpServer.listen()` directly for Socket.io co-hosting

---

## Auth & secrets

### Session cookie

| Attribute | Value |
|-----------|-------|
| Name | `zoomchat_session` (`auth/sessions.js:13`) |
| Value | 64-char hex (32 random bytes) |
| `httpOnly` | `true` — JS cannot read it |
| `secure` | `true` in production, `false` in dev (`auth/sessions.js:107`) |
| `sameSite` | `lax` |
| `expires` | 30 days sliding, reset when more than half used |
| `path` | `/` |

The cookie is parsed by `cookie-parser` before our `attachUser` middleware runs. Session rows live in the `auth_sessions` Postgres table. No JWT is involved.

### Env vars consumed by Express-layer code

| Variable | Used in | Purpose |
|----------|---------|---------|
| `NODE_ENV` | `index.js:34,74,107,585` | CORS origins, cookie `secure` flag, static serving |
| `PORT` | `index.js:592` | Listening port (default `3001`) |
| `DATABASE_URL` | `index.js:595` | Postgres DSN for session + data store |
| `ZOOM_WEBHOOK_SECRET_TOKEN` | `webhookAuth.js:14`, `webhook.js:18` | HMAC key for Zoom webhook signature |
| `ZOOM_CLIENT_SECRET` | `webhookAuth.js:65` | RTMS HMAC signature generation |
| `RECALL_WEBHOOK_SECRET` | `webhook.js:173,347` | Svix HMAC key for Recall webhooks |
| `RECALL_API_KEY` | `index.js:51` | Recall.ai API auth |
| `RECALL_API_BASE` | `index.js:52` | Recall.ai base URL |
| `PUBLIC_WEBHOOK_URL` | `index.js:53` | Recall callback URL |
| `STRIPE_SECRET_KEY` | `index.js:60` | Stripe API client |
| `STRIPE_WEBHOOK_SECRET` | `index.js:61` | Stripe webhook signature verification |

---

## Webhooks / events

We handle three webhook sources, all mounted under `/webhook/*` (`index.js:121`) before the `requireAuth` gate:

### Zoom (`POST /webhook/zoom`)

Signature: `x-zm-signature` (format `v0=<hex>`) + `x-zm-request-timestamp` (Unix seconds). Verified by hashing `v0:${timestamp}:${JSON.stringify(req.body)}` with `ZOOM_WEBHOOK_SECRET_TOKEN`.

Timestamp replay window: **5 minutes** (`webhook.js:26`).

URL validation challenge (`event === 'endpoint.url_validation'`) bypasses signature check and responds with `{ plainToken, encryptedToken }` (`webhook.js:47-68`).

Events handled: `meeting.rtms_started`, `meeting.rtms_stopped`, `meeting.started`, `meeting.ended`.

**Note**: `validateZoomWebhook` in `src/middleware/webhookAuth.js` is **not used** — the route itself re-implements the same logic inline (`webhook.js:15-42`). The `webhookAuth.js` file is dead code (see Risks).

### Recall.ai (`POST /webhook/recall/chat`, `POST /webhook/recall/status`)

Svix-style signature. `verifyRecallWebhook` (`recall/verifyRecallWebhook.js`) is called when `RECALL_WEBHOOK_SECRET` is set; without it, the webhook is accepted with a warning (`webhook.js:181`).

`req.rawBody` (Buffer, not string) must be passed to the verifier — Svix requires the exact bytes.

Response is always `200 { received: true }` on accepted requests. Handler is fire-and-forget (`webhook.js:186-188`, `webhook.js:361-362`) — we don't wait for DB writes before responding to prevent Recall retries on our internal errors.

### Stripe (`POST /webhook/stripe`)

Uses `stripe.verifyWebhook(req.rawBody, req.headers['stripe-signature'])` which is the official Stripe SDK method. Returns 400 on signature failure (correct — Stripe surfaces this in their dashboard); returns 200 even on handler errors (correct — prevents unwanted retries).

Events handled: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`.

---

## Version-specific notes

**Our pin: `^4.21` = Express 4.21.x (currently 4.21.2).**

### Express 4.21.x changes

- **4.21.0 (Sep 2024)**: Deprecated `res.redirect('back')` magic string. We do not use this pattern, so no action needed. Also bumped `qs` to 6.13.0 and `serve-static` to 1.16.2.
- **4.21.2 (Dec 2024)**: Security patch — bumped `path-to-regexp` from `0.1.10` to `0.1.12` to fix **CVE-2024-52798** (ReDoS via backtracking regex). This was the second fix after CVE-2024-45296 was incompletely patched in 4.21.1. Ensure `package-lock.json` resolves `path-to-regexp` to `0.1.12` or later.

### Express 4.20.x changes

- **4.20.0 (Sep 2024)**: `urlencoded` depth default changed from `Infinity` to `32`. We use `extended: true` but do not pass `depth`, so we now silently cap nested objects at 32 levels. Irrelevant for our flat JSON payloads, but worth knowing.
- **4.20.0**: `res.redirect()` HTML body no longer renders links — prevents HTML injection in redirect responses.
- **4.20.0**: `path-to-regexp` bumped to `0.1.8` / `0.1.10` for CVE-2024-45296 (initial ReDoS fix — later found incomplete).

### Express 4 vs 5 differences to track

Express 5 was released in 2024. Key differences relevant to our codebase if we ever migrate:

| Change | Our code impact |
|--------|----------------|
| Async errors auto-caught in handlers | Remove all `try/catch` wrappers in `index.js` routes |
| `res.redirect('back')` removed | No impact — we don't use it |
| `req.body` defaults to `undefined` (not `{}`) | Low risk — we guard with `req.body?.field` |
| `req.query` read-only | Low risk — we only read it |
| `res.status()` rejects non-integer codes | Low risk |
| `express.urlencoded` default `extended: false` | Would need `extended: true` explicitly (already set) |
| Route path wildcard `/*` must become `/*splat` | Affects `app.get('*', ...)` catch-all at `index.js:587` |
| `app.listen()` errors passed to callback | Our code uses `httpServer.listen()` directly — not affected |

---

## Rate limits / quotas / scaling

Express itself has no built-in rate limiting. We have no rate-limiting middleware installed. Notable implications:

- **Auth endpoints** (`/api/auth/login`, `/api/auth/signup`) have no brute-force protection.
- **Webhook endpoints** are not rate-limited beyond the per-service HMAC gate.
- **`POST /api/meetings/:meetingId/reply`** does manual regex-based detection of `rate limit` in upstream errors (`index.js:389`) and returns 429, but this is a pass-through from Recall.ai's own limits, not enforced by Express.

In production (Railway), traffic passes through Railway's load balancer. If we add horizontal scaling, note that our `OrgState` / `RosterManager` / `RecallBotManager` are all in-process singletons — Socket.io rooms and bot state will not be shared across instances without a Redis adapter.

Body size: `express.json()` defaults to **100 KB** max payload. Webhook bodies are small; chat history exports are streamed differently. This limit has not been tuned.

---

## Gotchas & failure modes

**1. Middleware order determines whether requireAuth fires.**
Routes mounted with `app.use('/api/...')` before `app.use('/api', requireAuth)` at `index.js:141` bypass the global gate. Right now billing (`index.js:128`) and invitations (`index.js:133`) are mounted before the gate. The billing router applies per-route auth, and the invitations router is intentionally partially public. Any future route mounted before line 141 must explicitly guard itself.

**2. No global error handler.**
We have no `app.use((err, req, res, next) => { ... })` registered. Express's default error handler will send an HTML stack trace (`500 Internal Server Error`) if an unhandled error object reaches it. This leaks stack traces in production and returns HTML instead of JSON to API clients. All our routes use `try/catch`, but an uncaught error in a synchronous middleware or missing `await` will hit this.

**3. rawBody must be captured before any other body parser.**
The `express.json({ verify })` middleware captures `req.rawBody` on parse. If any middleware running before it consumes the stream or re-parses the body, `req.rawBody` will be wrong or missing. Currently safe, but adding a middleware before `express.json()` (e.g., a compression library that decompresses before parse) could silently break webhook signature verification.

**4. `RECALL_WEBHOOK_SECRET` is optional by design but dangerous when absent.**
`webhook.js:181` accepts all Recall webhook traffic without verification if the secret is not set, logging only a warning. In a production deployment without the env var, any HTTP client can forge Recall events and inject chat messages or trigger bot state changes.

**5. Zoom signature verification is duplicated.**
`src/middleware/webhookAuth.js` and the inline `validateWebhookSignature` in `webhook.js:15-42` implement the same logic. Only the inline version is actually called. The `webhookAuth.js` `validateZoomWebhook` function is never imported or used.

**6. URL validation challenge skips signature check by body inspection.**
Both `webhookAuth.js:8-10` and `webhook.js:77` check `req.body.event === 'endpoint.url_validation'` before signature verification. This is correct per Zoom's protocol — Zoom sends the challenge before you've configured the secret — but it means any unauthenticated caller can trigger the challenge handler. The response (HMAC of `plainToken`) is safe to expose.

**7. No `X-Powered-By` suppression.**
Express adds `X-Powered-By: Express` to every response by default. We never call `app.disable('x-powered-by')`. This fingerprints our stack to passive scanners.

**8. No `helmet`.**
Security headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy) are absent. In production this means browsers trust inline scripts, permit iframing, and don't enforce HSTS.

**9. CORS `origin: true` in production reflects the request origin.**
`index.js:74-76`: `origin: true` in production means Express echoes back whatever `Origin` header the client sends, effectively allowing all origins with `credentials: true`. This is intentional for a hosted SaaS where the client origin varies, but it disables the same-origin protection that CORS is designed to provide.

**10. SPA catch-all catches unmatched API routes.**
`app.get('*', ...)` at `index.js:587` is only registered in production, but it means a typo like `GET /api/meeting` (missing 's') returns `index.html` with a 200 instead of a 404 JSON. API clients should not rely on 404s for unknown routes in production.

---

## Risks / TODOs in our current code

| Risk | File:line | Severity | Fix |
|------|-----------|----------|-----|
| No global error handler — stack traces leak in prod | `index.js` (none registered) | High | Add `app.use((err, req, res, next) => { res.status(500).json({ error: 'Internal error' }) })` after all routes |
| No `helmet` — missing security headers | `index.js` (not installed) | High | `npm install helmet`, `app.use(helmet())` before CORS |
| `X-Powered-By: Express` not suppressed | `index.js:29` | Medium | `app.disable('x-powered-by')` after `express()` |
| `RECALL_WEBHOOK_SECRET` optional — forgeable events | `webhook.js:173,181` | High | Make it required in prod; fail-fast on missing secret |
| Dead code: `validateZoomWebhook` never imported | `src/middleware/webhookAuth.js` | Low | Delete file or consolidate with `webhook.js` |
| CORS `origin: true` in production (reflects all origins) | `index.js:75` | Medium | Lock to specific domains once client domain is stable |
| No rate limiting on auth endpoints | `routes/auth.js` | High | Add `express-rate-limit` to `/api/auth/login` and `/api/auth/signup` |
| `express.json()` body size limit not tuned | `index.js:80` | Low | Add `limit: '1mb'` (or tighten to `'100kb'`) explicitly |
| No request ID / correlation ID — hard to trace errors | `index.js:85-88` | Medium | Add `crypto.randomUUID()` to logger + set on `req` |
| SPA catch-all returns 200 `index.html` for bad API paths (prod) | `index.js:587-589` | Low | Mount catch-all only for non-`/api` paths |
| `app.get('*')` wildcard will need `'/*splat'` syntax on Express 5 | `index.js:587` | Low (future) | Note for any Express 5 migration |
| Webhook Zoom handler accesses `req.app.get('messageAggregator')` which is never set | `webhook.js:88` | Medium | The RTMS path is legacy/unused but will silently NOP; clean up if RTMS is fully retired |

---

## Key links

- Express 4.x API reference: https://expressjs.com/en/4x/api.html
- Using middleware guide: https://expressjs.com/en/guide/using-middleware.html
- Security best practices: https://expressjs.com/en/advanced/best-practice-security.html
- Express 5 migration guide: https://expressjs.com/en/guide/migrating-5.html
- Express 4.21.0 release: https://github.com/expressjs/express/releases/tag/4.21.0
- Express 4.21.2 release (path-to-regexp CVE-2024-52798): https://github.com/expressjs/express/releases/tag/4.21.2
- Express 4.20.0 release (ReDoS initial fix, urlencoded depth change): https://github.com/expressjs/express/releases/tag/4.20.0
- CVE-2024-52798 (path-to-regexp ReDoS): https://github.com/advisories/GHSA-rhx6-c78j-4q9w
- Express September 2024 security release: https://expressjs.com/en/blog/2024-09-29-security-releases
