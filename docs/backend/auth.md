# Auth stack (bcryptjs + cookie sessions, Lucia pattern)

> Server-side session auth with bcrypt password hashing and HTTP-only cookies, hand-rolled following Lucia's post-deprecation "copy the primitives" guide. Pinned: `bcryptjs ^3.0.3`, `cookie ^0.7.2`, `cookie-parser ^1.4.7`.

---

## How we use it

The auth stack is split across five files and mounted globally in `src/server/index.js`.

### Middleware mount order (`src/server/index.js`)

1. `cookieParser()` at line 79 — parses the `Cookie` header so `req.cookies` is populated before any auth check runs.
2. `attachUser(db)` at line 91–95 — runs on **every** request. Reads `zoomchat_session` from the cookie, validates it against `auth_sessions`, and if valid sets `req.user` and `req.org`. No-ops when `db` is null (dev without Postgres).
3. `app.use('/api', requireAuth)` at line 141 — hard gate. Blocks all `/api/*` routes (except `/api/auth/*` and `/api/invitations/accept*` which are mounted before this line) with 401 if `req.user` is undefined.

### Password hashing (`src/auth/passwords.js`)

- `hashPassword(plain)` — calls `bcrypt.hash(plain, 12)`. Cost factor 12 is hardcoded at line 6. Throws if `plain` is empty or shorter than 8 characters.
- `verifyPassword(plain, hash)` — calls `bcrypt.compare(plain, hash)`. Returns `false` (not throws) on any error.
- The module imports from `bcryptjs` (pure JS, no native binding). The comment at line 3–4 explains: chosen over native `bcrypt` because Railway deploys have no build step.

### Session lifecycle (`src/auth/sessions.js`)

- `newSessionId()` at line 19 — `crypto.randomBytes(32).toString('hex')` → 256-bit hex string (64 chars). This is stored **raw** (unhashed) as the primary key in `auth_sessions`.
- `createSession(db, userId)` — inserts the raw ID with `expires_at = NOW() + 30 days`. Returns `{ id, expiresAt }`.
- `validateSession(db, sessionId)` — single JOIN query across `auth_sessions`, `users`, `organizations` (lines 40–58). Returns full `{ sessionId, user, org }` context including billing fields. Sliding window: if remaining TTL < 15 days (half of 30), extends to 30 days from now (lines 68–72).
- `invalidateSession(db, sessionId)` — `DELETE FROM auth_sessions WHERE id = $1`.
- `invalidateAllSessionsForUser(db, userId)` — `DELETE FROM auth_sessions WHERE user_id = $1`. Called on password-reset confirm (`src/routes/auth.js` line 202) to boot stolen sessions.
- Cookie helpers at lines 104–122: `setSessionCookie` / `clearSessionCookie` / `readSessionCookie`. Cookie shape: `httpOnly: true`, `secure: process.env.NODE_ENV === 'production'`, `sameSite: 'lax'`, `expires: expiresAt`, `path: '/'`.

### Email token lifecycle (`src/auth/tokens.js`)

- `newTokenId()` — `crypto.randomBytes(32).toString('hex')` → same 256-bit entropy as session IDs.
- `createEmailToken(db, userId, type)` — inserts with `type ∈ {'verify','reset'}` and `expires_at = NOW() + 24h`.
- `consumeEmailToken(db, token, expectedType)` — atomic `UPDATE … SET used_at = NOW() WHERE id=$1 AND type=$2 AND used_at IS NULL AND expires_at > NOW() RETURNING user_id`. Returns `{ userId }` or null. Single-use enforced by the `used_at IS NULL` check.
- Note: token is stored raw (not hashed) in `email_tokens.id`. The token the user clicks **is** the row's primary key.

### Auth routes (`src/routes/auth.js`, mounted at `/api/auth`)

| Route | Method | Auth required | What it does |
|---|---|---|---|
| `/signup` | POST | No | Creates org + user, hashes password, fires verify email, creates session, sets cookie |
| `/login` | POST | No | Looks up by email, bcrypt-compares, creates session, sets cookie |
| `/logout` | POST | No | Deletes session row, clears cookie |
| `/me` | GET | No (soft) | Returns `req.user` / `req.org` from attachUser, or `{user:null,org:null}` |
| `/verify-email` | POST | No | Consumes `type='verify'` token, sets `email_verified=TRUE` |
| `/resend-verification` | POST | Soft | Issues new verify token, sends email |
| `/password-reset/request` | POST | No | Blind lookup — always returns 200, sends reset email if user exists |
| `/password-reset/confirm` | POST | No | Consumes `type='reset'` token, rehashes password, kills all sessions for that user |

### Invitation routes (`src/routes/invitations.js`, mounted at `/api/invitations`)

- Invite token is `crypto.randomBytes(32).toString('hex')`, stored in `invitations.token` column (not the PK). TTL: 7 days.
- `GET /accept/:token` — public route that returns invite metadata (used to pre-fill the UI).
- `POST /accept` — atomic `UPDATE invitations SET accepted_at=NOW() WHERE token=$1 AND accepted_at IS NULL AND expires_at>NOW() RETURNING …`. Creates user, creates session. On email conflict, un-consumes the invite (sets `accepted_at=NULL` back) and returns 409.

### Email delivery (`src/auth/email.js`)

- If `RESEND_API_KEY` is set, uses the `resend` SDK. Otherwise logs to console (dev mode).
- Fire-and-forget: callers do not `await` the returned promise in signup/login flows (see `src/routes/auth.js` line 85: `sendVerificationEmail({ to, token })` — no await). Email failures are logged but never surface as HTTP errors.

### Database schema (relevant tables, `src/db/index.js`)

```sql
-- auth_sessions: raw session ID as PK, cascades on user delete
CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,           -- raw 256-bit hex; stored unhashed
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- email_tokens: raw token as PK, single-use
CREATE TABLE email_tokens (
  id TEXT PRIMARY KEY,           -- raw 256-bit hex; stored unhashed
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,            -- 'verify' | 'reset'
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- invitations: token in its own column (not PK)
CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  token TEXT UNIQUE NOT NULL,    -- raw 256-bit hex; stored unhashed
  ...
);
```

---

## Core concepts

**Server-side sessions, not JWTs.** The cookie carries only a random opaque ID. All authorization context (role, org, plan tier, Stripe IDs) lives in Postgres. Revoking a session is a single `DELETE`. No key rotation, no stale-token window.

**Lucia "copy the primitives" approach.** The `lucia` npm package was deprecated in March 2025. Lucia's maintainer explicitly recommended reimplementing the ~50 lines of session logic directly, following the guides at lucia-auth.com. Our codebase predates or follows this guidance — we own every line of auth code with no external session library dependency beyond `bcryptjs` and `cookie-parser`.

**Sliding expiry.** Rather than extend on every request (expensive), we extend only when the session is more than half-expired. `SESSION_TOUCH_THRESHOLD_MS = SESSION_TTL_MS / 2` = 15 days. If remaining time < 15 days, extend to 30 days from now. This means an active user is always signed in; an idle user expires after 30 days.

**Org isolation via JOIN.** `validateSession` joins three tables in one query and returns the org's billing fields. Downstream handlers use `req.org.id` as the tenant key for all data operations. The join means a user's org membership and plan are always fresh from the DB on each request — no stale cached tier.

**Email tokens are single-use via atomic UPDATE.** The `WHERE used_at IS NULL` + `RETURNING` pattern means concurrent clicks on the same link — only one wins. The second request gets zero rows back and returns 400.

**bcrypt is not constant-time for session lookup.** bcrypt.compare is appropriate for passwords (because bcrypt itself provides timing resistance). But session IDs are looked up by direct SQL `WHERE id = $1` — the database's B-tree index comparison is not constant-time. See Risks section.

---

## API / SDK surface we touch

### bcryptjs (`src/auth/passwords.js`)

| Function | We use | Purpose |
|---|---|---|
| `bcrypt.hash(plain, rounds)` | Yes (line 15) | Hash password at signup/reset; `rounds=12` |
| `bcrypt.compare(plain, hash)` | Yes (line 23) | Verify password at login |
| `bcrypt.genSalt(rounds)` | No | We pass rounds integer directly to `hash()` |
| `bcrypt.hashSync` / `compareSync` | No | We use async variants only |
| `bcrypt.getRounds(hash)` | No | Could be used to detect rehash-needed |
| `bcrypt.truncates(password)` | No | See Risks — should be used |
| `bcrypt.getSalt(hash)` | No | Not needed in our flow |

### Node `crypto` (built-in, no package)

| Function | We use | Purpose |
|---|---|---|
| `crypto.randomBytes(32)` | Yes (sessions.js:19, tokens.js:14) | Generate session and token IDs |
| `crypto.randomUUID()` | Yes (routes/auth.js:47,48) | Generate user and org UUIDs |
| `crypto.timingSafeEqual()` | No | See Risks — not used for session lookup |

### cookie-parser (`src/server/index.js:79`)

Used for `req.cookies` parsing only. We do not sign cookies with a secret (cookie-parser's signed-cookie feature requires passing a secret to `cookieParser(secret)`). Our cookies are read via `req.cookies[SESSION_COOKIE_NAME]` (plain, unsigned).

### cookie (indirect, via express `res.cookie`)

`setSessionCookie` at `src/auth/sessions.js:104` calls Express's `res.cookie()`. The `cookie ^0.7.2` package is Express's internal serializer.

---

## Auth & secrets

| Env var | Required in prod | Purpose |
|---|---|---|
| `DATABASE_URL` | Yes | Postgres connection string for all auth tables |
| `SESSION_SECRET` | Yes (unset = no signing) | Listed in `.env.example` line 54 but **not actually consumed anywhere in the codebase** — see Risks |
| `RESEND_API_KEY` | Recommended | Without it, emails log to console only |
| `EMAIL_FROM` | Recommended | Sender address; defaults to `noreply@zoomchat.ryteproductions.com` |
| `APP_URL` | Yes | Base URL embedded in email links; defaults to `http://localhost:5173` |
| `NODE_ENV` | Yes | Controls `secure` flag on session cookie; must be `production` in prod |

**How credentials flow:**
1. User submits email + password over HTTPS.
2. Server queries `users WHERE email=$1`, gets `password_hash`.
3. `bcrypt.compare(plain, hash)` — pure JS, no network calls.
4. On success, `crypto.randomBytes(32)` generates session ID; INSERT to `auth_sessions`.
5. `res.cookie(SESSION_COOKIE_NAME, sessionId, { httpOnly, secure, sameSite:'lax' })`.
6. On subsequent requests, `cookieParser()` puts the value in `req.cookies`; `attachUser` reads it and runs the JOIN query.

---

## Webhooks / events

Not applicable to the auth stack directly. Auth routes are REST, not event-driven. The `invalidateAllSessionsForUser` function is called from `password-reset/confirm` — this is the closest thing to an auth event cascading to session state.

---

## Version-specific notes

### bcryptjs ^3.0.3

- **New in v3.x:** Added `truncates(password)` function (returns boolean) — detects if a password will be silently truncated at 72 bytes. We **do not call this function** (see Risks).
- bcrypt always silently truncates passwords longer than 72 UTF-8 bytes (Blowfish cipher limitation). Two passwords sharing the same first 72 bytes hash identically. The Okta breach in October 2023 was partly caused by this behavior when bcrypt was applied to a concatenated string that exceeded 72 bytes.
- bcryptjs is pure JavaScript — approximately 5× slower than the native `bcrypt` C++ binding at hashing. At cost factor 12 on Railway's hardware, expect roughly 200–400ms per hash. This is acceptable for our login volume but adds noticeable latency if ever called in a hot path.
- `bcrypt.compare()` is not a general-purpose constant-time comparator. It exits early on a mismatch within bcrypt's internal logic. This is documented as safe for password comparison (because bcrypt's preimage resistance means early exit leaks nothing about the stored hash). It is **not** appropriate for comparing arbitrary secrets like session tokens.

### cookie-parser ^1.4.7

- cookie-parser's signed cookie feature (`cookieParser('secret')` + `req.signedCookies`) is not used. We pass no secret to `cookieParser()` in `src/server/index.js:79`. The `SESSION_SECRET` env var described in `.env.example` is present in documentation but wired to nothing.

### cookie ^0.7.2

- Used internally by Express's `res.cookie()`. No direct calls in our code.

### Lucia package (DEPRECATED March 2025)

- The `lucia` npm package is **not installed** in our `package.json`. We follow the Lucia-pattern but never took the library as a dependency.
- The lucia-auth.com guides remain active as a reference. Their post-deprecation "Basic API" guide recommends: 120-bit minimum entropy tokens (we use 256-bit), sliding expiry (we implement this), SHA-256 hashing of session tokens at rest (we do **not** do this — see Risks), and HTTP-only + Secure + SameSite=Lax cookies (we match this exactly).

---

## Rate limits / quotas / scaling

- **bcrypt at cost 12:** ~200–400ms per hash operation. Login and signup are each blocked for this duration. This is intentional (slows brute-force). At high concurrency this becomes a CPU bottleneck. `bcryptjs` is single-threaded synchronous under the hood despite the async API — it does not yield the event loop during hashing on older Node versions (though newer versions handle this via libuv threadpool).
- **No rate limiting on auth routes.** `/api/auth/login` and `/api/auth/password-reset/request` have no rate limiting as of this writing. An attacker can send unlimited login attempts or reset requests.
- **Session table size.** 30-day TTL with no periodic cleanup job means expired rows accumulate. The `idx_auth_sessions_expires` index exists, but no cron deletes them. High-churn signups will grow the table indefinitely.
- **DB pool:** 25 connections (`src/db/index.js:279`). Each authenticated request consumes one connection for the duration of the `validateSession` JOIN. At 25 concurrent requests all hitting auth, connections will queue.

---

## Gotchas & failure modes

1. **`NODE_ENV` not set → `secure: false` on session cookie.** `setSessionCookie` at `sessions.js:107` checks `process.env.NODE_ENV === 'production'`. If this env var is missing or misspelled in a Railway deploy, the session cookie is sent over HTTP — meaning it can be intercepted in transit even if the server is behind HTTPS (e.g., by a misconfigured proxy that strips TLS).

2. **`SESSION_SECRET` is documented but never consumed.** `.env.example` line 54 describes it as "used to sign/HMAC session cookies." No code in the project reads `process.env.SESSION_SECRET`. Engineers following the `.env.example` docs will believe cookies are signed when they are not. This is misleading documentation, not a security flaw (our session IDs already have 256-bit entropy), but it creates confusion.

3. **Signup bootstraps to `ryte-org` on first call.** `src/routes/auth.js:54–73`: if `ryte-org` has no users, the first signup claims it as RYTE admin. In production this is correct — but if someone races the very first deploy, or if `ryte-org` is somehow cleaned from the DB, the next external signup becomes a RYTE admin. No time window is enforced.

4. **Email failures are fire-and-forget with no retry.** `sendVerificationEmail` is called without `await` at `routes/auth.js:85`. If Resend returns an error, the user is signed in but never receives a verification link. They must use `/resend-verification` manually. There's no UI prompt that informs them the email may not have arrived.

5. **bcrypt 72-byte truncation is unguarded.** We validate `plain.length < 8` but nothing prevents a password longer than 72 UTF-8 bytes from being accepted. Two passwords sharing the same first 72 bytes are functionally identical. The `bcryptjs` v3 `truncates()` function exists precisely to catch this — we do not call it.

6. **No absolute session timeout.** Only a 30-day sliding expiry. An active user who logs in once and keeps using the app will never be forced to re-authenticate. OWASP recommends an absolute upper bound (4–8 hours for sensitive apps) regardless of activity. For a live-event moderator tool this may be acceptable, but it's worth a deliberate decision.

7. **Session table grows unboundedly.** No job prunes expired rows. `idx_auth_sessions_expires` is indexed but only consulted during `validateSession` — expired rows still occupy storage and bloat sequential scans if the index is bypassed.

8. **`clearSessionCookie` does not set `Secure` or `SameSite`.** `sessions.js:115` calls `res.clearCookie(SESSION_COOKIE_NAME, { path: '/' })`. Some browsers only remove cookies when the `Set-Cookie: …; Max-Age=0` header includes the same attributes as the original `Set-Cookie`. In practice most browsers clear it anyway, but the OWASP cheat sheet recommends matching attributes on logout.

9. **Invitation accept races.** `routes/invitations.js:201–219`: on email conflict, the code un-consumes the invite by setting `accepted_at = NULL`. Between the `UPDATE accepted_at=NOW()` and the rollback `UPDATE accepted_at=NULL`, another concurrent accept could also have won the first UPDATE and be in the user-creation path. This window is milliseconds but not zero.

---

## Risks / TODOs in our current code

| Risk | Severity | Location | Detail |
|---|---|---|---|
| Session tokens stored unhashed | Medium | `src/db/index.js:158`, `src/auth/sessions.js:19` | The 256-bit raw hex session ID is the `auth_sessions.id` PK. A Postgres dump or `auth_sessions` table leak directly exposes live session IDs. Lucia's post-deprecation guide recommends SHA-256 hashing session tokens at rest so the DB row can't be replayed. |
| Email tokens stored unhashed | Medium | `src/db/index.js:169`, `src/auth/tokens.js:14` | Same issue: `email_tokens.id` is the raw token. Password-reset tokens in a DB dump are directly usable for account takeover within the 24h TTL. |
| Invitation tokens stored unhashed | Medium | `src/db/index.js:180`, `src/routes/invitations.js:80` | `invitations.token` is stored as raw hex. A DB leak exposes valid invite tokens. |
| No rate limiting on login | High | `src/routes/auth.js:103` | Unlimited brute-force attempts allowed. bcrypt at cost 12 is slow but not a substitute for rate limiting. |
| No rate limiting on password-reset/request | Medium | `src/routes/auth.js:173` | Can be used to spam users with reset emails. |
| `bcryptjs.truncates()` not called | Low-Medium | `src/auth/passwords.js:8–16` | Passwords > 72 UTF-8 bytes are silently accepted and truncated. Add `if (bcrypt.truncates(plain)) throw new Error('Password too long')` in `hashPassword`. |
| `SESSION_SECRET` env var documented but unused | Low | `src/auth/sessions.js`, `.env.example:54` | Either wire it to `cookieParser(secret)` and switch to `req.signedCookies`, or remove it from `.env.example` to avoid confusion. |
| No absolute session timeout | Low-Medium | `src/auth/sessions.js:14` | 30-day sliding expiry only. Consider adding `created_at`-based absolute expiry (e.g., 90 days). |
| No cleanup job for expired sessions | Low | `src/db/index.js:158–165` | Expired rows accumulate. A weekly `DELETE FROM auth_sessions WHERE expires_at < NOW()` cron would keep the table lean. |
| `SameSite: 'lax'` vs `'strict'` | Low | `src/auth/sessions.js:107` | Lax allows the cookie on top-level cross-site navigation (following a link). OWASP recommends Strict for sensitive apps. For a live-event tool, Lax is likely acceptable (moderators follow links from Slack/email), but this is a deliberate trade-off worth documenting. |
| `clearSessionCookie` missing Secure/SameSite attributes | Low | `src/auth/sessions.js:114–116` | Best practice is to include the same attributes on the `Max-Age=0` clear response. |
| Bootstrap race on first signup | Low | `src/routes/auth.js:54–62` | First-signup-claims-ryte-org logic has no time gate or admin confirmation. Fine for initial deploy, fragile if DB is accidentally reset. |

---

## Key links

- Lucia auth (post-deprecation resource site): https://lucia-auth.com/
- Lucia deprecation announcement: https://github.com/lucia-auth/lucia/discussions/1714
- Lucia future plans discussion: https://github.com/lucia-auth/lucia/discussions/1707
- Lucia migrate from v3 guide: https://lucia-auth.com/lucia-v3/migrate
- Lucia basic session guide: https://lucia-auth.com/sessions/basic
- bcryptjs on npm: https://www.npmjs.com/package/bcryptjs
- bcryptjs API reference (jsDocs): https://www.jsdocs.io/package/bcryptjs
- node.bcrypt.js security wiki (72-byte truncation, NUL chars): https://github.com/kelektiv/node.bcrypt.js/wiki/Security-Issues-and-Concerns
- OWASP Session Management Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
- OWASP Authentication Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
- Okta bcrypt 72-byte incident writeup: https://www.nodejs-security.com/blog/okta-bcrypt-security-incident-bun-nodejs
