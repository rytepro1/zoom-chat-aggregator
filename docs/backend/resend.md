# Resend

> Transactional email delivery for auth flows (signup verification, password reset, team invitations) — Node SDK `resend ^6.12.4`.

---

## How we use it

All email logic lives in a single module: `src/auth/email.js`. There are no other integration points.

### Initialization (`src/auth/email.js:13`)

```js
const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;
```

The SDK client is only constructed when `RESEND_API_KEY` is present. When the variable is absent, every send call falls through to a console-log fallback (`email.js:18-26`). This is intentional: local dev and CI can exercise the full auth flow without Resend credentials.

### Sender address (`src/auth/email.js:14`)

```js
const FROM = process.env.EMAIL_FROM || 'noreply@zoomchat.ryteproductions.com';
```

The default hardcodes a subdomain of `ryteproductions.com`. That domain must be verified in the Resend dashboard before any email is delivered.

### App URL (`src/auth/email.js:15`)

```js
const APP_URL = (process.env.APP_URL || 'http://localhost:5173').replace(/\/$/, '');
```

Used to build tokenized deep-links embedded in every email template.

### Shared send wrapper (`src/auth/email.js:17-32`)

```js
async function send({ to, subject, html, text }) {
  if (!resend) { /* console-log fallback */ return; }
  try {
    await resend.emails.send({ from: FROM, to, subject, html, text });
  } catch (err) {
    console.error(`[email] failed to send "${subject}" to ${to}:`, err.message);
  }
}
```

Key behaviours:
- Never throws. Email failures are swallowed and logged. Callers are not notified of delivery failure.
- Sends `html` + `text` together when both are provided (Resend uses both; clients choose).
- Does **not** inspect the `{ data, error }` response shape — it uses a bare `try/catch`.

### Email types sent

| Function | Template | Token TTL | Trigger |
|---|---|---|---|
| `sendVerificationEmail` | "Verify your ZoomChat account" | 24 h | POST `/api/auth/signup` (email.js:38) |
| `sendVerificationEmail` | same | 24 h | POST `/api/auth/resend-verification` (email.js:169) |
| `sendPasswordResetEmail` | "Reset your ZoomChat password" | 24 h | POST `/api/auth/password-reset/request` (email.js:54) |
| `sendInvitationEmail` | "You've been invited to {org}" | 7 days | POST `/api/invitations` (email.js:70) |

All three callers fire-and-forget: `sendVerificationEmail({ to, token })` with no `await` in auth.js lines 85, 169, and `sendPasswordResetEmail` at auth.js line 184. `sendInvitationEmail` is also fire-and-forget in invitations.js line 88.

### HTML templating (`src/auth/email.js:91-93`)

Inline HTML. No Resend-managed templates. All styling is inline CSS via `BUTTON_STYLE` and `HINT_STYLE` constants. User-controlled strings (`orgName`, `inviterEmail`) are escaped via a local `escape()` function at email.js:95-99.

---

## Core concepts

**Verified sending domain.** Every `from` address must belong to a domain verified with Resend (SPF + DKIM DNS records). Sending from an unverified domain returns HTTP 403 / `validation_error`. We use `noreply@zoomchat.ryteproductions.com` — this specific subdomain must be added and verified in the Resend dashboard, not just the root domain.

**API key scoping.** A single API key sends all transactional emails. Keys can be scoped read-only or full-access. Sending requires a key with sending permission.

**Fire-and-forget semantics.** Resend's `emails.send` is asynchronous and returns a message ID immediately — it does not wait for delivery confirmation. Delivery status comes via webhooks (which we do not currently consume).

**No retries in the SDK.** The SDK does not retry on transient failures. Our `send()` wrapper also does not retry. A transient 500 or network error silently drops the email.

**Free plan limitations.** Free tier has a daily quota (exact number varies by plan). Paid tiers remove daily limits but keep monthly quotas. All plans share a rate limit (see Rate limits section).

---

## API / SDK surface we touch

### `resend.emails.send(payload)` — USED

```ts
resend.emails.send({
  from: string,           // "Name <email@domain.com>" or "email@domain.com"
  to: string | string[],  // up to 50 addresses
  subject: string,
  html?: string,
  text?: string,
  // NOT USED by us: cc, bcc, reply_to, scheduled_at, headers,
  //                 attachments, tags, topic_id, idempotencyKey, react, template
})
// Returns Promise<{ data: { id: string } | null, error: { name: string, message: string, statusCode: number } | null }>
```

**Critical nuance:** The SDK returns `{ data, error }` — it does NOT throw on API-level errors (4xx/5xx). Network-level errors (DNS failure, timeout) do throw. Our `try/catch` only catches the network case. The API-level error path (e.g., unverified domain, invalid key) is silently ignored because we never inspect `error`.

### `resend.batch.send(payload[])` — NOT USED

Sends up to 100 emails in one HTTP call. SDK method: `resend.batch.send([...])`. Response: `{ data: [{ id }], error }`. No attachment or scheduled send support. Idempotency keys supported per batch (header-level).

### `resend.webhooks.verify(...)` — NOT USED

Verifies incoming webhook signatures using standard-webhooks (replaced svix in v6.12.4):
```js
resend.webhooks.verify({ payload, headers: { id, timestamp, signature }, webhookSecret })
```

### Emails retrieve, update, cancel — NOT USED

`GET /emails/:id`, `PATCH /emails/:id` (cancel scheduled), `GET /emails/batch` — none consumed by us.

---

## Auth & secrets

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `RESEND_API_KEY` | Prod only | `null` (console fallback) | Authenticates all Resend API calls |
| `EMAIL_FROM` | Prod only | `noreply@zoomchat.ryteproductions.com` | Sender address; domain must be Resend-verified |
| `APP_URL` | Prod only | `http://localhost:5173` | Base for deep links in email bodies |

`.env.example` documents all three (lines for `RESEND_API_KEY`, `EMAIL_FROM`, `APP_URL`). The key is passed directly to `new Resend(apiKey)` and sent as `Authorization: Bearer <key>` on every request by the SDK.

No key rotation logic exists. Key compromise requires manual rotation in the Resend dashboard and updating the deployment env var.

---

## Webhooks / events

**We do not consume Resend webhooks.** There is no webhook endpoint, no event listener, and no delivery status tracking.

For reference, Resend can POST to a configured endpoint for these events:
- `email.sent`, `email.delivered`, `email.delivery_delayed`
- `email.bounced`, `email.complained` (spam report)
- `email.opened`, `email.clicked` (if tracking enabled)
- `domain.verified`, `domain.failed`

Webhook requests carry three signature headers: `svix-id`, `svix-timestamp`, `svix-signature`. Verification requires the raw (unparsed) request body — re-stringified JSON will fail. As of v6.12.4 the SDK uses `standardwebhooks` internally (svix was removed).

---

## Version-specific notes

Pinned version: `resend ^6.12.4` (package.json). Semver `^` allows patch + minor bumps up to `<7.0.0`.

### Changes relevant to our integration (v6.x)

- **v6.12.4:** SDK no longer mutates the payload object you pass in. Previously, internal processing could modify the caller's object — safe to ignore since we construct fresh objects per call.
- **v6.12.4:** `standardwebhooks` replaces `svix` as the verification dependency. Smaller bundle, same API surface. No impact since we don't use webhooks.
- **v6.12.4:** `new Resend(key, { baseUrl, userAgent })` — optional constructor params added. We don't use these.
- **v6.12.0:** Tracking Domains API added (preview). Not relevant.
- **v6.9.2:** Fixed Cloudflare Workers / non-Node environment compatibility. No impact (we run Node on Railway).
- **v6.9.2:** Batch email type now distinct from single send type — `BatchEmailOptions` enforces the subset of params batch supports (no attachments, no `scheduled_at`).

### Response shape

The SDK since v6.x consistently returns `{ data, error }`. Our `send()` wrapper uses a `try/catch` and ignores the `error` field entirely. This means API-level failures (invalid domain, quota exceeded, invalid key) are silently dropped — only network-level exceptions propagate to the catch.

---

## Rate limits / quotas / scaling

- **Rate limit:** 2 requests/second per team (all API keys combined). Headers returned: `ratelimit-limit`, `ratelimit-remaining`, `ratelimit-reset`, `retry-after`. Exceeded: HTTP 429.
- **Daily quota (free plan):** Enforced. Error: `daily_quota_exceeded` (HTTP 429).
- **Monthly quota (all plans):** Enforced. Error: `monthly_quota_exceeded` (HTTP 429).

At our current volume (auth emails only, transactional, not bulk), we are unlikely to hit rate limits under normal operation. A signup spike (e.g., marketing campaign) combined with invitation emails could approach limits if firing many in parallel.

We have no rate-limit handling, queuing, or backoff logic. A 429 is silently swallowed by the `catch` in `send()`.

---

## Gotchas & failure modes

**1. Silent failure on API errors.** `resend.emails.send()` returns `{ data, error }` and does NOT throw on HTTP 4xx/5xx. Our `try/catch` only catches network failures. An `invalid_api_key`, `validation_error` (unverified domain), `daily_quota_exceeded`, or `monthly_quota_exceeded` will log nothing and return silently. Users will never receive the email; no error surfaces to them or to us. (`src/auth/email.js:27-31`)

**2. Unverified sending domain blocks all email in production.** If `EMAIL_FROM` is set to a domain not verified in the Resend dashboard, every call returns HTTP 403. Since we swallow that error, the app will appear to work but send zero emails. This is especially dangerous on initial deployment.

**3. `RESEND_API_KEY` absent in production.** If the env var is accidentally unset in a Railway deployment, the console-log fallback silently takes over. Verification emails are never sent. The app still responds 201 to signup requests, leaving users unable to verify their email.

**4. No retry on transient failures.** A momentary network hiccup or Resend 500 drops the email permanently. The user must manually trigger a resend (verification resend exists at `/api/auth/resend-verification`; password reset can be re-requested; invitation must be re-sent by an admin).

**5. HTML injection in invitation email.** `orgName` and `inviterEmail` in `sendInvitationEmail` are HTML-escaped via the local `escape()` function (`email.js:95-99`). The subject line, however, uses template literals without escaping: `` subject: `You've been invited to ${orgName} on ZoomChat` `` (`email.js:74`). Email subjects are plain text so HTML injection there is harmless, but the pattern warrants awareness.

**6. Rate limit not handled.** A 429 from Resend is silently discarded. No retry-after behaviour, no queue, no alerting.

**7. `to` field accepts arrays but we only send to one address.** No multi-recipient risk currently, but future code should be careful not to accidentally CC or BCC other users' emails into a single `to` array call.

**8. Domain vs subdomain reputation.** We send from `noreply@zoomchat.ryteproductions.com`. Resend recommends subdomains (rather than the root domain) to isolate transactional reputation — our setup already follows this. However, DMARC should be configured at the root `ryteproductions.com` level to cover the subdomain.

**9. Free-tier test address only for onboarding.** Resend provides `onboarding@resend.dev` as a test sender for free-tier accounts without a verified domain. We hardcode our production domain as default, so local dev without `RESEND_API_KEY` set is safe (console fallback), but any accidental use of the Resend API without domain verification will 403.

---

## Risks / TODOs in our current code

**CRITICAL — `src/auth/email.js:27-31`: API errors silently swallowed.**
The `try/catch` only catches thrown exceptions. The SDK's `{ data, error }` response is never inspected. Any API-level failure (unverified domain, bad key, quota) is invisible. Fix: check `error` after the call and log or alert:
```js
const { data, error } = await resend.emails.send({ from: FROM, to, subject, html, text });
if (error) {
  console.error(`[email] Resend API error sending "${subject}" to ${to}:`, error);
}
```

**HIGH — `src/auth/email.js:85` and `auth.js:169`, `invitations.js:88`: fire-and-forget without await.**
`sendVerificationEmail` and `sendInvitationEmail` are called without `await`. If the internal `send()` function ever throws (not expected given the current catch, but possible after a refactor), the error would become an unhandled promise rejection. Low risk today; becomes dangerous if error handling is tightened.

**MEDIUM — No delivery observability.**
We have no webhook consumer, no logging of successful sends (only failures), and no way to know if emails are bouncing or going to spam. Recommend adding Resend webhook handling for at minimum `email.bounced` and `email.complained` events to detect deliverability problems.

**MEDIUM — No rate-limit handling.**
If we ever approach 2 req/s (e.g., bulk invitation import), 429 errors drop emails silently. Add a simple queue or sequential send for bulk operations.

**LOW — `EMAIL_FROM` default hardcodes production subdomain.**
The fallback `noreply@zoomchat.ryteproductions.com` means if someone sets `RESEND_API_KEY` without `EMAIL_FROM`, emails appear to come from the production domain even in staging. Should add a `NODE_ENV !== 'production'` guard or require `EMAIL_FROM` to be explicit when the API key is present.

**LOW — No idempotency keys on sends.**
Resend supports `Idempotency-Key` (max 256 chars, 24h expiry) to prevent duplicate sends on network retry. We don't use it. Unlikely to matter for human-triggered auth emails, but good hygiene for automated flows.

---

## Key links

- [Resend Docs — Introduction](https://resend.com/docs/introduction)
- [API Reference — Send Email](https://resend.com/docs/api-reference/emails/send-email)
- [API Reference — Send Batch Emails](https://resend.com/docs/api-reference/emails/send-batch-emails)
- [API Reference — Errors](https://resend.com/docs/api-reference/errors)
- [API Reference — Rate Limits](https://resend.com/docs/api-reference/rate-limit)
- [Domains — Introduction](https://resend.com/docs/dashboard/domains/introduction)
- [Webhooks — Verify Requests](https://resend.com/docs/webhooks/verify-webhooks-requests)
- [Node SDK — GitHub Releases](https://github.com/resend/resend-node/releases)
- [Changelog — API Rate Limit](https://resend.com/changelog/api-rate-limit)
- [Send with Node.js — Quickstart](https://resend.com/docs/send-with-nodejs)
