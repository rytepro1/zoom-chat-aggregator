# Zoom RTMS Integration — Technical Brief

This document describes how the **Zoom Chat Aggregator** application uses
Zoom's Real-Time Media Streams (RTMS) feature, intended as a reference for
Zoom developer support when reviewing or enabling RTMS access on the
account.

---

## What the application does

The Zoom Chat Aggregator is a live-event production tool for AV /
broadcast teams (RYTE Productions). During a live event with **multiple
parallel Zoom meetings** — for example, a conference with several
breakout sessions running at the same time, or a hybrid event with
remote audience rooms in addition to the in-studio session — the
production team needs to see the chat traffic from **all rooms combined
into a single moderated feed** that the host can read on air.

Concretely:

- **Input:** Chat messages from multiple concurrent Zoom meetings.
- **Output:** A unified, real-time chat feed shown on a moderator's
  screen and on a secondary "display" screen (typically a confidence
  monitor in studio) that the on-air host reads from.
- **Operator workflow:** Moderator highlights, queues, and "features"
  individual chat messages for the host to read. Selected messages are
  enlarged on the in-studio display.

There is **no recording, no transcription, no audio or video capture** —
the application only consumes the **chat data stream** from RTMS. (We
ignore the audio and video streams that RTMS also emits.)

---

## How RTMS is used (technical details)

### Webhook events consumed

The application subscribes to these Zoom webhook events:

| Event | Purpose |
|---|---|
| `endpoint.url_validation` | One-time URL validation handshake at app registration. |
| `meeting.rtms_started` | Triggers a connection to the meeting's RTMS stream URL. The application reads `payload.object.rtms_stream_url` and opens a WebSocket to it. |
| `meeting.rtms_stopped` | Triggers a clean disconnect from that meeting's RTMS stream. |
| `meeting.started` | Logged for room-tracking only (no action). |
| `meeting.ended` | Triggers cleanup of any in-flight RTMS connection for that meeting. |

### Authentication

- **Webhook signature validation:** HMAC-SHA256 over
  `v0:{timestamp}:{request_body}` using the Webhook Secret Token,
  per the Zoom webhook documentation. Requests with stale timestamps
  (> 5 minutes) are rejected.
- **RTMS stream connection:** HMAC-SHA256 signature over
  `{meetingId}:{timestamp}` using the Marketplace App's Client Secret,
  per the RTMS authentication spec.

### Required credentials

The application is configured with three values from a Zoom Marketplace
App:

| Variable | Source |
|---|---|
| `ZOOM_CLIENT_ID` | App ID from the Marketplace App's "App Credentials" page. |
| `ZOOM_CLIENT_SECRET` | App Secret from the same page. Used for RTMS stream authentication. |
| `ZOOM_WEBHOOK_SECRET_TOKEN` | Webhook Secret Token from the app's "Feature → Event Subscriptions" page. Used for incoming webhook validation. |

### Data flow

```
[Zoom Meeting starts RTMS]
        │
        ▼
[Zoom posts meeting.rtms_started webhook] ──► [Our webhook endpoint]
                                                       │
                                                       ▼
                                            [Validate HMAC signature]
                                                       │
                                                       ▼
                                            [Read rtms_stream_url from payload]
                                                       │
                                                       ▼
                                            [Open WebSocket to stream URL]
                                                       │
                                                       ▼
[Zoom streams chat events] ────────────────► [Our app receives chat]
                                                       │
                                                       ▼
                                            [Display in unified feed]
```

When the meeting ends, `meeting.rtms_stopped` or `meeting.ended` fires
and we cleanly close the WebSocket.

### Required RTMS scopes

Based on Zoom's RTMS documentation, the Marketplace App needs at least:

- `meeting:read:meeting` (or equivalent — to verify meeting metadata)
- `rtms:read` and any chat-specific RTMS scope (e.g.,
  `rtms:meeting.chat:read`)
- Event subscriptions for the `meeting.rtms_started`,
  `meeting.rtms_stopped`, `meeting.started`, and `meeting.ended` events

The Marketplace App is a **Server-to-Server OAuth** app (no end-user
OAuth flow — the application authenticates as the publishing account).

---

## The multi-meeting / multi-host question

> *"Zoom says RTMS needs to be enabled on the account that's hosting the
> meeting, but the whole point is to aggregate chat from multiple
> meetings in multiple rooms."*

These two statements are not in conflict — they just need to be reconciled
correctly.

**How RTMS event routing actually works:**

1. RTMS is a feature of a **Marketplace App**, not of an individual user
   account. Enabling RTMS on the developer account allows that account
   to *publish* an app that has the RTMS capability.
2. When the published app is **installed on a user / org account**, that
   installation associates the app with that account's meetings. Future
   meetings hosted by accounts where the app is installed will fire RTMS
   webhooks **to the app's configured endpoint** (i.e., this
   application's `/webhook/zoom` URL).
3. Therefore, "RTMS needs to be enabled on the hosting account" really
   means: *the Marketplace App with RTMS capability needs to be
   installed on (or available to) each account whose meetings should
   stream*.

**The three valid deployment paths for our multi-room use case:**

| Path | How it works | When to use it |
|---|---|---|
| **A. Single host account** | All event meetings are scheduled and hosted under one Zoom user account (e.g., a dedicated "events" user). The app is installed once on that account, and *every* meeting hosted by it streams to our endpoint. | Simplest for a small production team controlling all the meetings themselves. |
| **B. Admin install at the organization level** | The app is admin-installed for the entire Zoom organization. All meetings hosted by any user in the org will stream. | When the event involves multiple internal hosts within the same Zoom org (e.g., several producers each hosting their own room). |
| **C. Per-account install** | Each external host individually installs the app on their own account. | Only when meetings are hosted by accounts outside the org and pre-coordination is possible. Not practical at scale. |

For RYTE Productions' typical use case (a producer running a single live
event with multiple breakout rooms), **Path A or B is the answer.** What
matters is that the app is installed on each account that hosts a
meeting we want to monitor; once it is, *all* meetings from that account
will fire RTMS webhooks to us.

---

## What we are asking Zoom to enable

For our **developer account** that publishes the Marketplace App:

1. **RTMS feature flag on the developer account** so we can create an
   app that requests RTMS scopes. (This appears to be the gating item
   currently blocking us — Zoom Developer Pack / RTMS preview enrollment.)
2. **Approval to install our RTMS-enabled Marketplace App on our
   production account(s)** so that meetings hosted by those accounts
   begin firing `meeting.rtms_started` webhooks to our endpoint.

We are not asking for:

- Recording capability
- Cloud transcript access
- Any audio or video data export
- Access to meetings hosted by external Zoom accounts outside our control

---

## Questions for Zoom support

If support needs more from us, the answer to each of the following is in
this document; we're listing them here so they can be addressed directly:

1. **What scopes are required?** See "Required RTMS scopes" above. We
   are happy to adjust to whatever scope names match the current RTMS
   spec.
2. **Which events do we subscribe to?** See "Webhook events consumed".
   The minimum set we need is `meeting.rtms_started` and
   `meeting.rtms_stopped`.
3. **What data leaves Zoom?** Only the chat text stream. We discard the
   audio and video RTMS streams.
4. **Where does data go?** Our self-hosted Node.js endpoint over HTTPS,
   not to any third party.
5. **What account model?** Server-to-Server OAuth Marketplace App,
   installed on the production account(s) under our control.

---

## Useful Zoom documentation links

- Real-Time Media Streams overview: <https://developers.zoom.us/docs/rtms/>
- RTMS webhook events (`meeting.rtms_started`, etc.): <https://developers.zoom.us/docs/api/meetings/events/>
- Marketplace App webhook signature validation: <https://developers.zoom.us/docs/api/webhooks/>
- Server-to-Server OAuth: <https://developers.zoom.us/docs/internal-apps/s2s-oauth/>

---

*Document prepared for Zoom Developer Support, May 2026. Application
source: <https://github.com/rytepro1/zoom-chat-aggregator>*
