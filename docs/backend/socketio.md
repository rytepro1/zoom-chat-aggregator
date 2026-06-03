# Socket.IO

> Real-time bidirectional event layer: receives inbound chat batches from Recall.ai webhooks and fans them out to every connected browser in the operator's org. Pinned to **socket.io ^4.7.5** (server) + **socket.io-client ^4.7.5** (client).

---

## How we use it

### Server bootstrap (`src/server/index.js:32-40`)

A single `Server` instance is attached to the Node.js `http.createServer` handle that Express also uses — one port, one process.

```js
const httpServer = createServer(app);          // plain http.Server
const io = new Server(httpServer, {
  cors: {
    origin: process.env.NODE_ENV === 'production'
      ? true                                    // reflect any origin in prod
      : ['http://localhost:5173', 'http://localhost:3000'],
    methods: ['GET', 'POST'],
    credentials: true,
  },
});
```

`setupSocketHandlers(io, { db, orgState })` is called after the DB is initialized (`src/server/index.js:606`) so the auth middleware has a live `db` reference on every handshake.

The `io` instance is stashed on Express via `app.set('io', io)` (`src/server/index.js:70`), making it accessible from route handlers that need to emit (e.g., `presenterNotes.js`, `index.js` meeting routes).

### Auth middleware (`src/server/socketHandler.js:35-51`)

```js
io.use(async (socket, next) => {
  const rawCookie = socket.handshake.headers.cookie || '';
  const cookies = cookie.parse(rawCookie);
  const sessionId = cookies[COOKIE_NAME];     // 'zoomchat_session'
  const session = await validateSession(db, sessionId);
  socket.data.user = session.user;
  socket.data.org  = session.org;
  return next();
});
```

This is a **Socket.IO io.use() middleware** — it fires once per connection before any event handler. Rejections call `next(new Error(...))` and the client surfaces them as `connect_error`. No JWT — the browser's `zoomchat_session` HTTP-only cookie is the credential; it is parsed directly from `socket.handshake.headers.cookie` using the `cookie` npm package.

### Org isolation via rooms (`src/server/socketHandler.js:54-55`)

On connection, the socket immediately joins `org:<orgId>`. All server-to-client emits use `io.to('org:<id>').emit(...)` so cross-tenant leakage is structurally impossible at the Socket.IO routing layer.

Per-meeting subscriptions are namespaced as `org:<id>:room:<meetingId>` (`src/server/socketHandler.js:99`) for targeted `roomMessageBatch` delivery without per-room fan-out to all org clients.

### Moderation state (`src/server/socketHandler.js:21-115`)

`moderationStateByOrg` is a plain in-memory `Map` keyed by `orgId`. No persistence — restarts reset it. The server accepts `moderationUpdate` events from any org member and re-broadcasts to `org:<id>`, syncing all open operator windows.

### Batched message delivery (`src/services/MessageAggregator.js:26-56`)

`MessageAggregator._scheduleFlush()` collects inbound messages for 100ms then emits a single `newMessageBatch` array. This reduces React re-renders at high chat volume (>50 msgs/sec). The server no longer emits per-message `newMessage` events — the comment in `MessageAggregator.js:136` confirms this — but the client still handles `newMessage` as a legacy fallback (`client/src/contexts/SocketContext.jsx:88-94`).

### Services that emit server → client

| Service | Event emitted | Room target | File |
|---------|--------------|-------------|------|
| `MessageAggregator` | `newMessageBatch` | `org:<id>` | `src/services/MessageAggregator.js:47` |
| `MessageAggregator` | `roomMessageBatch` | `org:<id>:room:<meetingId>` | `src/services/MessageAggregator.js:51-53` |
| `MessageAggregator` | `roomAdded` | `org:<id>` | `src/services/MessageAggregator.js:232` |
| `MessageAggregator` | `roomRemoved` | `org:<id>` | `src/services/MessageAggregator.js:241` |
| `MessageAggregator` | `messageSaved` / `messageUnsaved` | `org:<id>` | `src/services/MessageAggregator.js:188` |
| `MessageAggregator` | `messagesCleared` | `org:<id>` | `src/services/MessageAggregator.js:291` |
| `SessionManager` | `sessionStarted` | `org:<id>` | `src/services/SessionManager.js:148` |
| `SessionManager` | `sessionRenamed` | `org:<id>` | `src/services/SessionManager.js:103` |
| `SessionManager` | `sessionEnded` | `org:<id>` | `src/services/SessionManager.js:85` |
| `TrialEnforcer` | `trialUpdate` | `org:<id>` | `src/services/TrialEnforcer.js:93` |
| `TrialEnforcer` | `trialWarning` | `org:<id>` | `src/services/TrialEnforcer.js:102` |
| `TrialEnforcer` | `trialExhausted` | `org:<id>` | `src/services/TrialEnforcer.js:166` |
| `TrialEnforcer` | `meetingDisconnected` | `org:<id>` | `src/services/TrialEnforcer.js:163` |
| Route handler (`index.js`) | `meetingConnected` | `org:<id>` | `src/server/index.js:213` |
| Route handler (`index.js`) | `meetingDisconnected` | `org:<id>` | `src/server/index.js:242` |
| Route handler (`presenterNotes.js`) | `presenterNote` | `org:<id>` | `src/routes/presenterNotes.js:77` |
| Route handler (`presenterNotes.js`) | `presenterNoteDismissed` | `org:<id>` | `src/routes/presenterNotes.js:97` |
| `socketHandler` | `serverError` | socket (unicast) | `src/server/socketHandler.js:64` |
| `socketHandler` | `initialState` | socket (unicast) | `src/server/socketHandler.js:69` |
| `socketHandler` | `presenterNotesInitial` | socket (unicast) | `src/server/socketHandler.js:79` |
| `socketHandler` | `history` | socket (unicast) | `src/server/socketHandler.js:85` |
| `socketHandler` | `rooms` | socket (unicast) | `src/server/socketHandler.js:89` |
| `socketHandler` | `stats` | socket (unicast) | `src/server/socketHandler.js:93` |
| `socketHandler` | `moderationState` | socket (unicast) | `src/server/socketHandler.js:107` |
| `socketHandler` | `moderationUpdate` | `org:<id>` | `src/server/socketHandler.js:114` |

### Client initialization (`client/src/contexts/SocketContext.jsx:39-44`)

```js
const newSocket = io(SOCKET_URL, {
  transports: ['websocket', 'polling'],
  withCredentials: true,        // sends zoomchat_session cookie on handshake
});
```

`SOCKET_URL` is `http://localhost:3001` in dev and `window.location.origin` in production — same-origin in the Railway deployment because Express serves the Vite build.

`withCredentials: true` is required for the cookie-based auth. The server must set `credentials: true` in its CORS config to match — this is done implicitly by the Socket.IO `cors` config (`src/server/index.js:38`).

**Transport order**: `['websocket', 'polling']` puts WebSocket first, which skips the polling upgrade handshake and connects faster. The default Socket.IO order is polling-first (safer for proxies but slower). Our order is correct for Railway, which supports WebSocket natively.

**Note**: `useSocket.js` (`client/src/hooks/useSocket.js`) is a legacy hook that also creates a socket but does NOT set `withCredentials: true` (`client/src/hooks/useSocket.js:20-22`). It will fail auth in production. It appears to be superseded by `SocketContext.jsx` and may be dead code.

---

## Core concepts

### Handshake and upgrade

Socket.IO begins every connection with an HTTP long-polling request (unless the client specifies `['websocket', 'polling']` — then it opens a WebSocket directly). The handshake assigns a session ID and negotiates transports. Auth middleware runs once at this phase.

### Rooms

Rooms are server-side buckets — the client never knows which rooms it's in. `socket.join(room)` adds the socket; `socket.leave(room)` removes it; disconnection auto-removes from all rooms. `io.to(room).emit(...)` fans out to everyone in the room (including the emitting socket if it's in the room). `socket.to(room).emit(...)` excludes the emitting socket.

### Events

Socket.IO events are arbitrary named strings — both sides register handlers with `.on()` and fire with `.emit()`. There is no built-in schema validation.

### Namespace (default only)

We use only the default `/` namespace. No custom namespaces. Org isolation is done purely with rooms.

### `socket.data`

A plain object the server can attach arbitrary values to. We store `socket.data.user` and `socket.data.org` in the auth middleware for use in event handlers. Not shared across sockets — per-connection state only.

### Acknowledgements

We do not use Socket.IO acknowledgements anywhere in the codebase. All responses are fire-and-forget events. Acks are available (pass a callback as the last emit argument) but unused.

---

## API / SDK surface we touch

### Server (`socket.io`)

| API | Used? | Where |
|-----|-------|-------|
| `new Server(httpServer, opts)` | Yes | `src/server/index.js:32` |
| `io.use(fn)` | Yes | `src/server/socketHandler.js:35` |
| `io.on('connection', fn)` | Yes | `src/server/socketHandler.js:53` |
| `io.to(room).emit(event, data)` | Yes | Multiple routes + services |
| `socket.join(room)` | Yes | `src/server/socketHandler.js:55, 99` |
| `socket.leave(room)` | Yes | `src/server/socketHandler.js:103` |
| `socket.emit(event, data)` | Yes | `src/server/socketHandler.js:64, 69, 79, 85, 89, 93, 107` |
| `socket.on(event, fn)` | Yes | `src/server/socketHandler.js:82-117` |
| `socket.off(event, fn)` | No | — |
| `socket.data` | Yes | `src/server/socketHandler.js:44-45, 54` |
| `socket.handshake.headers.cookie` | Yes | `src/server/socketHandler.js:38` |
| `socket.id` | Yes (logging only) | `src/server/socketHandler.js:56` |
| `socket.rooms` | No | — |
| `io.fetchSockets()` | No | — |
| `io.of(namespace)` | No | — |
| `io.adapter(...)` | No | — |
| Connection state recovery | No | — |
| `io.engine.use()` (Express middleware on engine) | No | — |
| Acknowledgements | No | — |

### Client (`socket.io-client`)

| API | Used? | Where |
|-----|-------|-------|
| `io(url, opts)` | Yes | `SocketContext.jsx:39` |
| `socket.on(event, fn)` | Yes | `SocketContext.jsx`, `ModerationContext.jsx`, etc. |
| `socket.off(event, fn)` | Yes | Cleanup in `useEffect` returns |
| `socket.emit(event, data)` | Yes | `ModerationContext.jsx:47`, `socketHandler` event sends |
| `socket.connected` | No | (uses `connect`/`disconnect` events instead) |
| `socket.disconnect()` | Yes | `SocketContext.jsx:133` (cleanup) |
| `socket.auth` option | No | (uses cookie, not `auth` option) |
| `socket.io.opts.transports` | No | — |
| Volatile emit | No | — |

---

## Auth & secrets

| Env var | Purpose | Where set |
|---------|---------|-----------|
| None specific to Socket.IO | — | — |

Socket.IO itself has no API key or secret. Auth is layered on top:

- **Cookie name**: `zoomchat_session` — defined in `src/auth/sessions.js:13` as `SESSION_COOKIE_NAME`, exported as `COOKIE_NAME`.
- **Session validation**: `validateSession(db, sessionId)` (`src/auth/sessions.js:38`) does a Postgres JOIN across `auth_sessions`, `users`, and `organizations`. Returns `{ user, org }` or `null`.
- **Cookie flags**: `httpOnly: true`, `secure: true` in production, `sameSite: 'lax'` (`src/auth/sessions.js:105-110`). The `lax` `sameSite` setting allows the cookie to be sent on top-level navigation but not on cross-site requests — this is fine since the Socket.IO handshake originates same-origin in production.
- **No SESSION_SECRET used for socket auth**: The session ID is an opaque 256-bit random hex (`src/auth/sessions.js:20`), not an HMAC-signed value. Security depends on the cookie being unguessable and the DB row existing.

**Credential flow on connect**:
1. Browser sends `zoomchat_session` cookie with the WebSocket upgrade request (because `withCredentials: true` is set on the client).
2. `io.use()` middleware parses it from `socket.handshake.headers.cookie`.
3. `validateSession()` hits Postgres.
4. On success: `socket.data.user` and `socket.data.org` are set for all subsequent handlers.
5. On failure: `next(new Error('Not signed in' | 'Session expired'))` — client gets `connect_error` and is redirected to `/signin` (`client/src/contexts/SocketContext.jsx:59-63`).

---

## Webhooks / events

Socket.IO is not a webhook system — it is the push channel TO the browser. Inbound webhooks from Recall.ai arrive on `POST /webhook/recall/chat` (HMAC-verified by `src/recall/verifyRecallWebhook.js`), which calls `ma.addMessage(...)`, which queues the socket emit via `MessageAggregator._queueMessageEmit`.

The flow from external event to browser is:
```
Recall.ai POST /webhook/recall/chat
  → RecallBotManager.handleChatEvent()
  → MessageAggregator.addMessage()
  → _queueMessageEmit() → 100ms batch timer
  → io.to('org:<id>').emit('newMessageBatch', [...])
  → browser SocketContext.jsx newMessageBatch handler
  → React state update
```

---

## Version-specific notes (socket.io ^4.7.5)

**4.7.0 (June 2023) — our minimum pinned patch:**
- Added **WebTransport** (HTTP/3) as a third transport option. We do not enable it (client uses `['websocket', 'polling']` only).
- Node.js client: `withCredentials: true` now properly forwards cookies for cookie-based sticky sessions — relevant for our auth pattern.
- ESM client builds no longer include the `debug` package by default (reduces bundle size). Use conditional import `socket.io-client/debug` if needed.

**4.7.2 (August 2023):**
- Bug fixes in `engine.io-client`. No behavior changes relevant to us.

**4.7.3 (January 2024):**
- Patch release, engine.io bug fixes.

**4.8.0 (September 2024) — available but not pinned:**
- Client: new `transports` option accepts transport class constructors (e.g., `Fetch`, `WebSocket`) for environments without `XMLHttpRequest`. Not relevant to browser clients.
- Client: new `tryAllTransports` option for fallback testing. Not used.
- Bug fix: "allow to manually stop the reconnection loop" — `socket.disconnect()` now reliably stops retries.
- Bug fix: "close the engine upon decoding exception" — prevents zombie connections on malformed packets.

**Reconnection defaults (all versions):**
- `reconnection: true` (automatic)
- `reconnectionAttempts: Infinity`
- `reconnectionDelay: 1000` ms, doubling up to `reconnectionDelayMax: 5000` ms
- We do not override any of these — the client will retry forever with exponential backoff capped at 5s.

**`socket.id` is ephemeral:** It changes on every reconnection. We only use it for server-side logging (`socketHandler.js:56, 119`), which is correct. We never store it or use it as a client identifier in business logic.

---

## Rate limits / quotas / scaling

### No Socket.IO-imposed rate limits

Socket.IO itself has no built-in rate limiting. The `maxHttpBufferSize` defaults to 1 MB per message — our payloads (chat messages) are far smaller.

### Single-instance assumption

Railway deploys us as **one process, one instance** (`railway.json` has no replica config). This means:

- **No sticky sessions needed**: All sockets land on the same process. `io.to(room).emit()` works correctly because all room memberships are in the same in-memory adapter.
- **No Redis adapter needed**: The default in-memory adapter is correct for a single instance.
- **If Railway ever scales to 2+ replicas**, socket events emitted on instance A will NOT reach clients connected to instance B. This will silently break real-time updates (messages delivered to wrong users, moderation state desync, trial events lost). The fix is adding the `@socket.io/redis-adapter` and a Redis instance.

### `moderationStateByOrg` is in-memory only

(`src/server/socketHandler.js:21`) — a `Map` in the Node.js process. A restart clears it. A second instance cannot see it. This is an acceptable current limitation but must be addressed before horizontal scaling.

### OrgState has no eviction

(`src/services/OrgState.js:13`) — `byOrg` accumulates one `{ sm, ma }` pair per org that has ever connected. In a very long-running server with many orgs, this grows unbounded. Not a concern at current scale.

### Message ring buffer capped at 500 per org

(`src/services/MessageAggregator.js:23`) — in-memory only; high-volume events that exceed 500 messages will drop the oldest from the live feed (DB still has everything).

### `pingInterval` / `pingTimeout`

Default values (25s interval, 20s timeout) are in effect — we don't override them. A Railway container with a 30s health-check timeout would not interfere with these. If Railway's load balancer has an idle TCP timeout shorter than ~45s, WebSocket connections could be killed silently — Railway's default idle timeout is 60s, so this is fine.

---

## Gotchas & failure modes

**1. `origin: true` in production reflects any origin**
`src/server/index.js:35` sets `origin: true` in production. Per the Socket.IO docs, `origin: true` reflects the request's `Origin` header back as `Access-Control-Allow-Origin`. Combined with `credentials: true`, this means *any* origin can make credentialed socket connections if it has the user's cookie. For a browser-based SaaS where the cookie is `sameSite: lax` and `httpOnly: true`, the practical risk is low — but it violates the "allowlist" best practice. The correct production value is `process.env.APP_URL` or the Railway domain.

**2. Auth middleware does a synchronous DB round-trip on every handshake**
`validateSession(db, sessionId)` fires a Postgres query on every new WebSocket connection. Under connection storms (many users reconnecting after a deploy), this can exhaust the DB connection pool. The query joins three tables. No caching layer exists.

**3. `useSocket.js` hook is a stale/broken file**
`client/src/hooks/useSocket.js` creates its own socket without `withCredentials: true` (`line 20-22`). In production, the `zoomchat_session` cookie will not be sent on the WebSocket handshake → the auth middleware will return `'Not signed in'` → the socket will fail with `connect_error`. If any component still imports `useSocket` instead of `useSocketContext`, it will silently not work in production. The canonical socket is `SocketContext.jsx`.

**4. `moderationUpdate` has no authorization**
Any authenticated user in the org can emit `moderationUpdate` with any payload and it will be broadcast to all org clients (`socketHandler.js:109-115`). There is no role check (admin vs viewer). A viewer could clear the featured message or empty the moderation queue.

**5. `connect_error` redirect is too aggressive**
`SocketContext.jsx:59-63` redirects to `/signin` on ANY `connect_error` whose message matches `/sign|session/i`. Server errors unrelated to auth (e.g., DB outage causing `'Auth check failed'`) could also redirect users to the login page mid-session, even though they are authenticated.

**6. Moderation state lost on reconnect**
When a client reconnects, `ModerationContext.jsx:31` emits `getModerationState` and the server returns the current state from `moderationStateByOrg`. However, if the *server* restarts between the client's disconnect and reconnect, `moderationStateByOrg` is empty — the client gets a blank moderation state. There is no DB-backed recovery for moderation state.

**7. Batched emit timer not cleared on server shutdown**
`MessageAggregator._flushTimer` is a `setTimeout` handle (`src/services/MessageAggregator.js:37`). On graceful shutdown (SIGTERM), in-flight batches may be dropped. Node.js will exit before the 100ms timer fires. This is acceptable for a dev/stage environment but could drop messages in a mid-event deploy.

**8. Reconnection during trial exhaustion**
When `trialExhausted` fires and bots are disconnected, if the client is mid-reconnect at that moment, it may miss the `trialExhausted` event. The UI would show the quota countdown at zero but not display the upgrade modal. The next `trialUpdate` tick (30s) would not re-fire `trialExhausted` because `exhaustedOrgs` has already been populated (`src/services/TrialEnforcer.js:109`).

**9. Client listens for both `newMessage` and `newMessageBatch`**
`SocketContext.jsx:88-94` handles `newMessage` "for resilience if a stale server is ever in the chain." However, the server comment (`MessageAggregator.js:136`) says it "no longer emits per-message `newMessage`". If both events fire (during a partial deploy or edge case), messages would be duplicated in the UI — there is no dedup by message ID on the client.

---

## Risks / TODOs in our current code

| Risk | Severity | File:line |
|------|----------|-----------|
| `origin: true` in production reflects any origin instead of an allowlist | Medium | `src/server/index.js:35` |
| `useSocket.js` lacks `withCredentials: true` — broken in production, but may still be imported somewhere | High | `client/src/hooks/useSocket.js:20` |
| `moderationUpdate` event has no role/permission check | Medium | `src/server/socketHandler.js:109` |
| `connect_error` redirect matches too broadly — DB auth failures send users to login | Low-Medium | `client/src/contexts/SocketContext.jsx:61` |
| `moderationStateByOrg` is in-process only — lost on restart, invisible to a second instance | Medium | `src/server/socketHandler.js:21` |
| `OrgState.byOrg` has no eviction — unbounded growth in long-running multi-org server | Low (current scale) | `src/services/OrgState.js:22` |
| Auth middleware DB query on every handshake — no caching, potential pool exhaustion at scale | Low-Medium | `src/server/socketHandler.js:38-50` |
| `TrialEnforcer.exhaustedOrgs` is in-memory — trial exhaustion not re-signaled on reconnect | Low | `src/services/TrialEnforcer.js:109` |
| `_flushTimer` not cleared on SIGTERM — last 100ms of messages in an active batch may be dropped | Low | `src/services/MessageAggregator.js:37` |
| Scaling to 2+ Railway replicas without Redis adapter will silently break all real-time delivery | Critical (if scaled) | `src/server/index.js:32` — no adapter configured |
| `tenant_id` hardcoded to `'ryteproductions'` in DB inserts — multi-tenant isolation incomplete at DB level | Medium | `src/services/MessageAggregator.js:144` |

---

## Key links

- Socket.IO v4 docs home: https://socket.io/docs/v4/
- Server API reference: https://socket.io/docs/v4/server-api/
- Server options (all constructor opts): https://socket.io/docs/v4/server-options/
- Client options: https://socket.io/docs/v4/client-options/
- Middlewares (auth patterns): https://socket.io/docs/v4/middlewares/
- Rooms: https://socket.io/docs/v4/rooms/
- CORS handling: https://socket.io/docs/v4/handling-cors/
- Multiple nodes / sticky sessions / adapters: https://socket.io/docs/v4/using-multiple-nodes/
- Connection state recovery: https://socket.io/docs/v4/connection-state-recovery/
- Troubleshooting connections: https://socket.io/docs/v4/troubleshooting-connection-issues/
- 4.7.0 changelog: https://socket.io/docs/v4/changelog/4.7.0
- 4.8.0 changelog: https://socket.io/docs/v4/changelog/4.8.0
- GitHub releases: https://github.com/socketio/socket.io/releases
