import { randomUUID } from 'node:crypto';

/**
 * AIResponder — per-org engine for the Smart Auto-Responder
 * (docs/backend/ai.md). One instance per org, created in OrgState.get()
 * alongside { sm, ma } and injected into the MessageAggregator so the
 * existing inbound chokepoint (ma.addMessage) feeds it.
 *
 * Pipeline:
 *   ingest(msg)  — cheap local pre-filter; buffer plausible questions /
 *                  complaints. The bulk of event chat (reactions,
 *                  statements) is dropped here so the LLM never sees it.
 *   _tick()      — every ~6s (or when the buffer fills), classify the
 *                  buffered candidates with AIClient against the current
 *                  FAQ list, then act on the results in DETERMINISTIC code:
 *                    • question → active FAQ (>= threshold)  → auto-reply
 *                    • question → no FAQ, recurring intent    → pending FAQ
 *                    • complaint → active FAQ                 → self-heal
 *
 * Safety: the model only advises. Every send / pause / create decision is
 * gated here by the org's thresholds, a per-(faq,room) cooldown, and a
 * per-asker dedup set. Answers are always moderator-approved or
 * moderator-seeded — the bot never fabricates a factual link.
 */

const TICK_MS = 6_000;
const BUFFER_FLUSH_AT = 20;          // flush early once this many candidates queue
const MAX_CANDIDATES_PER_CALL = 40;  // cap one classify call's batch size
const MAX_BUFFER = 200;              // hard cap; drop + log beyond this
const LLM_CALLS_PER_MIN = 20;        // per-org cost guardrail
const MAX_FAQS = 100;                // per-session active+pending cap
const COMPLAINT_PAUSE_CONFIDENCE = 0.7; // min confidence for a credible complaint
const COMPLAINT_HARD_CONFIDENCE = 0.9;  // single high-confidence complaint pauses

// Cheap pre-filter signals. A message is sent to the LLM only if it looks
// like a question or a complaint; everything else is dropped for free.
const QUESTION_RE =
  /\?|\b(where|what|when|how|which|why|who|link|url|password|passcode|access code|access|join|register|registration|recording|replay|slides?|deck|material|download|sign\s?up|rsvp)\b/i;
const COMPLAINT_RE =
  /\b(wrong|broke|broken|doesn'?t work|does not work|not working|didn'?t work|did not work|404|expired|dead link|bad link|can'?t access|cannot access|isn'?t working|no longer works?|invalid)\b/i;

export class AIResponder {
  constructor({ db, io, orgId, ma, sm, recallBotManager, aiClient } = {}) {
    this.db = db || null;
    this.io = io || null;
    this.orgId = orgId || null;
    this.ma = ma || null;
    this.sm = sm || null;
    this.recallBotManager = recallBotManager || null;
    this.aiClient = aiClient || null;

    // Per-org settings (loaded from the organizations row).
    this.settings = {
      ai_enabled: false,
      ai_match_threshold: 0.85,
      ai_cooldown_seconds: 75,
      ai_recurring_threshold: 3,
    };

    this.faqs = new Map();           // faqId -> faq row (current session)
    this._sessionId = null;

    // Transient, session-scoped in-memory state.
    this._buffer = [];               // pending candidates awaiting classify
    this._tickTimer = null;
    this._intentAskers = new Map();  // normIntent -> Set(participantKey)
    this._intentToFaq = new Map();   // normIntent -> faqId (pending/active)
    this._throttle = new Map();      // `${faqId}:${meetingId}` -> lastSentMs
    this._answered = new Map();      // faqId -> Set(participantKey)
    this._llmWindowStart = 0;
    this._llmCallsInWindow = 0;
  }

  // ---------- lifecycle ----------

  /** Load settings + current-session FAQs. Parallels MessageAggregator.hydrate(). */
  async hydrate() {
    await this.loadSettings();
    this._sessionId = this.sm?.current?.id || null;
    await this._loadFaqs();
  }

  async loadSettings() {
    if (!this.db || !this.orgId) return;
    try {
      const { rows } = await this.db.query(
        `SELECT ai_enabled, ai_match_threshold,
                ai_cooldown_seconds, ai_recurring_threshold
           FROM organizations WHERE id = $1`,
        [this.orgId]
      );
      if (rows[0]) {
        this.settings = {
          ai_enabled: rows[0].ai_enabled === true,
          ai_match_threshold: Number(rows[0].ai_match_threshold ?? 0.85),
          ai_cooldown_seconds: Number(rows[0].ai_cooldown_seconds ?? 75),
          ai_recurring_threshold: Number(rows[0].ai_recurring_threshold ?? 3),
        };
      }
    } catch (err) {
      console.error(`[AIResponder ${this.orgId}] loadSettings failed:`, err.message);
    }
  }

  async _loadFaqs() {
    this.faqs.clear();
    this._intentToFaq.clear();
    if (!this.db || !this._sessionId) return;
    try {
      const { rows } = await this.db.query(
        `SELECT * FROM ai_faqs
          WHERE session_id = $1 AND org_id = $2 AND status <> 'dismissed'
          ORDER BY created_at ASC`,
        [this._sessionId, this.orgId]
      );
      for (const row of rows) {
        this.faqs.set(row.id, row);
        if (row.question_label) this._intentToFaq.set(normIntent(row.question_label), row.id);
      }
      console.log(`[AIResponder ${this.orgId}] hydrated ${this.faqs.size} FAQ(s)`);
    } catch (err) {
      console.error(`[AIResponder ${this.orgId}] _loadFaqs failed:`, err.message);
    }
  }

  // Detect a session change (operator ended the event + started a new one)
  // lazily so we don't need to wire into the session-end route. Clears all
  // transient state and reloads FAQs for the new session.
  async _syncSession() {
    const current = this.sm?.current?.id || null;
    if (current === this._sessionId) return;
    this._sessionId = current;
    this._buffer = [];
    this._intentAskers.clear();
    this._throttle.clear();
    this._answered.clear();
    await this._loadFaqs();
  }

  // ---------- ingest (the ma.addMessage hook) ----------

  /**
   * Called synchronously from MessageAggregator.addMessage for inbound
   * chat. Cheap pre-filter + buffer; never throws into the caller.
   */
  ingest(message) {
    try {
      if (!this.settings.ai_enabled || !this.aiClient?.isConfigured()) return;
      if (!message || message.type !== 'chat') return;
      const text = String(message.content || '').trim();
      if (!text || text.length > 400) return;
      if (!QUESTION_RE.test(text) && !COMPLAINT_RE.test(text)) return;

      // Don't ingest the bot's own outgoing messages echoed back.
      const botInfo = this.recallBotManager?.botsByMeeting?.get(message.meetingId);
      if (botInfo && message.sender && message.sender === botInfo.botName) return;

      if (this._buffer.length >= MAX_BUFFER) {
        // No silent caps — log what we drop.
        console.warn(`[AIResponder ${this.orgId}] buffer full (${MAX_BUFFER}) — dropping candidate`);
        return;
      }
      this._buffer.push({
        id: message.id,
        meetingId: message.meetingId || null,
        room: message.room || null,
        roomColor: message.roomColor || null,
        sender: message.sender || 'Unknown',
        participantId: message.participantId || null,
        text,
      });
      this._scheduleTick();
    } catch (err) {
      console.error(`[AIResponder ${this.orgId}] ingest error:`, err.message);
    }
  }

  _scheduleTick() {
    if (this._buffer.length >= BUFFER_FLUSH_AT) {
      this._flushTimer();
      this._tick();
      return;
    }
    if (!this._tickTimer) {
      this._tickTimer = setTimeout(() => this._tick(), TICK_MS);
    }
  }

  _flushTimer() {
    if (this._tickTimer) {
      clearTimeout(this._tickTimer);
      this._tickTimer = null;
    }
  }

  async _tick() {
    this._flushTimer();
    try {
      if (!this.settings.ai_enabled || !this.aiClient?.isConfigured()) {
        this._buffer = [];
        return;
      }
      await this._syncSession();
      if (this._buffer.length === 0) return;

      if (!this._canCallLlm()) {
        // Rate-capped: keep candidates and retry next window.
        console.warn(`[AIResponder ${this.orgId}] LLM rate cap hit — deferring ${this._buffer.length} candidate(s)`);
        this._tickTimer = setTimeout(() => this._tick(), TICK_MS);
        return;
      }

      const batch = this._buffer.slice(0, MAX_CANDIDATES_PER_CALL);
      this._buffer = this._buffer.slice(MAX_CANDIDATES_PER_CALL);
      const byId = new Map(batch.map((c) => [c.id, c]));

      const faqList = Array.from(this.faqs.values())
        .filter((f) => f.status === 'active' || f.status === 'pending')
        .map((f) => ({
          id: f.id,
          question: f.question_label,
          answer: f.status === 'active' ? f.answer : undefined,
          status: f.status,
        }));

      const { results } = await this.aiClient.classifyBatch({
        candidates: batch.map((c) => ({ id: c.id, room: c.room, text: c.text })),
        faqs: faqList,
      });

      for (const r of results) {
        const cand = byId.get(r.id);
        if (!cand) continue;
        if (r.classification === 'question') {
          await this._onQuestion(r, cand);
        } else if (r.classification === 'complaint') {
          await this._onComplaint(r, cand);
        }
      }

      // If more candidates queued during the call, schedule another tick.
      if (this._buffer.length > 0) this._scheduleTick();
    } catch (err) {
      console.error(`[AIResponder ${this.orgId}] _tick error:`, err.message);
    }
  }

  _canCallLlm() {
    const now = monotonicNow();
    if (now - this._llmWindowStart >= 60_000) {
      this._llmWindowStart = now;
      this._llmCallsInWindow = 0;
    }
    if (this._llmCallsInWindow >= LLM_CALLS_PER_MIN) return false;
    this._llmCallsInWindow += 1;
    return true;
  }

  // ---------- result handlers ----------

  async _onQuestion(result, cand) {
    const matched = result.matchedFaqId ? this.faqs.get(result.matchedFaqId) : null;

    if (matched && matched.status === 'active' && result.matchConfidence >= this.settings.ai_match_threshold) {
      await this._autoReply(matched, cand, result.matchConfidence);
      return;
    }
    if (matched && matched.status === 'pending') {
      // Known-but-unanswered: bump the count so the moderator sees demand grow.
      await this._bumpMatch(matched, cand);
      return;
    }
    // Unmatched question with a usable intent → accumulate toward a pending FAQ.
    if (result.normalizedIntent) {
      await this._accumulateIntent(result.normalizedIntent, cand);
    }
  }

  async _accumulateIntent(intent, cand) {
    const key = normIntent(intent);
    if (!key) return;
    // Already represented by a FAQ — let the matcher handle it next round.
    if (this._intentToFaq.has(key)) return;

    let askers = this._intentAskers.get(key);
    if (!askers) {
      askers = new Set();
      this._intentAskers.set(key, askers);
    }
    askers.add(participantKey(cand));

    if (askers.size >= this.settings.ai_recurring_threshold) {
      await this._createPendingFaq(intent, askers.size, cand);
    }
  }

  async _createPendingFaq(intent, askerCount, cand) {
    const activeOrPending = Array.from(this.faqs.values()).filter(
      (f) => f.status === 'active' || f.status === 'pending'
    ).length;
    if (activeOrPending >= MAX_FAQS) {
      console.warn(`[AIResponder ${this.orgId}] MAX_FAQS reached — not creating pending FAQ`);
      return;
    }
    const faq = await this._insertFaq({
      question_label: intent,
      answer: null,
      status: 'pending',
      match_count: askerCount,
      created_by_user_id: null,
    });
    if (!faq) return;
    this._intentToFaq.set(normIntent(intent), faq.id);
    await this._recordEvent(faq.id, 'detected', { meetingId: cand.meetingId, messageId: cand.id, inbound_text: cand.text });
    this._emit('ai:faqPending', { faq: publicFaq(faq) });
    console.log(`[AIResponder ${this.orgId}] pending FAQ: "${intent}" (${askerCount} askers)`);
  }

  async _bumpMatch(faq, cand) {
    faq.match_count = (faq.match_count || 0) + 1;
    await this._updateFaq(faq.id, { match_count: faq.match_count });
    this._emit('ai:faqUpdated', { faq: publicFaq(faq) });
  }

  async _autoReply(faq, cand, confidence) {
    if (faq.status !== 'active' || !faq.answer) return;

    const pkey = participantKey(cand);
    let answered = this._answered.get(faq.id);
    if (!answered) {
      answered = new Set();
      this._answered.set(faq.id, answered);
    }
    if (answered.has(pkey)) return; // never answer the same person twice

    const cooldownMs = Math.max(0, this.settings.ai_cooldown_seconds * 1000);
    const throttleKey = `${faq.id}:${cand.meetingId}`;
    const lastSent = this._throttle.get(throttleKey) || 0;
    if (monotonicNow() - lastSent < cooldownMs) {
      // Room already saw this answer recently — suppress to avoid flooding.
      await this._recordEvent(faq.id, 'suppressed', {
        meetingId: cand.meetingId, messageId: cand.id, confidence, inbound_text: cand.text,
      });
      this._emit('ai:faqUpdated', { faq: publicFaq(faq) });
      return;
    }

    const botInfo = this.recallBotManager?.botsByMeeting?.get(cand.meetingId);
    if (!botInfo) return; // bot gone — can't send

    try {
      // Post the answer to the whole room (works in meetings + webinars).
      await this.recallBotManager.sendChatToMeeting(this.orgId, cand.meetingId, faq.answer);
      this._throttle.set(throttleKey, monotonicNow());
    } catch (err) {
      console.error(`[AIResponder ${this.orgId}] auto-reply send failed:`, err.message);
      return;
    }

    answered.add(pkey);
    faq.auto_reply_count = (faq.auto_reply_count || 0) + 1;
    faq.match_count = (faq.match_count || 0) + 1;
    await this._updateFaq(faq.id, {
      auto_reply_count: faq.auto_reply_count,
      match_count: faq.match_count,
    });
    await this._recordEvent(faq.id, 'auto_replied', {
      meetingId: cand.meetingId, messageId: cand.id, confidence, inbound_text: cand.text,
    });

    // Mirror into the operator feed so the auto-reply is visible + labelled.
    try {
      await this.ma?.addMessage({
        sender: botInfo.botName,
        content: faq.answer,
        room: botInfo.roomName,
        roomColor: botInfo.roomColor,
        meetingId: cand.meetingId,
        timestamp: new Date().toISOString(),
        type: 'ai_reply',
      });
    } catch (err) {
      console.error(`[AIResponder ${this.orgId}] feed mirror failed:`, err.message);
    }

    this._emit('ai:autoReplied', {
      faq: publicFaq(faq),
      room: botInfo.roomName,
      answeredText: cand.text,
    });
    this._emit('ai:faqUpdated', { faq: publicFaq(faq) });
  }

  async _onComplaint(result, cand) {
    const faq = result.relatesToFaqId ? this.faqs.get(result.relatesToFaqId) : null;
    if (!faq || faq.status !== 'active') return;
    if (result.complaintConfidence < COMPLAINT_PAUSE_CONFIDENCE) return;

    faq.complaint_count = (faq.complaint_count || 0) + 1;
    await this._updateFaq(faq.id, { complaint_count: faq.complaint_count });
    await this._recordEvent(faq.id, 'complaint', {
      meetingId: cand.meetingId, messageId: cand.id, confidence: result.complaintConfidence, inbound_text: cand.text,
    });

    // Pause on a single high-confidence complaint, or once two credible
    // complaints accumulate — the >=2 guard stops one troll from disabling
    // a good answer.
    const pauseNow =
      result.complaintConfidence >= COMPLAINT_HARD_CONFIDENCE || faq.complaint_count >= 2;

    if (pauseNow) {
      const reason = `Attendees report the answer may be ${result.complaintType === 'broken' ? 'broken' : 'wrong'} (e.g. "${cand.text}")`;
      faq.status = 'paused';
      faq.pause_reason = reason;
      await this._updateFaq(faq.id, { status: 'paused', pause_reason: reason });
      await this._recordEvent(faq.id, 'paused', { meetingId: cand.meetingId, messageId: cand.id, inbound_text: cand.text });
      this._emit('ai:feedbackAlert', { faq: publicFaq(faq), reason, sampleComplaint: cand.text });
      this._emit('ai:faqUpdated', { faq: publicFaq(faq) });
      console.log(`[AIResponder ${this.orgId}] self-healing pause: FAQ ${faq.id} — ${reason}`);
    } else {
      this._emit('ai:faqUpdated', { faq: publicFaq(faq) });
    }
  }

  // ---------- moderator-facing operations (called from routes/ai.js) ----------

  getSettings() {
    return { ...this.settings, configured: Boolean(this.aiClient?.isConfigured()) };
  }

  async updateSettings(patch) {
    const allowed = ['ai_enabled', 'ai_match_threshold', 'ai_cooldown_seconds', 'ai_recurring_threshold'];
    const sets = [];
    const vals = [];
    for (const key of allowed) {
      if (patch[key] === undefined) continue;
      sets.push(`${key} = $${sets.length + 1}`);
      vals.push(patch[key]);
    }
    if (sets.length && this.db) {
      vals.push(this.orgId);
      await this.db.query(`UPDATE organizations SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    }
    await this.loadSettings();
    this._emit('ai:settings', { settings: this.getSettings() });
    return this.getSettings();
  }

  listFaqs() {
    return Array.from(this.faqs.values())
      .filter((f) => f.status !== 'dismissed')
      .map(publicFaq);
  }

  getStateSnapshot() {
    return { settings: this.getSettings(), faqs: this.listFaqs() };
  }

  /** Operator pre-seeds a known FAQ before the show (status active). */
  async seedFaq({ question, answer, userId = null }) {
    const q = String(question || '').trim();
    const a = String(answer || '').trim();
    if (!q || !a) throw new Error('question and answer are required');
    const faq = await this._insertFaq({
      question_label: q,
      answer: a,
      status: 'active',
      created_by_user_id: userId,
      approved_by_user_id: userId,
    });
    if (faq) {
      this._intentToFaq.set(normIntent(q), faq.id);
      this._emit('ai:faqUpdated', { faq: publicFaq(faq) });
    }
    return faq ? publicFaq(faq) : null;
  }

  /** Moderator supplies the canonical answer → pending becomes active. */
  async approveFaq(faqId, { answer, userId = null }) {
    const faq = this.faqs.get(faqId);
    if (!faq) return null;
    const a = String(answer || '').trim();
    if (!a) throw new Error('answer is required');
    faq.answer = a;
    faq.status = 'active';
    faq.approved_by_user_id = userId;
    await this._updateFaq(faqId, {
      answer: a, status: 'active', approved_by_user_id: userId,
    });
    this._answered.delete(faqId);
    this._throttle.delete(faqId);
    this._emit('ai:faqUpdated', { faq: publicFaq(faq) });
    return publicFaq(faq);
  }

  async editFaq(faqId, { question, answer } = {}) {
    const faq = this.faqs.get(faqId);
    if (!faq) return null;
    const fields = {};
    if (typeof question === 'string' && question.trim()) {
      const old = normIntent(faq.question_label);
      faq.question_label = question.trim();
      fields.question_label = faq.question_label;
      this._intentToFaq.delete(old);
      this._intentToFaq.set(normIntent(faq.question_label), faqId);
    }
    if (typeof answer === 'string') { faq.answer = answer.trim(); fields.answer = faq.answer; }
    if (Object.keys(fields).length) await this._updateFaq(faqId, fields);
    // Editing the answer clears the per-asker dedup so the corrected answer
    // can reach people who already got the old one.
    if (fields.answer !== undefined) this._answered.delete(faqId);
    this._emit('ai:faqUpdated', { faq: publicFaq(faq) });
    return publicFaq(faq);
  }

  async pauseFaq(faqId, reason = 'Paused by moderator') {
    const faq = this.faqs.get(faqId);
    if (!faq) return null;
    faq.status = 'paused';
    faq.pause_reason = reason;
    await this._updateFaq(faqId, { status: 'paused', pause_reason: reason });
    await this._recordEvent(faqId, 'paused', { inbound_text: reason });
    this._emit('ai:faqUpdated', { faq: publicFaq(faq) });
    return publicFaq(faq);
  }

  async resumeFaq(faqId) {
    const faq = this.faqs.get(faqId);
    if (!faq || !faq.answer) return null;
    faq.status = 'active';
    faq.pause_reason = null;
    faq.complaint_count = 0;
    await this._updateFaq(faqId, { status: 'active', pause_reason: null, complaint_count: 0 });
    await this._recordEvent(faqId, 'resumed', {});
    // Fresh start: re-allow sends to everyone.
    this._answered.delete(faqId);
    this._throttle.delete(faqId);
    this._emit('ai:faqUpdated', { faq: publicFaq(faq) });
    return publicFaq(faq);
  }

  async dismissFaq(faqId) {
    const faq = this.faqs.get(faqId);
    if (!faq) return false;
    await this._updateFaq(faqId, { status: 'dismissed' });
    this.faqs.delete(faqId);
    if (faq.question_label) this._intentToFaq.delete(normIntent(faq.question_label));
    this._emit('ai:faqDismissed', { id: faqId });
    return true;
  }

  async getFaqEvents(faqId, limit = 100) {
    if (!this.db) return [];
    const { rows } = await this.db.query(
      `SELECT id, action, confidence, inbound_text, meeting_id, created_at
         FROM ai_faq_events WHERE faq_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [faqId, limit]
    );
    return rows;
  }

  // ---------- persistence helpers ----------

  async _insertFaq(fields) {
    const id = randomUUID();
    const sessionId = this._sessionId;
    const row = {
      id,
      org_id: this.orgId,
      session_id: sessionId,
      question_label: fields.question_label,
      answer: fields.answer ?? null,
      status: fields.status || 'pending',
      match_count: fields.match_count || 0,
      auto_reply_count: 0,
      complaint_count: 0,
      pause_reason: null,
      created_by_user_id: fields.created_by_user_id ?? null,
      approved_by_user_id: fields.approved_by_user_id ?? null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (this.db) {
      try {
        await this.db.query(
          `INSERT INTO ai_faqs
             (id, org_id, session_id, question_label, answer, status,
              match_count, auto_reply_count, complaint_count, created_by_user_id, approved_by_user_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,0,0,$8,$9)`,
          [id, this.orgId, sessionId, row.question_label, row.answer, row.status,
           row.match_count, row.created_by_user_id, row.approved_by_user_id]
        );
      } catch (err) {
        console.error(`[AIResponder ${this.orgId}] _insertFaq failed:`, err.message);
        return null;
      }
    }
    this.faqs.set(id, row);
    return row;
  }

  async _updateFaq(faqId, fields) {
    if (!this.db) return;
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = $${sets.length + 1}`);
      vals.push(v);
    }
    if (!sets.length) return;
    sets.push(`updated_at = NOW()`);
    vals.push(faqId);
    try {
      await this.db.query(`UPDATE ai_faqs SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    } catch (err) {
      console.error(`[AIResponder ${this.orgId}] _updateFaq failed:`, err.message);
    }
  }

  async _recordEvent(faqId, action, { meetingId = null, messageId = null, confidence = null, inbound_text = null } = {}) {
    if (!this.db) return;
    try {
      await this.db.query(
        `INSERT INTO ai_faq_events
           (id, faq_id, org_id, session_id, meeting_id, message_id, action, confidence, inbound_text)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [randomUUID(), faqId, this.orgId, this._sessionId, meetingId, messageId, action, confidence, inbound_text]
      );
    } catch (err) {
      console.error(`[AIResponder ${this.orgId}] _recordEvent failed:`, err.message);
    }
  }

  _emit(event, payload) {
    if (this.io && this.orgId) this.io.to(`org:${this.orgId}`).emit(event, payload);
  }
}

// ---------- module helpers ----------

function normIntent(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function participantKey(cand) {
  return cand.participantId ? `p:${cand.participantId}` : `n:${cand.sender}`;
}

// Shape sent to clients — snake_case DB columns mapped to a stable view.
function publicFaq(f) {
  return {
    id: f.id,
    question: f.question_label,
    answer: f.answer || null,
    status: f.status,
    matchCount: f.match_count || 0,
    autoReplyCount: f.auto_reply_count || 0,
    complaintCount: f.complaint_count || 0,
    pauseReason: f.pause_reason || null,
    createdBySeed: Boolean(f.created_by_user_id),
    createdAt: f.created_at instanceof Date ? f.created_at.toISOString() : f.created_at,
  };
}

// new Date() is fine for monotonic-ish wall clock here (server runtime, not
// a workflow). Kept as a helper so the throttle/window math reads cleanly.
function monotonicNow() {
  return Date.now();
}
