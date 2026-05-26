# Chat Capture Architecture — Decision Record

**Date:** May 2026
**Status:** Direction confirmed (Meeting SDK over RTMS); build-vs-buy
decision pending. See "Three viable paths" section below.

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

## What we now know (from Zoom docs research, May 2026)

The research that resolved most of the open questions is summarized
below. Full source URLs are at the bottom of this document.

### SDK choice — confirmed

- **Meeting SDK** is correct (Video SDK is for custom video sessions,
  not joining regular Zoom meetings).
- Within Meeting SDK, the **Linux Meeting SDK** is the right flavor —
  Zoom publishes an official
  [`meetingsdk-headless-linux-sample`](https://github.com/zoom/meetingsdk-headless-linux-sample)
  repo specifically for headless bot use. macOS and Windows SDKs are
  built around GUI clients.
- Our app runs on macOS but the bot subprocess should run in a
  **Docker Linux container** (locally via Docker Desktop on the
  operator's Mac, or on a server for scale).

### The OBF (On Behalf Of) requirement — the big change

As of **March 2, 2026**, Meeting SDK apps joining a meeting hosted by
an external Zoom account must use an **OBF token**. This means a Zoom
user who has previously OAuth-authorized our app must be present in
the meeting for the entire time the bot is in it. If they leave, Zoom
immediately disconnects the bot.

**Practical impact for RYTE:** This is workable, because a RYTE
producer or moderator is essentially always in the meeting anyway —
they just need to OAuth-authorize the app once. It's not "unattended
bot for arbitrary meetings" (that pattern is dead), but it is "the
producer who's already there can bring the chat-capture bot along."

The authorizing user does *not* need to be the meeting host — they can
attend as a regular participant. Their Zoom account does need to be
paid (Pro tier or higher).

### Bot UX

- Bot is a real participant; appears in the participant list. No
  "invisible" mode.
- Display name is settable at join time (recommend something clear
  like "Chat Capture by RYTE Productions" so hosts don't kick it).
- If the host has waiting rooms on (very common for external client
  meetings), someone has to **admit the bot manually**. There's no
  auto-admit.
- If the host has "Only authenticated users can join" enabled, the
  bot needs its own signed-in Zoom account to satisfy that rule.

### Chat-only operation — supported

The Linux SDK exposes `IMeetingChatController` with the
`onChatMsgNotification` callback. We can subscribe only to chat events
and ignore audio/video. Resource footprint is in the low-hundreds-of-MB
per bot — 5–10 concurrent bots on a single machine is realistic.

**Open question:** does subscribing only to chat (no audio/video)
avoid Zoom's recording-consent prompt? This matters for UX. The docs
suggest only raw audio/video access triggers the prompt, but it's
worth confirming with Zoom support.

### Node.js integration

The Linux Meeting SDK is **C++ only**. No first-party Node.js binding.

Realistic architecture:
- One Docker container per active meeting, based on the headless
  Linux sample.
- The C++ bot in each container opens a Socket.io / WebSocket
  connection back to our Node Express server and streams chat events
  as JSON.
- Our Node backend orchestrates lifecycle: mint OBF token → `docker
  run` the bot container with meeting ID + token as env vars → wait
  for chat events → on meeting end or OBF revocation, container exits
  and the backend cleans up.

### Pricing — needs sales conversation

Zoom does not publish per-bot or per-minute pricing. Real production
use is gated on their **ISV Partner Program**, which is negotiated.
Budget for a sales call before committing to in-house build.

For comparison, the third-party service Recall.ai publishes
**~$0.50–$0.70/bot-hour** as their list price. At RYTE's expected
scale (5 bots × ~30 hours/month) that's **~$75–$100/month**, which is
likely far cheaper than the operational cost of self-hosting Docker
containers and managing OBF flows in-house.

### RTMS — definitively the wrong tool

Re-verified during this research:
- RTMS still requires the host's org to enable RTMS account-wide and
  the host to approve real-time data sharing per meeting.
- There is **no** "RTMS for invited participants" mode. Non-hosts
  cannot initiate RTMS.
- RTMS data streams cover audio, video, and transcripts — but **not
  chat**. Even if RTMS worked for our hosting situation, it wouldn't
  give us what we need.

## Three viable paths

| Path | Description | Effort | Cost (est.) | Trade-offs |
|---|---|---|---|---|
| **A. Recall.ai (or similar)** | Third-party meeting-bot service. They handle OBF, Docker, SDK, multi-platform. We hit one HTTP endpoint per meeting. | ~1 day prototype, ~3 days to wire into existing UI | ~$75–$100/month at 5 bots × 30 hrs | Fastest. Vendor dependency. Loses fine-grained control. |
| **B. Build with Linux Meeting SDK** | Roll our own: Docker containers per bot, C++ bot processes, OBF flow, IPC to Node. | ~2–3 weeks | ISV pricing TBD with Zoom sales (likely $100s/month minimum) | Full control, own IP. Real engineering project. |
| **C. Park for now** | Keep mock mode for demos; defer real chat capture until a confirmed paying customer / scheduled show. | 0 days | $0 | No production capability. Fine if revenue isn't blocked on this. |

**Recommendation:** Path A (Recall.ai) for first production deployment.
Migrate to Path B later if/when economics, control, or roadmap
requirements demand it. Prototype-then-evaluate is cheaper than
build-then-discover-Recall-would've-worked.

## Open questions for Zoom developer support

If we pursue Path B (or even just want to negotiate better with
Recall.ai), these are worth asking Zoom directly:

- Is there any exception to the OBF chaperone rule for "trusted
  recording vendor" / "production-staff bot" use cases?
- Does chat-only subscription (no audio/video) avoid the recording-
  consent prompt?
- What's the ISV Partner Program rate for ~5–10 concurrent bots
  running ~30 hours/month?
- For "Only authenticated users can join," does the OBF user's
  identity satisfy the auth rule, or does the bot itself need to be a
  signed-in account?
- Is there a roadmap for officially supported Node.js bindings on the
  Meeting SDK?

## Source URLs

- [Meeting SDK landing](https://developers.zoom.us/docs/meeting-sdk/)
- [Linux Meeting SDK overview](https://developers.zoom.us/docs/meeting-sdk/linux/)
- [Meeting SDK auth model](https://developers.zoom.us/docs/meeting-sdk/auth/)
- [OBF token FAQ (official)](https://developers.zoom.us/docs/meeting-sdk/obf-faq/)
- [OBF transition blog](https://developers.zoom.us/blog/transition-to-obf-token-meetingsdk-apps/)
- [Headless Linux bot sample (official)](https://github.com/zoom/meetingsdk-headless-linux-sample)
- [Raw recording sample](https://github.com/zoom/meetingsdk-linux-raw-recording-sample)
- [Meeting SDK vs Video SDK comparison](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0064689)
- [Recall.ai's OBF explainer (third-party)](https://www.recall.ai/blog/zoom-obf)
- [Recall.ai's RTMS limitations explainer](https://www.recall.ai/blog/what-is-zoom-rtms)
- [Dev forum: anonymous join + chaperone rule](https://devforum.zoom.us/t/clarification-on-meeting-sdk-auth-changes-obf-tokens-anonymous-join-and-chaperone-rule/141617)

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
