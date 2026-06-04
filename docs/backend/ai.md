# AI Auto-Responder — Backend Reference

> The **Smart Auto-Responder**: detects recurring audience questions in the
> live chat, asks the moderator for the canonical answer, then auto-replies
> to matching questions — and self-heals (pauses + flags the moderator) when
> attendees report the answer is wrong or broken. Phase A of the AI co-pilot.

Pinned: `@anthropic-ai/sdk ^0.70`, model **`claude-haiku-4-5`** (cheap, fast
classification of high-volume chat). Off by default per org; inert entirely
when `ANTHROPIC_API_KEY` is unset.

---

## 1. Why this exists

Operators repeatedly field the same audience questions during a show
("Where's the VIP session link?", "What's the link to the educational
material?"). At scale this is unmanageable and questions get missed. The
auto-responder offloads the repetitive ones while keeping a human in the
loop for the actual answers — the bot **never invents a factual link**.

## 2. The decision boundary (safety)

The model only **advises**. Every consequential action — send an
auto-reply, create a pending FAQ, pause a FAQ — is made by **deterministic
JS** in `AIResponder` using the model's structured output plus the org's
thresholds. Guardrails:

1. **Human-in-the-loop answers** — a FAQ only becomes `active` (auto-replying)
   when a moderator supplies/approves the answer, or pre-seeds it. Detection
   never produces an answer.
2. **High match threshold** (`ai_match_threshold`, default `0.85`) before any
   auto-reply. The classifier is explicitly told to be strict about
   similar-but-different links ("VIP link" ≠ "educational material link").
3. **Throttle + per-asker dedup** — a `(faq, room)` cooldown
   (`ai_cooldown_seconds`, default 75s) stops the bot posting the same answer
   repeatedly; a per-asker set means no individual is answered twice.
4. Reuses the existing **20/min per-bot** token-bucket + `sent_messages`
   audit in `RecallBotManager.sendChatToMeeting`.
5. **Self-healing auto-pause** on credible negative feedback (≥2 complaints,
   or one complaint at ≥0.9 confidence).
6. **Off by default** (`organizations.ai_enabled = false`); master toggle +
   per-FAQ pause/dismiss.
7. **Fail-safe** — any AIClient/LLM error returns no classification, so the
   bot simply takes no action; an inference failure can never cause a send.
8. Auto-replies are **labelled** in the feed (`type: 'ai_reply'`, 🤖 pill)
   and every detection/send/suppression/pause is written to `ai_faq_events`.

## 3. Components

| File | Role |
|---|---|
| `src/services/AIClient.js` | Anthropic wrapper. `classifyBatch({candidates, faqs})` → per-message `{classification, normalizedIntent, matchedFaqId, matchConfidence, relatesToFaqId, complaintConfidence, complaintType}` via **forced tool use** (`record_classification`). Prompt-cached system + FAQ blocks; `temperature 0`; 12s timeout; `maxRetries 1`; fail-safe → `{results: []}`. |
| `src/services/AIResponder.js` | Per-org engine. Created in `OrgState.get()`, injected into the org's `MessageAggregator`. Owns the buffer, tick loop, gating logic, FAQ state, and all `ai:*` socket emits. |
| `src/routes/ai.js` | `/api/ai/*` REST (settings + FAQ CRUD/approve/pause/resume/seed/events). |
| `client/src/contexts/AIContext.jsx` | Subscribes to `ai:*`; exposes REST actions. |
| `client/src/components/AIPanel.jsx` | Operator "AI" sidebar tab. |

## 4. Pipeline

```
inbound chat ─► RecallBotManager.handleChatEvent (now also extracts participant.id)
            ─► MessageAggregator.addMessage  (type 'chat')
                  └─► aiResponder.ingest(msg)        ← cheap local pre-filter
                        • drops everything that isn't a plausible question/complaint
                        • buffers {id, meetingId, participantId, sender, text}
                  ── every ~6s (or buffer ≥ 20) ──► _tick()
                        AIClient.classifyBatch(candidates, activeAndPendingFaqs)
                        deterministic gating:
                          question → ACTIVE faq, conf ≥ threshold → _autoReply()
                          question → no faq, recurring intent     → _createPendingFaq()
                          complaint → ACTIVE faq, credible        → _onComplaint() → pause
```

`_autoReply` posts the answer to the whole room via
`recallBotManager.sendChatToMeeting(orgId, meetingId, answer)` (throttled by a
`(faq, room)` cooldown), mirrors the send into the feed as `ai_reply`, and
updates counters/events.

### Recurring detection

Unmatched questions accumulate by `normalizedIntent` (in-memory, per session).
When **distinct askers** reach `ai_recurring_threshold` (default 3) a `pending`
FAQ is created and `ai:faqPending` fires — the moderator sees "Needs your
answer". Counting *distinct askers* (not raw messages) avoids one person
spamming a question into a prompt.

### Reply delivery: public, throttled

Approved answers are posted to the **whole room** (Recall
`send_chat_message` `to: 'everyone'`) — works in meetings **and** webinars. A
`(faq, room)` cooldown (`ai_cooldown_seconds`) suppresses re-posting the same
answer so a popular question isn't answered repeatedly, and a per-asker dedup
set (keyed on the Zoom `participant.id`, captured off the inbound webhook)
means no individual is answered twice. (Per-asker **DM** delivery was
considered but dropped — Recall can't target individuals in webinars, which is
the core use case; see `recall.md` — `send_chat_message.to`.)

## 5. Data model (`src/db/index.js`)

- **`ai_faqs`** — session-scoped FAQ KB. `status`: `pending` (awaiting a
  moderator answer) | `active` (auto-replying) | `paused` (self-healed /
  moderator) | `dismissed`. `created_by_user_id` NULL = AI-detected; set =
  operator-seeded.
- **`ai_faq_events`** — append-only audit: `detected | auto_replied |
  suppressed | complaint | paused | resumed` (+ confidence, inbound text).
- **`organizations.ai_*`** columns — `ai_enabled` (default false),
  `ai_match_threshold` (0.85), `ai_cooldown_seconds` (75),
  `ai_recurring_threshold` (3).

Applied idempotently on boot (the existing `CREATE TABLE IF NOT EXISTS`
convention) — no migration framework.

## 6. Socket events (to `org:<id>`)

`ai:state` (connect hydrate: settings + all FAQs), `ai:settings`,
`ai:faqPending`, `ai:faqUpdated`, `ai:faqDismissed`, `ai:autoReplied`,
`ai:feedbackAlert`.

## 7. Config

- `ANTHROPIC_API_KEY` — unset → feature inert (no calls, no auto-replies).
- Per-org arming: an admin flips `ai_enabled` in the AI panel (or
  `PATCH /api/ai/settings`). Deploying with the key set is safe — every org
  is still off until explicitly armed.

## 8. Cost controls

Heuristic pre-filter (most chat never reaches the LLM) → 6s batch window →
per-org cap of 20 LLM calls/min → max 100 active+pending FAQs/session →
empty ticks skipped. Prompt caching on the stable system + FAQ blocks.

## 9. Tests

`test/AIResponder.test.mjs` — runs the engine in-memory (db null) with a
stubbed `AIClient` and a fake `recallBotManager`. Covers recurring-detection
threshold, approve→auto-reply→cooldown suppression, per-asker dedup,
self-healing pause, and the low-confidence precision guard. `npm test`.

## 10. Known interactions / future

- The logged "reseed bot-routing maps on startup" fix (ROADMAP) also helps
  auto-reply reliability after a Railway restart — separate commit.
- Fast-follows (same subsystem): **suggested reply drafts** (Claude drafts a
  reply for one-click operator send) and **AI moderation triage** (spam/abuse/
  urgent flags + feature suggestions), reusing `AIClient` + the AI panel.
