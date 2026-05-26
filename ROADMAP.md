# Roadmap

Planned improvements captured at the end of the May 2026 revival session.
Each item is self-contained — a future session can pick any one and ship it.

---

## 0. Migrate chat ingestion from RTMS to Meeting SDK bot (foundational)

**Discovered May 2026 after the revival.** The current app's
`MessageAggregator` is only ever fed by mock data because the actual
chat capture path was never functional end-to-end. The intended path
(RTMS) doesn't fit RYTE's real use case (capturing chat from meetings
hosted by *external client accounts*), because RTMS requires the
Marketplace App to be installed on the hosting account.

Full architecture decision and rationale:
[`docs/CHAT-CAPTURE-ARCHITECTURE.md`](docs/CHAT-CAPTURE-ARCHITECTURE.md).

**Direction:** rebuild the chat ingestion layer to use the Zoom Meeting
SDK (likely the Linux Meeting SDK) to spawn a bot participant per
meeting. The operator's existing "paste Meeting ID + passcode" UX
becomes real: the server spawns a bot that joins each meeting and pipes
chat events into the existing `MessageAggregator`.

**Blocked on:** build-vs-buy decision (Recall.ai vs in-house Linux
Meeting SDK + Docker stack). Most of the original "open questions" were
answered in the May 2026 docs research — see the "What we now know"
section of `docs/CHAT-CAPTURE-ARCHITECTURE.md` for the full findings,
including the new OBF chaperone requirement Zoom rolled out March 2026.

**Effort:**
- **Path A (Recall.ai):** ~1 day prototype, ~3 days production. ~$75–$100/month
  at expected scale.
- **Path B (build in-house):** ~2–3 weeks. ISV pricing TBD with Zoom sales.

Either path replaces the existing `src/rtms/RTMSManager.js` with a new
`BotManager`; the React UI, message aggregation, moderation, and display
layers stay the same.

**This issue takes priority over everything else below** — until chat
capture is real, the other items are polish on a demo.

---

## 1. Display window text size doesn't respond to the font-size slider

**Symptom.** Changing the "Base Font Size" slider (or any other typography
setting) in the main window's settings panel has no visible effect on the
pop-out Display View. Settings work fine within the main window.

**Root cause — two compounding issues.**

1. **State isolation.** [`client/src/pages/DisplayView.jsx`](client/src/pages/DisplayView.jsx)
   wraps itself in its own `<SettingsProvider>` (line 215). That provider
   reads from `localStorage` once at mount and never re-reads. The main
   window's settings panel writes to the same `localStorage` key but
   nothing notifies the display window, so its in-memory state goes stale.
2. **Hardcoded sizes in display mode.** The `displayMode` branch of
   [`client/src/components/ChatMessage.jsx`](client/src/components/ChatMessage.jsx)
   (lines 65–112) uses Tailwind utilities like `text-xl` and `text-sm` for
   sender/message text. These do not consult `--message-font-size` or
   `--base-font-size`, so even if settings sync correctly, the rendered
   text size in the display view won't change.

**Suggested fix (in order).**

1. Add a `storage` event listener in `SettingsContext.jsx` that re-reads
   the `chatAggregatorSettings` key when another window updates it. The
   `storage` event fires in *other* windows of the same origin — so it
   syncs the display view without re-firing on the writer itself. Roughly:
   ```js
   useEffect(() => {
     const handler = (e) => {
       if (e.key === 'chatAggregatorSettings' && e.newValue) {
         setSettings({ ...defaultSettings, ...JSON.parse(e.newValue) });
       }
     };
     window.addEventListener('storage', handler);
     return () => window.removeEventListener('storage', handler);
   }, []);
   ```
2. Make `ChatMessage`'s `displayMode` branch read `var(--message-font-size)`
   and `var(--base-font-size)` (with a multiplier, since display view should
   render larger than the main feed). Replace the hardcoded `text-xl` etc.
   with inline `style={{ fontSize: ... }}` derived from settings.

**Design decision to make.** Should the display view inherit the main
window's typography settings exactly, or scale them up by a fixed factor
(e.g. 1.5×) for readability on a TV from across a studio? Recommend a
multiplier configurable in settings (a "Display view scale" slider, 1.0×
to 3.0×, default 1.5×).

**Files.** `client/src/contexts/SettingsContext.jsx`,
`client/src/components/ChatMessage.jsx`, possibly
`client/src/components/SettingsPanel.jsx` (for the new scale slider).

**Effort.** ~1 hour including the new scale setting.

---

## 2. Save & export individual chat messages

**Goal.** Mid-event, the operator wants to flag standout audience messages
(funny, insightful, on-brand) and pull them out as shareable assets for
marketing — social posts, recap emails, post-event highlight reels.

**Suggested UX.**

- Add a **bookmark / save** action to `ChatMessage` (alongside the existing
  Highlight / Queue / Feature buttons). A simple star or bookmark icon.
- Saved messages appear in a new **Saved** tab in the sidebar (next to
  Connect / Moderate / Rooms in [`client/src/App.jsx`](client/src/App.jsx)).
- From the Saved tab, each message gets:
  - **Copy as text** — plain-text with attribution, e.g.
    `"That was incredible." — Jane Doe (Audience Room A), 7:42 PM`
  - **Export as image (PNG)** — render the message as a branded quote card.
    Use the app's current theme colors. Optionally include logo, room
    name, and timestamp. Generate via HTML → canvas (use
    `html2canvas` or `dom-to-image`).
  - **Bulk export (CSV / JSON)** — download all saved messages for the
    session as structured data.

**Storage.**

- Server-side persistence is required so saves survive a process restart.
- Each saved message gets stored in the same store as the full chat log
  (see issue #3) with a `saved: true` flag and an optional `note` field
  the operator can attach.
- New REST endpoints on the Express server:
  - `POST /api/messages/:id/save`
  - `DELETE /api/messages/:id/save`
  - `GET /api/saved` (returns all saved messages)
- New socket events: `messageSaved` / `messageUnsaved` so other connected
  windows (display view, second moderator) stay in sync.

**Design decisions to make.**

- Image export styling: match the in-app theme, or use a dedicated "card"
  template with the brand logo? (Recommend: dedicated template with logo
  baked in — looks more polished on social.)
- Should the export include the speaker's avatar / initials circle?
- Aspect ratio: 1:1 (Instagram square), 9:16 (stories), 1.91:1 (Twitter
  card)? Pick a default and let users switch.

**Files.** `src/services/MessageAggregator.js` (storage + retrieval),
`src/routes/` (new routes file for `/api/saved`),
`client/src/components/ChatMessage.jsx` (save button),
new `client/src/components/SavedPanel.jsx`,
`client/src/App.jsx` (new tab).

**Effort.** ~4–6 hours. Image export is the biggest piece; everything
else is straightforward CRUD.

---

## 3. Persistent chat log + smart exit dialog

**Goal.** Two related concerns:

- **A. Crash safety.** If the app quits unexpectedly mid-event (laptop
  sleeps, app crashes, user accidentally hits ⌘-Q), the entire session's
  chat history is lost. The current
  [`MessageAggregator`](src/services/MessageAggregator.js) holds messages
  in a 500-message in-memory ring buffer with no disk backing.
- **B. Post-event review.** The operator wants a complete record of an
  event — every chat message, with sender/room/timestamp — for after-the-
  fact review, editorial work, or analytics.

### A. Storage layer

**Recommended: SQLite.** Lightweight, ships with Node via `better-sqlite3`,
queryable, perfect for this volume (an event might generate 10K–100K
messages — trivial for SQLite).

- One DB file per session, stored at
  `~/Library/Application Support/ZoomChat/sessions/<session-id>.db`
- Schema:
  ```sql
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,
    sender TEXT NOT NULL,
    room TEXT NOT NULL,
    room_color TEXT,
    meeting_id TEXT,
    content TEXT NOT NULL,
    saved INTEGER DEFAULT 0,
    note TEXT
  );
  CREATE TABLE session_meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  ```
- `MessageAggregator.addMessage()` writes to SQLite on each insert.
- On server startup, the most recent un-ended session is reopened (so a
  restart resumes the same log).

### B. Session model

Introduce explicit **sessions**:

- A session is created when the operator first connects a meeting, OR
  manually via a "Start session" button.
- A session ends when the operator explicitly clicks "End session" (or via
  the smart exit dialog below).
- Each session has: id, name (operator-editable), started_at, ended_at,
  and the per-session SQLite DB.
- Past sessions are browsable in a new "Sessions" panel — pick a past
  event, view the full log, re-export saved messages, generate a session
  report.

### C. Smart exit dialog (UX rework)

Currently `applicationShouldTerminateAfterLastWindowClosed` returns `true`
in [`launcher-v2/Sources/main.swift`](launcher-v2/Sources/main.swift), so
closing the main window quits the app and (because the Node server is a
child process) ends the session. That's the wrong default for a live event
tool. Recommend:

- **Closing the window** (red X or ⌘-W) just *hides* the window. App and
  Node server keep running; session continues recording. Re-show via
  clicking the Dock icon or `Window > Zoom Chat Aggregator`.
- **⌘-Q** or the Dock icon's "Quit" menu prompts:
  > **End the current session?**
  > The chat log will be finalized and saved. To keep recording, choose
  > "Keep Running" (the app will stay in the background).
  >
  > [Keep Running] [End Session & Quit]
- "End Session & Quit" writes a `session_meta.ended_at` row, then terminates.
- "Keep Running" hides the window but leaves the server up.
- If there is no active session, no dialog — just quit normally.

**Optional polish.** Add a menu bar icon (à la Slack / Backblaze) so the
user can see at a glance whether a session is recording, and quickly bring
up the window or end the session without finding the Dock icon.

### Files

- `src/services/MessageAggregator.js` — write-through to SQLite,
  reopen-on-startup logic.
- New `src/services/SessionManager.js` — session lifecycle, DB file
  management.
- New `src/routes/sessions.js` — REST endpoints for listing / loading /
  exporting past sessions.
- `package.json` — add `better-sqlite3` dependency.
- `launcher-v2/Sources/main.swift` — change
  `applicationShouldTerminateAfterLastWindowClosed` to return `false`,
  add `applicationShouldTerminate` to prompt the exit dialog. Implement
  window-hide-on-close in an NSWindowDelegate.
- `client/src/App.jsx` — new "Sessions" tab, session status indicator in
  the header.

### Design decisions to make

- Should sessions auto-start when the first meeting connects, or only on
  explicit operator action? (Recommend auto-start; less to remember.)
- How long to retain old session DB files? (Recommend: forever, until the
  user manually deletes from the Sessions panel — disk is cheap, an
  event's log is maybe 5–20 MB.)
- What to do if the bundled .app is upgraded — old sessions live at
  `~/Library/Application Support/ZoomChat/sessions/`, outside the bundle,
  so they survive cleanly. Document this somewhere.

**Effort.** ~6–10 hours. The SQLite layer and session model are the bulk;
the launcher window-behavior changes are an hour.

---

## Suggested order

0. **Issue #0 (chat ingestion rebuild)** — blocking everything else for
   real production use. Pursue once Zoom support has answered the
   Meeting SDK questions.
1. **Issue #1 (font sync)** — small, isolated, immediate win. Safe to
   do any time, independent of #0.
2. **Issue #3 (persistence + exit dialog)** — biggest infrastructure
   change. Once messages are durable, everything else gets safer.
3. **Issue #2 (save/export)** — builds naturally on top of #3's storage
   layer (a "saved" flag is just one more column).

#1, #2, #3 are roughly 1–1.5 days of focused work end-to-end. #0 is its
own ~5 days plus whatever back-and-forth with Zoom takes.
