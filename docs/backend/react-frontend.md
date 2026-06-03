# React 18 + React Router 7

> Declarative UI layer for the Chat Aggregator operator console and presenter display — pinned to `react@^18.3`, `react-dom@^18.3`, `react-router-dom@^7.13`.

---

## How we use it

### Entry point and router setup

`client/src/main.jsx` is the SPA entry. It mounts a single React root with `ReactDOM.createRoot` (the React 18 concurrent-mode API) and wraps the entire tree in `<React.StrictMode>` and `<BrowserRouter>`.

Provider nesting order (outermost first):

```
BrowserRouter
  AuthProvider          ← session cookie check via /api/auth/me
    SettingsProvider    ← localStorage settings + CSS var injection
      Routes
        /signin         ← RedirectIfAuthed guard
        /verify-email, /reset-password, /accept-invite  ← public
        /upgrade        ← RequireAuth guard
        /              ← RequireAuth → SocketProvider → App
        /display       ← RequireAuth → DisplayView (standalone providers)
```

`SocketProvider` is intentionally placed inside the auth guard so the WebSocket connection is never opened for unauthenticated users (`main.jsx:74`). It is also intentionally excluded from the `/display` route because `DisplayView` opens its own independent socket connection.

### Route structure (declarative / library mode)

We use React Router in **declarative mode** — `<BrowserRouter>`, `<Routes>`, `<Route>`, and `<Navigate>` only. No loaders, no actions, no data router. This is the correct choice: our data layer (Socket.IO events + REST calls in context providers) already handles all async data and pending states.

Key routes:

| Path | Component | Auth |
|---|---|---|
| `/signin` | `AuthPage` | `RedirectIfAuthed` |
| `/verify-email` | `VerifyEmailPage` | none |
| `/reset-password` | `ResetPasswordPage` | none |
| `/accept-invite` | `AcceptInvitePage` | none |
| `/upgrade` | `UpgradePage` | `RequireAuth` |
| `/` | `App` | `RequireAuth` + `SocketProvider` |
| `/display` | `DisplayView` | `RequireAuth` |

`RequireAuth` (`main.jsx:23-28`) gates on `useAuth().loading` — renders `<FullPageLoading>` while the initial `/api/auth/me` fetch is in flight, then redirects to `/signin` if no user, otherwise renders children. This prevents the flash-of-login-wall for already-authenticated users on hard refresh.

`RedirectIfAuthed` (`main.jsx:34-39`) is the inverse: if you are authenticated, visiting `/signin` immediately bounces you to `/`.

### Context architecture

We have 8 contexts, each owning a single domain:

| Context | File | What it owns |
|---|---|---|
| `AuthContext` | `contexts/AuthContext.jsx` | session user, org, login/logout/signup, refresh |
| `SettingsContext` | `contexts/SettingsContext.jsx` | UI prefs, CSS vars, cross-window sync via `storage` event |
| `SocketContext` | `contexts/SocketContext.jsx` | socket instance, messages (capped at 500), rooms, stats, trial state |
| `MeetingsContext` | `contexts/MeetingsContext.jsx` | connected bot meetings, connect/disconnect |
| `ModerationContext` | `contexts/ModerationContext.jsx` | highlight IDs, queue, featured message, server sync via socket |
| `SavedContext` | `contexts/SavedContext.jsx` | bookmarked messages, persisted via `/api/saved` |
| `SessionContext` | `contexts/SessionContext.jsx` | current show session name, past sessions |
| `RostersContext` | `contexts/RostersContext.jsx` | saved meeting-participant rosters |
| `PresenterNotesContext` | `contexts/PresenterNotesContext.jsx` | live production notes from moderator to talent |

`SocketProvider` nests all socket-dependent providers inside itself and passes the `socket` instance down as a prop (`SocketContext.jsx:159-173`):

```
SocketProvider
  SessionProvider(socket)
    MeetingsProvider(socket)
      ModerationProvider(socket)
        SavedProvider(socket)
          RostersProvider
            PresenterNotesProvider(socket)
```

This design lets each provider register socket event listeners on its own `useEffect` that fires when `socket` changes from `null` to live.

### Multi-window pattern: DisplayView

`App.jsx:83` opens `/display` via `window.open(...)` into a separate browser window. `DisplayView` is served by the same Vite/Express origin so it shares the same session cookie and `localStorage` key space.

`DisplayView` (`pages/DisplayView.jsx`) creates its **own** socket connection (`DisplayView.jsx:239`) and its own `SettingsProvider`, `ModerationProvider`, and `PresenterNotesProvider`. It does not use `SocketContext` at all.

Cross-window settings sync is achieved via the `storage` event in `SettingsContext.jsx:118-134`. When the operator changes a setting in the main window, `localStorage.setItem('chatAggregatorSettings', ...)` fires, which triggers the `storage` event in the display window, which re-reads and applies the new values including CSS variables.

### Socket data flow

`SocketContext.jsx` subscribes to these server events:

| Event | Handler |
|---|---|
| `connect` / `disconnect` | sets `connected` bool |
| `connect_error` | if error message matches `/sign\|session/i`, redirects to `/signin` |
| `initialState` | hydrates `messages`, `rooms`, `stats` |
| `newMessageBatch` | appends array, slices to 500; preferred high-volume path |
| `newMessage` | legacy single-message fallback |
| `roomAdded` / `roomRemoved` | adds/removes from `rooms` |
| `stats` | replaces stats object |
| `trialUpdate` | updates `remainingMinutes`, `usedMinutes`, `quotaMinutes` |
| `trialWarning` | sets `warningShown: true` |
| `trialExhausted` | sets `exhausted: true`, stores `upgradeUrl` |

Message filtering happens at the context level, not in the server emit: `filteredMessages` (`SocketContext.jsx:139-141`) is computed synchronously from `messages` and `selectedRoom`, then exposed as `messages` from the context. Consumers see only the current room's messages without a re-subscribe.

### Auth flow

`AuthContext.jsx` calls `GET /api/auth/me` on mount with `credentials: 'include'` to check the session cookie. All subsequent auth mutations (`signup`, `login`, `logout`) POST to `/api/auth/*` and then call `refresh()` to re-fetch `/me`. The context also adds `window.focus` and `visibilitychange` listeners so that when a tab regains focus, `/me` is re-fetched — this catches the "operator A upgraded the org plan, operator B's tab still shows trial-exhausted" stale-state case (`AuthContext.jsx:43-54`).

---

## Core concepts

### React 18 concurrent mode

We mount via `ReactDOM.createRoot` (`main.jsx:54`), which opts the app into concurrent mode. The practical effects:

- React may interrupt, pause, and restart rendering. **Component render functions must be pure** — no side effects, subscriptions, or DOM mutations in the function body.
- `useEffect` cleanup must mirror setup. `StrictMode` double-invokes effects in development (setup → cleanup → setup) to surface missing cleanup.
- State updates are automatically batched in React 18, even across multiple `setState` calls in async callbacks. This is new vs React 17 and means `setMessages(…)` + `setStats(…)` in the same event handler produce one re-render, not two.

### StrictMode

We are inside `<React.StrictMode>` (`main.jsx:55`). In development this means:

- Every component body runs **twice** per render.
- Every `useEffect` setup runs, then cleanup runs, then setup runs again.
- This reveals socket listeners that register twice (harmless in Socket.IO which deduplicates named listeners), and memory leaks from effects that don't clean up.
- Production is unaffected — no double-invoke in prod.

Current double-invoke in dev: `SocketContext.jsx` creates a socket in its `useEffect`, then the effect cleanup calls `newSocket.disconnect()`, then the socket is created again. In development you will see two `connect`/`disconnect` cycles in the browser console. This is expected.

### Context consumer re-renders

A component calling `useContext(SomeContext)` re-renders any time the `value` prop of that context's `Provider` changes, compared by `Object.is`. Because `SocketProvider` places a plain object literal as `value` (`SocketContext.jsx:145-156`), every state change in `SocketProvider` (e.g., a new batch of messages) causes all `useSocketContext()` consumers to re-render — including `App`, `ChatFeed`, `StatusBar`, and `SessionHeader`. This is acceptable for a live chat feed because those components need to re-render on new messages anyway.

Contexts that expose functions (e.g., `AuthContext`'s `signup`, `login`, `logout`) wrap those functions in `useCallback` so they have stable identity and do not cause spurious re-renders.

### useEffect cleanup pattern

Every socket subscription follows this pattern:

```js
useEffect(() => {
  if (!socket) return;
  socket.on('eventName', handler);
  return () => socket.off('eventName', handler);
}, [socket]);
```

Returning early when `socket` is null avoids registering listeners before the socket is ready. The cleanup `socket.off` removes the exact handler reference, preventing listener accumulation across re-runs.

---

## API / SDK surface we touch

### React 18

| API | Where used | Purpose |
|---|---|---|
| `ReactDOM.createRoot` | `main.jsx:54` | Concurrent-mode root mount |
| `React.StrictMode` | `main.jsx:55` | Dev double-invoke |
| `createContext(null)` | every `*Context.jsx` | Context creation |
| `useContext` | every consumer | Context reading |
| `useState` | all contexts, `App.jsx`, `DisplayView.jsx` | Local state |
| `useEffect` | all contexts | Socket subscriptions, API calls, CSS var injection |
| `useCallback` | `AuthContext`, `MeetingsContext`, `SavedContext`, etc. | Stable function identity |
| `useRef` | `DisplayView.jsx:21-22` | Scroll container, timeouts |

APIs we **do not** use (and do not need):

- `useMemo` — not used anywhere; context values are plain object literals
- `useTransition` / `startTransition` — no deferred state updates
- `useId`, `useDeferredValue`, `useSyncExternalStore` — not used
- `React.lazy` / `Suspense` — no code splitting; all routes are eagerly imported

### React Router v7 (declarative mode)

| API | Where used | Purpose |
|---|---|---|
| `BrowserRouter` | `main.jsx:56` | HTML5 history router |
| `Routes` | `main.jsx:59` | Route container |
| `Route` | `main.jsx:61-79` | Route definitions |
| `Navigate` | `main.jsx:27, 38` | Declarative redirect in guard components |

We import from `react-router-dom` (`main.jsx:3`), not `react-router`. In v7, `react-router-dom` re-exports all declarative APIs from `react-router`, so both import paths work. However, the official v7 migration guide recommends switching to `import from 'react-router'` going forward.

Hooks we do **not** use (but are available in our version):

- `useNavigate` — all navigation is handled by `<Navigate>` components or `window.location.href` redirects
- `useParams`, `useLocation`, `useSearchParams` — no parameterised routes yet
- `useMatch` — not used

Data-mode APIs not used (and not needed in declarative mode):

- `createBrowserRouter`, `RouterProvider`
- `loader`, `action`, `useLoaderData`, `useActionData`
- `useFetcher`

---

## Auth & secrets

There are no client-side secrets. The client is a Vite SPA — nothing in `client/` should ever contain API keys.

Auth state is a **session cookie** set by the Express server. The cookie is `HttpOnly` and never visible to JavaScript. The client proves identity by including `credentials: 'include'` on every fetch and on the Socket.IO connection (`SocketContext.jsx:43`).

Environment variables relevant to the client:

| Variable | Set by | Value |
|---|---|---|
| `import.meta.env.DEV` | Vite | `true` in `npm run dev`, `false` in production build |
| `VITE_*` (none currently defined) | `.env` | — |

In dev, `SOCKET_URL` resolves to `'http://localhost:3001'` (`SocketContext.jsx:12-14`). In production it resolves to `window.location.origin` — the same host that served the page — so the WebSocket connects to the Express/Socket.IO server on Railway.

The Vite dev server proxies `/api`, `/socket.io`, and `/webhook` to `localhost:3001` (`vite.config.js:8-18`) so the browser never has to cross origins in development.

---

## Webhooks / events

No webhook handling on the client. The server receives Recall.ai webhooks and Zoom RTMS events, then fans them out via Socket.IO to connected clients. The client is a pure consumer of socket events — it never registers webhooks.

---

## Version-specific notes

### react@18.3 (our pin)

- `createRoot` is stable and the only supported mount API. The legacy `ReactDOM.render` was removed from React 19 and logs deprecation warnings in 18.
- Automatic batching: `setState` calls in async callbacks (e.g., inside socket event handlers) are batched in React 18. This is a **behavioural change** from React 17 — in 17, async event handlers caused one render per `setState`. In 18, `setMessages(...)` and `setStats(...)` in the same `newMessageBatch` handler produce one render. This is what makes our batch approach viable.
- React 18 added `useId`, `useTransition`, `useDeferredValue`, `useSyncExternalStore`. We use none of them.
- React 19 (released Dec 2024) adds the Actions API, `use()` hook, and `<Context>` as a provider shorthand (instead of `<Context.Provider>`). We are on 18.3 and should not assume any React 19 APIs.

### react-router-dom@7.13 (our pin)

- We are in **declarative mode** — the safest, simplest upgrade from v6. Our usage (`BrowserRouter` + `Routes` + `Route` + `Navigate`) is virtually identical to v6.
- The `react-router-dom` package in v7 is a thin re-export layer over `react-router`. Both packages are maintained; the official guidance is to migrate imports to `react-router` eventually.
- v7.12.0 patched three security CVEs (CSRF in action processing, XSS via open redirects, XSS in ScrollRestoration SSR). None affect our declarative-mode-only usage since we have no actions, no ScrollRestoration, and our redirects are always to `/signin` (a local path).
- v7.13.0 added `crossOrigin` to `<Links>` — irrelevant to us (no `<Links>` in declarative mode).
- v7.15.0 stabilized the `unstable_useTransitions` hook as `useTransitions`. We do not use it.
- Current latest is 7.16.0 (May 2026). None of the changes between 7.13.0 and 7.16.0 affect declarative mode.

---

## Rate limits / quotas / scaling

React itself has no rate limits. Considerations specific to our usage:

- **Message cap**: `SocketContext.jsx:81` slices messages to the last 500 entries. This bounds memory. At 400 messages/sec (high-volume webinar), the cap is hit in ~1.25 seconds and the feed always shows recent messages. The display window has the same 500-message cap (`DisplayView.jsx:43`).
- **Re-render cost**: Every `newMessageBatch` causes all `useSocketContext()` consumers to re-render. The batching (server emits every 100ms) limits this to 10 renders/sec from socket events, regardless of message volume. This is intentional design in `SocketContext.jsx:77-85`.
- **localStorage quota**: `SettingsContext` serialises settings to `localStorage`. Typical settings JSON is ~500 bytes — negligible.
- **`storage` event cross-window sync**: The `storage` event only fires in **other** windows, not the window that wrote. If main and display window are the same window (unlikely but possible if user navigates to `/display` in the same tab), settings sync will not work.

---

## Gotchas & failure modes

### StrictMode double socket connect

In development, `SocketContext.jsx`'s `useEffect` runs twice (StrictMode). The socket connects, disconnects (cleanup), and reconnects. This causes two `Connected to server` log lines in dev. This is benign — production sees one connect. **Do not add `socket.disconnect()` guards to stop this; they will break production.**

### Context value object identity

`SocketContext.jsx:145-156` constructs the `value` object inline inside the render:

```js
const value = {
  socket,
  connected,
  messages: filteredMessages,
  ...
};
```

This creates a new object reference every render. All `useSocketContext()` consumers re-render on every state change in `SocketProvider`, even if the data they access did not change. For example, `StatusBar` re-renders every time a message arrives, even though it only reads `connected` and `stats`. This is currently acceptable because all consumers are lightweight. If a consumer becomes expensive, the fix is `useMemo` on the context value or splitting the context.

### visibilitychange listener leak in AuthContext

`AuthContext.jsx:47` adds an anonymous arrow function to `document.addEventListener('visibilitychange', ...)` but the cleanup at line 50 only removes the `focus` listener. The `visibilitychange` listener is never removed:

```js
// AuthContext.jsx:46-53
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
});
return () => {
  window.removeEventListener('focus', onFocus);
  // visibilitychange's anonymous handler can't easily be removed;
  // unmounting AuthProvider is also app-lifetime so this is fine.
};
```

The comment acknowledges this. Since `AuthProvider` is mounted for the lifetime of the app and only ever unmounts on full page unload, this is not a memory leak in practice. However, if `AuthProvider` is ever moved lower in the tree (e.g., for testing), it will leak the listener.

### DisplayView socket dedup with SocketContext

`DisplayView.jsx:239` creates a second socket connection independent of the one in `SocketContext`. If the display view is opened in the same tab (e.g., developer navigates to `/display` instead of popping it out), the user accumulates two sockets on the same page, and `SocketContext`'s socket events are wired to state that nothing renders. This is harmless but wasteful.

### useSocket.js is dead code

`client/src/hooks/useSocket.js` exists and duplicates most of `SocketContext`'s logic, but it is **not imported anywhere** in the codebase. It is an early prototype that was superseded by `SocketContext`. It also lacks `withCredentials: true` (`useSocket.js` vs `SocketContext.jsx:43`), meaning if it were ever used, the WebSocket handshake would fail in production (no cookie → server rejects auth).

### ModerationContext imports from ChatMessage

`ModerationContext.jsx:2` does:

```js
import { ModerationContext } from '../components/ChatMessage';
```

The actual `createContext` call lives inside `ChatMessage.jsx:5-6`. This is a circular and counterintuitive dependency: a context is owned by a component file rather than its context file. The context object itself is re-exported from `ChatMessage.jsx:13`. This pattern works at runtime but breaks the convention and makes it harder to tree-shake or mock in tests.

### Import path: react-router-dom vs react-router

`main.jsx:3` imports from `react-router-dom`:

```js
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
```

In React Router v7, the canonical import is `from 'react-router'`. `react-router-dom` still works and re-exports everything, but the package is a compatibility shim. Future v8 may change this.

### Fetch calls in MeetingsContext missing credentials

`MeetingsContext.jsx:56-65` (and the connect/disconnect calls) do not pass `credentials: 'include'` on fetch calls:

```js
const response = await fetch(`${API_URL}/api/meetings`);  // no credentials
```

`AuthContext.jsx` and `PresenterNotesContext.jsx` correctly pass `credentials: 'include'`. If the Express session middleware requires the session cookie for `/api/meetings` routes (as it should for a multi-tenant app), these fetch calls will return 401 in a cross-origin dev setup or if the cookie is `SameSite=None`. In the Vite dev proxy setup this is masked because all requests to `localhost:5173/api/*` are forwarded server-side, bypassing the browser's cookie rules. In production (Railway), the app is served from the same origin so `SameSite=Lax` cookies are included automatically — but this is fragile if the deployment topology ever changes.

Similarly, `SessionContext.jsx:27` and `SavedContext.jsx:28` are missing `credentials: 'include'` on their initial fetches.

---

## Risks / TODOs in our current code

| Risk | File:Line | Severity | Notes |
|---|---|---|---|
| `useSocket.js` dead code with broken auth | `hooks/useSocket.js:20` | Medium | Missing `withCredentials`. If imported, production auth breaks. Delete the file. |
| `ModerationContext` created in `ChatMessage.jsx` | `components/ChatMessage.jsx:5`, `contexts/ModerationContext.jsx:2` | Medium | Circular ownership; breaks mocking/testing. Move `createContext` to `ModerationContext.jsx`. |
| Missing `credentials: 'include'` on fetch calls | `contexts/MeetingsContext.jsx:58,69,111`, `contexts/SessionContext.jsx:27,62,77,87`, `contexts/SavedContext.jsx:28,63,77` | Medium | Masked by same-origin production deploy; will bite if topology changes or cookie policy hardens. |
| `visibilitychange` listener never removed | `contexts/AuthContext.jsx:46-51` | Low | Benign for now (app-lifetime provider). Will leak if `AuthProvider` is ever moved down the tree. |
| Context value object created inline | `contexts/SocketContext.jsx:145-156` | Low | All `useSocketContext()` consumers re-render on every state tick. Acceptable now; profile if perf degrades. |
| No `useMemo` on any context value | All `*Context.jsx` | Low | React renders all consumers on every provider state change. Fine while components are lightweight. |
| `import from 'react-router-dom'` | `client/src/main.jsx:3` | Low | Should migrate to `import from 'react-router'` per v7 canonical guidance. Not breaking now. |

---

## Key links

- React 18 reference: https://react.dev/reference/react
- React `useContext` docs: https://react.dev/reference/react/useContext
- React `useEffect` docs: https://react.dev/reference/react/useEffect
- React `StrictMode` docs: https://react.dev/reference/react/StrictMode
- React Router v7 home: https://reactrouter.com/home
- React Router v7 declarative mode install: https://reactrouter.com/start/library/installation
- React Router v7 modes comparison: https://reactrouter.com/start/modes
- React Router v6 → v7 upgrade guide: https://reactrouter.com/upgrading/v6
- React Router v7 changelog: https://reactrouter.com/start/changelog
- React Router v7 API reference: https://api.reactrouter.com/v7/
