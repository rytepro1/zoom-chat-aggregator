# Chat Capture Architecture — Decision Record

**Date:** May 2026
**Status:** Decision made, implementation pending.

## Context

The Zoom Chat Aggregator needs to capture chat messages from live Zoom
meetings during events. The actual deployment scenario:

- **Operator (RYTE Productions):** runs the moderator console under our
  own Zoom developer credentials.
- **Meeting hosts:** typically *external clients and partners* (e.g.
  `@ugenticai.com`) — different Zoom accounts, different orgs, not under
  our administrative control.
- **Per-event count:** several concurrent meetings (parallel breakout
  rooms or multi-stage events) whose chat we want unified into a single
  feed for our in-studio on-air host.

## The realization

Zoom offers two completely different mechanisms for getting at meeting
chat data, and they suit very different use cases:

| | **RTMS (Real-Time Media Streams)** | **Meeting SDK / Video SDK bot** |
|---|---|---|
| Initiated by | Zoom (host-side) | Us (participant-side) |
| Trigger | Webhook to our endpoint when host's meeting starts RTMS | We programmatically join the meeting as a participant |
| Auth model | Our app installed on the host's Zoom account | Meeting ID + passcode + our SDK credentials |
| Cross-org support | ❌ Requires app install on each host org | ✅ Any meeting we have credentials for |
| Bot visible in meeting | No (server-to-server, no participant added) | Yes (a participant entry appears, can be named) |
| Best for | Compliance recording in a single org, internal-only deployments | Third-party meeting assistants (Otter, Fireflies, Read.ai, etc.) |

The existing app's `MeetingManager` UI (accepts a Meeting ID and passcode)
**implies the SDK-bot model.** The existing server-side code
(`src/rtms/RTMSManager.js`, `src/routes/webhook.js`) **implements the
RTMS model** — and the `/api/meetings/connect` route currently ignores
the passcode and falls through to mock mode. The two were never
end-to-end functional; what the demo showed was mock messages.

Because our actual hosts are external client accounts, **RTMS cannot
serve this use case** without per-partner pre-coordination to install our
app on every partner's Zoom account — operationally untenable.

## Decision

**Migrate the chat ingestion layer from RTMS to a Zoom Meeting SDK
(or Video SDK) bot participant.**

The bot model matches our existing UX (operator pastes a Meeting ID +
passcode, the app "joins" that meeting and starts capturing chat) and
removes the cross-org install barrier.

## What needs to be researched / decided

These open questions need answers before implementation begins. Most
require a follow-up conversation with Zoom developer support — but
**asking about the Meeting SDK, not RTMS**.

1. **Which SDK exactly?** Zoom publishes several:
   - **Meeting SDK for Linux** — headless, designed for server bots.
     Most likely fit.
   - **Video SDK** — newer, more bot-friendly, but a different product
     line with separate licensing.
   - **Web Meeting SDK** — runs in a browser; would require us to host
     a hidden browser-based join, more brittle.
2. **Licensing model.** Meeting SDK Bots typically require dedicated
   licensing distinct from the basic Marketplace App. Need pricing.
3. **Bot visibility.** Can we name the bot (e.g. "Chat Capture by
   RYTE") and optionally hide it from the gallery view? What's the
   minimum-friction UX for the meeting host?
4. **Host approval.** Some Zoom security settings auto-admit bots, others
   require a host to admit each one. Need to know what the host needs to
   do on their end (probably nothing, but verify).
5. **Bandwidth.** A Meeting SDK bot may technically subscribe to audio
   and video streams even if we discard them. Confirm we can run "chat
   only" or what the resource cost is at scale (say 5–10 concurrent
   meetings).
6. **Newer Zoom features.** Zoom has been blurring the line between RTMS
   and bots — check whether there is now an "RTMS Bot" or
   "invite-as-participant RTMS" pattern that would give us RTMS-style
   data flow with bot-style cross-org access. If so, that might be the
   best of both worlds.

## What this means in the short term

- **The current app continues to work in mock mode** for demos and
  internal testing — no immediate user-facing change.
- **Do not pursue RTMS access from Zoom support any further** unless
  scenario changes (i.e., RYTE starts hosting the meetings itself).
- **Open a new line of conversation with Zoom developer support** about
  the Meeting SDK bot approach.

## Implementation effort estimate (rough)

Once Zoom-side answers are in:

| Phase | Effort |
|---|---|
| Spin up a minimum viable Meeting SDK bot that joins one meeting and prints chat to the console | 1–2 days |
| Integrate the SDK's chat events into the existing `MessageAggregator` (replacing the RTMS path) | half a day |
| Multi-meeting orchestration (spawning / tracking N concurrent bots) | 1 day |
| Production hardening: reconnect logic, error handling, observability | 1–2 days |
| **Total** | **~5 days of focused work** |

## Sketch of the bot-based architecture

```
[Operator types Meeting ID + Passcode into UI]
                  │
                  ▼
[Express server: POST /api/meetings/connect]
                  │
                  ▼
[BotManager.spawn(meetingId, passcode, roomName, roomColor)]
                  │
                  ▼
[New Meeting SDK process joins the meeting as a participant]
                  │   (one process / one bot instance per meeting)
                  ▼
[Bot receives chat events from SDK callback]
                  │
                  ▼
[Forwarded to MessageAggregator → broadcast to React clients]
```

The `BotManager` replaces the current `RTMSManager`. The
`MessageAggregator`, the webhook signature handler, and the React UI all
stay essentially unchanged — chat messages flow into the same internal
pipeline regardless of how they were captured.

The current `webhook.js` route can stay in place for the day RYTE
itself hosts a meeting and wants to receive RTMS events alongside the
bot streams.
