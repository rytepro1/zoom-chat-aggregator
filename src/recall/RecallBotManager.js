import { randomUUID } from 'node:crypto';

/**
 * RecallBotManager — Path A from docs/CHAT-CAPTURE-ARCHITECTURE.md.
 *
 * Mirrors RTMSManager's public surface (connect / disconnect /
 * getActiveConnections) but dispatches bots via Recall.ai's API instead
 * of running mock messages. Chat events flow back into the same
 * MessageAggregator pipeline via /webhook/recall/chat, which calls
 * handleChatEvent() on this instance.
 *
 * Configuration is via environment variables and read at construction
 * time. isConfigured() returns true only when both an API key and a
 * publicly-reachable webhook base URL have been supplied — the server
 * uses this to decide whether to route /api/meetings/connect through
 * Recall or fall back to the existing RTMS path.
 */

/**
 * Parse a Recall realtime webhook envelope down to { text, sender,
 * timestamp }. Targets the documented shape for
 * `participant_events.chat_message` first, with a small tolerant
 * fallback so we don't silently drop messages if Recall's schema drifts.
 */
function extractChatMessage(payload) {
  // Documented shape for `participant_events.chat_message` (May 2026):
  //   { event: "participant_events.chat_message",
  //     data: {
  //       data: {
  //         participant: { id, name, is_host, platform, extra_data, email },
  //         timestamp:   { absolute, relative },
  //         data:        { text, to }
  //       },
  //       bot: { id, metadata }, recording: {...}, ... } }
  // https://docs.recall.ai/docs/real-time-event-payloads
  const root = payload?.data?.data;
  if (root && typeof root === 'object' && root.data && typeof root.data.text === 'string') {
    return {
      text: root.data.text,
      sender: root.participant?.name ?? null,
      timestamp: root.timestamp?.absolute ?? null,
    };
  }

  // Fallback: tolerate older / alternative envelopes so we don't drop
  // messages silently if Recall's schema drifts.
  const inner = payload?.data?.data ?? payload?.data ?? payload;
  if (!inner || typeof inner !== 'object') return null;
  const text = inner.text ?? inner.message ?? inner.content ?? null;
  if (text == null) return null;
  return {
    text: String(text),
    sender:
      inner.sender_name ??
      inner.sender?.name ??
      inner.participant?.name ??
      inner.from?.name ??
      null,
    timestamp:
      inner.timestamp?.absolute ??
      (typeof inner.timestamp === 'string' ? inner.timestamp : null) ??
      inner.created_at ??
      null,
  };
}

// Surface common Recall create-bot failure modes with a one-line hint
// pointing at the right doc, so the operator doesn't have to grep error
// text. Heuristic — match on substrings since Recall doesn't publish a
// stable error-code enum yet.
function describeRecallError(status, body) {
  const b = (body || '').toLowerCase();
  if (status === 403 && b.includes('host not in allowlist')) {
    return 'Webhook URL host is not on your Recall workspace allowlist (Dashboard → Settings → Webhooks).';
  }
  if (b.includes('obf') || b.includes('on behalf of') || b.includes('on_behalf_of')) {
    return 'Zoom OBF token required. See docs/CHAT-CAPTURE-ARCHITECTURE.md and https://docs.recall.ai/docs/zoom-obf — needs a Zoom-authorized chaperone in the meeting and an OBF callback endpoint on our side.';
  }
  if (status === 401) {
    return 'RECALL_API_KEY rejected — check the key and region (RECALL_API_BASE).';
  }
  if (status === 402 || b.includes('billing')) {
    return 'Billing/plan issue on the Recall workspace.';
  }
  if (b.includes('meeting_url') && b.includes('invalid')) {
    return 'Recall could not parse the meeting URL — check the Meeting ID + passcode.';
  }
  return null;
}

export class RecallBotManager {
  constructor({ apiKey, apiBase, publicWebhookUrl, db, orgState } = {}) {
    this.apiKey = apiKey || '';
    this.apiBase = (apiBase || 'https://us-east-1.recall.ai/api/v1').replace(/\/+$/, '');
    this.publicWebhookUrl = (publicWebhookUrl || '').replace(/\/+$/, '');
    // Optional — when present, every dispatched bot writes a bot_usage
    // row that gets closed out by /webhook/recall/status (or by
    // disconnect()). Foundation for the SaaS billing layer.
    this.db = db || null;
    // OrgState container — Phase 2. Lets us route inbound chat events
    // (which arrive on a singleton webhook URL) to the right org's
    // MessageAggregator + SessionManager by looking up the bot's orgId.
    this.orgState = orgState || null;

    // botsByMeeting now includes orgId. meetingId is unique across the
    // system (Recall refuses duplicate bots for the same Zoom meeting),
    // so the meetingId key remains globally safe.
    this.botsByMeeting = new Map(); // meetingId -> { botId, meetingId, roomName, roomColor, botName, connectedAt, orgId }
    this.meetingsByBot = new Map(); // botId     -> meetingId

    // Per-bot outbound rate limit (token bucket).
    this.sendRateLimitPerMinute = 20;
    this.sendRateState = new Map(); // botId -> { tokens, lastRefillMs }
  }

  isConfigured() {
    return Boolean(this.apiKey && this.publicWebhookUrl);
  }

  /**
   * Spawn a Recall bot for a meeting. The botName is what meeting
   * participants will see — it's operator-chosen per meeting (no
   * vendor-branded default) so customers can present the bot under
   * their own identity, e.g. "Audience Q&A" or "Producer Theo".
   */
  async connect(orgId, meetingId, passcode, roomName, roomColor = '#ef4444', botName, scheduledFor = null) {
    if (!this.isConfigured()) {
      throw new Error(
        'RecallBotManager is not configured. Set RECALL_API_KEY and PUBLIC_WEBHOOK_URL in your environment.'
      );
    }
    if (!orgId) throw new Error('orgId is required to dispatch a bot');

    const cleanBotName = String(botName || '').trim();
    if (!cleanBotName) {
      throw new Error('botName is required — operator must pick how the bot appears to meeting participants.');
    }

    // Normalize scheduledFor → Date or null. Only use Recall's scheduled
    // path if the time is more than 10 min in the future (Recall's
    // minimum lead time per their support reply: anything sooner falls
    // through to the adhoc pool which is what we already do today).
    const SCHEDULE_LEAD_MS = 10 * 60 * 1000;
    let scheduleDate = null;
    if (scheduledFor) {
      scheduleDate = scheduledFor instanceof Date ? scheduledFor : new Date(scheduledFor);
      if (isNaN(scheduleDate.getTime())) scheduleDate = null;
    }
    const useScheduled = scheduleDate && scheduleDate.getTime() > Date.now() + SCHEDULE_LEAD_MS;

    if (this.botsByMeeting.has(meetingId)) {
      const existing = this.botsByMeeting.get(meetingId);
      if (existing.orgId !== orgId) {
        // Defensive: another org already owns a bot for this meetingId.
        // Recall would refuse a duplicate dispatch anyway, but surface a
        // clear error so the operator knows why.
        throw new Error(`Meeting ${meetingId} already has an active bot in another organization.`);
      }
      console.log(`[Recall] ${orgId} already has a bot for meeting: ${meetingId}`);
      return existing;
    }

    // Build the Zoom URL the way Recall expects (plain join link with pwd query string).
    let meetingUrl = `https://zoom.us/j/${meetingId}`;
    if (passcode && String(passcode).trim()) {
      meetingUrl += `?pwd=${encodeURIComponent(String(passcode).trim())}`;
    }

    const chatWebhookUrl = `${this.publicWebhookUrl}/webhook/recall/chat`;

    // Note: realtime_endpoints only accepts participant_events.* events
    // (chat, video, audio, etc.). Bot lifecycle events like
    // bot.status_change live in Recall's workspace-level webhook system,
    // configured per-workspace in the Recall dashboard rather than
    // per-bot here. The /webhook/recall/status route is still wired up
    // and ready to receive those events once the workspace webhook is
    // added in the Recall dashboard pointing at it.
    const body = {
      meeting_url: meetingUrl,
      bot_name: cleanBotName,
      recording_config: {
        realtime_endpoints: [
          {
            type: 'webhook',
            url: chatWebhookUrl,
            events: ['participant_events.chat_message'],
          },
        ],
      },
    };
    // Scheduled dispatch path — bypasses Recall's shared adhoc pool
    // (which can hit 507 adhoc_pool_depleted under load) by giving each
    // scheduled bot a dedicated instance. Per Recall support: requires
    // >10 min lead time; we silently fall back to adhoc otherwise.
    if (useScheduled) {
      body.join_at = scheduleDate.toISOString();
    }

    let response;
    try {
      response = await fetch(`${this.apiBase}/bot/`, {
        method: 'POST',
        headers: {
          'Authorization': `Token ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new Error(`Recall API request failed: ${error.message}`);
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      const hint = describeRecallError(response.status, errorText);
      throw new Error(
        `Recall API returned ${response.status}: ${errorText.slice(0, 500) || response.statusText}${hint ? ` — ${hint}` : ''}`
      );
    }

    const data = await response.json();
    const botId = data?.id || data?.bot_id;
    if (!botId) {
      throw new Error(`Recall API response missing bot id: ${JSON.stringify(data).slice(0, 300)}`);
    }

    const botInfo = {
      botId,
      meetingId,
      roomName,
      roomColor,
      botName: cleanBotName,
      connectedAt: new Date(),
      orgId,
      scheduledFor: useScheduled ? scheduleDate : null,
    };

    this.botsByMeeting.set(meetingId, botInfo);
    this.meetingsByBot.set(botId, meetingId);

    // Persist a usage record scoped to the org. The status webhook (or
    // our own disconnect()) closes the row.
    if (this.db) {
      try {
        let sessionId = null;
        const entry = this.orgState?.peek(orgId);
        sessionId = entry?.sm?.current?.id ?? null;
        await this.db.query(
          `INSERT INTO bot_usage (id, recall_bot_id, meeting_id, session_id, org_id, tenant_id)
           VALUES ($1, $2, $3, $4, $5, COALESCE($5, 'ryteproductions'))`,
          [randomUUID(), botId, meetingId, sessionId, orgId]
        );
      } catch (err) {
        console.error('[Recall] bot_usage INSERT failed (bot still dispatched):', err.message);
      }
    }

    if (useScheduled) {
      console.log(`[Recall] Bot ${botId} (${orgId}) SCHEDULED for ${scheduleDate.toISOString()} → ${meetingId} (${roomName})`);
    } else {
      console.log(`[Recall] Bot ${botId} (${orgId}) dispatched to ${meetingId} (${roomName})`);
    }
    return botInfo;
  }

  /**
   * Ask Recall to have the bot leave the call. Idempotent — safe to
   * call for a meetingId we don't have a bot for.
   */
  async disconnect(orgId, meetingId) {
    const botInfo = this.botsByMeeting.get(meetingId);
    if (!botInfo) {
      console.log(`[Recall] No bot tracked for meeting: ${meetingId}`);
      return;
    }
    if (orgId && botInfo.orgId !== orgId) {
      throw new Error(`Meeting ${meetingId} does not belong to this organization.`);
    }

    const { botId } = botInfo;

    try {
      const response = await fetch(`${this.apiBase}/bot/${botId}/leave_call/`, {
        method: 'POST',
        headers: {
          'Authorization': `Token ${this.apiKey}`,
        },
      });

      // 404 = bot already gone (call ended, bot was kicked, etc.) — fine.
      if (!response.ok && response.status !== 404) {
        const errorText = await response.text().catch(() => '');
        console.error(
          `[Recall] leave_call failed (${response.status}): ${errorText.slice(0, 300) || response.statusText}`
        );
      }
    } catch (error) {
      console.error(`[Recall] Error calling leave_call for bot ${botId}: ${error.message}`);
    }

    this.botsByMeeting.delete(meetingId);
    this.meetingsByBot.delete(botId);

    // Close the usage row immediately. The status webhook will likely
    // also fire (we'd be a no-op via COALESCE), but operator-initiated
    // disconnects shouldn't wait on Recall round-tripping us.
    if (this.db) {
      try {
        await this.db.query(
          `UPDATE bot_usage
              SET left_at          = COALESCE(left_at, NOW()),
                  duration_seconds = COALESCE(
                    duration_seconds,
                    CAST(EXTRACT(EPOCH FROM (NOW() - joined_at)) AS INTEGER)
                  ),
                  last_status      = COALESCE(last_status, 'disconnected_by_operator')
            WHERE recall_bot_id = $1`,
          [botId]
        );
      } catch (err) {
        console.error('[Recall] bot_usage close on disconnect failed:', err.message);
      }
    }

    console.log(`[Recall] Bot ${botId} removed from meeting ${meetingId}`);
  }

  /**
   * Org-scoped view of active bots. When orgId is omitted, returns all
   * bots (used by /api/status and operational endpoints, never sent to
   * an unauthenticated UI).
   */
  getActiveConnections(orgId = null) {
    return Array.from(this.botsByMeeting.values())
      .filter((info) => !orgId || info.orgId === orgId)
      .map((info) => ({
        meetingId: info.meetingId,
        roomName: info.roomName,
        roomColor: info.roomColor,
        connectedAt: info.connectedAt,
        scheduledFor: info.scheduledFor || null,
        isMock: false,
      }));
  }

  /**
   * Called by the /webhook/recall/chat route. Delegates payload parsing
   * to extractChatMessage() (which targets Recall's documented schema
   * first, with a tolerant fallback). Bot-id lookup is handled here so
   * we can correlate the message back to a room/meeting we know about.
   */
  async handleChatEvent(payload) {
    const chat = extractChatMessage(payload);
    if (!chat) {
      console.warn(
        '[Recall] handleChatEvent: no chat body in payload:',
        JSON.stringify(payload).slice(0, 400)
      );
      return;
    }

    const botId =
      payload?.bot?.id ||
      payload?.bot_id ||
      payload?.data?.bot?.id ||
      payload?.data?.bot_id ||
      payload?.data?.data?.bot?.id ||
      null;

    const meetingId = botId ? this.meetingsByBot.get(botId) || null : null;
    const botInfo = meetingId ? this.botsByMeeting.get(meetingId) : null;

    if (!botInfo) {
      // Stale webhook for a bot we no longer track (process restart,
      // manual cleanup). Drop — without orgId we can't route it safely.
      console.warn(`[Recall] unknown bot ${botId} — dropping message (no org context)`);
      return;
    }

    if (!this.orgState) {
      console.warn('[Recall] no orgState configured — dropping message');
      return;
    }

    const { ma } = await this.orgState.get(botInfo.orgId);
    await ma.addMessage({
      sender: chat.sender || 'Unknown',
      content: chat.text,
      room: botInfo.roomName,
      roomColor: botInfo.roomColor,
      meetingId: botInfo.meetingId,
      timestamp: chat.timestamp || new Date().toISOString(),
      type: 'chat',
    });
  }

  /**
   * Called by /webhook/recall/status. Recall's workspace webhooks fire
   * each bot lifecycle state as its own event ("bot.done", "bot.fatal",
   * "bot.in_call_recording", etc.) — not a single "status_change"
   * envelope — so the status is whatever follows "bot." in the event
   * name. We also probe a `code` field as a fallback in case the
   * envelope evolves.
   *
   * On terminal states (done / fatal) closes left_at + duration_seconds
   * via COALESCE so the operator-initiated disconnect path doesn't get
   * stomped if the webhook arrives later.
   */
  async handleStatusChangeEvent(payload) {
    if (!this.db) return;

    const botId =
      payload?.bot?.id ||
      payload?.bot_id ||
      payload?.data?.bot?.id ||
      payload?.data?.bot_id ||
      payload?.data?.data?.bot?.id ||
      null;

    // Primary source of truth: the event name itself.
    const eventName = String(payload?.event || '').trim();
    const eventStatus = eventName.startsWith('bot.') ? eventName.slice(4) : null;
    // Fallback in case the envelope shape includes an explicit code.
    const codeStatus =
      payload?.data?.data?.code ||
      payload?.data?.data?.status ||
      payload?.data?.code ||
      payload?.data?.status ||
      payload?.code ||
      payload?.status ||
      null;
    const status = String(eventStatus || codeStatus || '').toLowerCase() || null;

    if (!botId) {
      console.warn('[Recall] handleStatusChangeEvent: no bot id in payload');
      return;
    }

    const terminal = status === 'done' || status === 'fatal';

    try {
      if (terminal) {
        await this.db.query(
          `UPDATE bot_usage
              SET left_at          = COALESCE(left_at, NOW()),
                  duration_seconds = COALESCE(
                    duration_seconds,
                    CAST(EXTRACT(EPOCH FROM (NOW() - joined_at)) AS INTEGER)
                  ),
                  last_status      = $2
            WHERE recall_bot_id = $1`,
          [botId, status]
        );
        console.log(`[Recall] bot_usage closed for ${botId} (${status})`);

        // Clear in-memory state so the operator can immediately
        // redispatch a fresh bot. Without this, our duplication guard
        // (`already has a bot for meeting`) blocks redeploys even
        // though the actual Recall bot is gone.
        const meetingId = this.meetingsByBot.get(botId);
        if (meetingId) {
          const botInfo = this.botsByMeeting.get(meetingId);
          this.meetingsByBot.delete(botId);
          this.botsByMeeting.delete(meetingId);
          // Surface the disconnect in the operator UI so the meeting
          // tile flips out of "connected" and the room is removed.
          if (botInfo && this.orgState) {
            try {
              const entry = this.orgState.peek(botInfo.orgId);
              if (entry) entry.ma.removeRoom(meetingId);
              // Direct emit too so the meetings list updates even if
              // no MA subscriber is around.
              entry?.ma?.io?.to(`org:${botInfo.orgId}`).emit('meetingDisconnected', { id: meetingId });
            } catch (e) {
              console.error('[Recall] post-terminal UI cleanup failed:', e.message);
            }
          }
          console.log(`[Recall] cleared in-memory bot ${botId} for meeting ${meetingId} (${status})`);
        }
      } else if (status) {
        await this.db.query(
          `UPDATE bot_usage SET last_status = $2 WHERE recall_bot_id = $1`,
          [botId, status]
        );
      }
    } catch (err) {
      console.error('[Recall] handleStatusChangeEvent DB error:', err.message);
    }
  }

  // ========== OUTBOUND CHAT (operator reply + broadcast) ==========

  /**
   * Send a chat message into a single meeting via its bot. Rate-limited
   * per-bot (default 20/min) to prevent runaway loops or
   * credential-abuse spam. Writes an audit row to sent_messages on
   * success.
   *
   * Throws if no bot is tracked for the meeting (operator must connect
   * first), if the rate limit is exceeded, or if Recall rejects the
   * send.
   */
  async sendChatToMeeting(orgId, meetingId, text) {
    const cleanText = String(text || '').trim();
    if (!cleanText) throw new Error('Message text is required');

    const botInfo = this.botsByMeeting.get(meetingId);
    if (!botInfo) {
      throw new Error(`No active bot for meeting ${meetingId} — connect first.`);
    }
    if (botInfo.orgId !== orgId) {
      throw new Error(`Meeting ${meetingId} does not belong to this organization.`);
    }

    if (!this._consumeSendToken(botInfo.botId)) {
      throw new Error(
        `Rate limit exceeded for this bot (max ${this.sendRateLimitPerMinute}/minute). ` +
        `Wait a moment before sending again.`
      );
    }

    await this._sendChatViaRecall(botInfo.botId, cleanText);
    await this._auditSentMessage({ botInfo, text: cleanText, isBroadcast: false });
    return { botId: botInfo.botId, meetingId, text: cleanText };
  }

  /**
   * Send the same message to every active bot. Used by /api/broadcast.
   * Per-bot rate limit still applies. Returns per-bot success/failure
   * so the UI can surface partial failures (e.g., "sent to 4 of 5
   * meetings, 1 hit rate limit").
   */
  async broadcastChat(orgId, text) {
    const cleanText = String(text || '').trim();
    if (!cleanText) throw new Error('Message text is required');

    const targets = Array.from(this.botsByMeeting.values()).filter(b => b.orgId === orgId);
    if (targets.length === 0) {
      throw new Error('No active bots in this organization — connect to at least one meeting first.');
    }

    // Parallel fan-out; each gets its own rate-limit check + audit row.
    const results = await Promise.allSettled(
      targets.map(async (botInfo) => {
        if (!this._consumeSendToken(botInfo.botId)) {
          throw new Error('Rate limit exceeded for this bot');
        }
        await this._sendChatViaRecall(botInfo.botId, cleanText);
        await this._auditSentMessage({ botInfo, text: cleanText, isBroadcast: true });
        return { meetingId: botInfo.meetingId, roomName: botInfo.roomName };
      })
    );

    return results.map((r, i) => ({
      meetingId: targets[i].meetingId,
      roomName: targets[i].roomName,
      ok: r.status === 'fulfilled',
      error: r.status === 'rejected' ? (r.reason?.message || String(r.reason)) : null,
    }));
  }

  // ---------- internals for outbound chat ----------

  async _sendChatViaRecall(botId, text) {
    const response = await fetch(`${this.apiBase}/bot/${botId}/send_chat_message/`, {
      method: 'POST',
      headers: {
        'Authorization': `Token ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ to: 'everyone', message: text }),
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Recall send_chat_message returned ${response.status}: ${errorText.slice(0, 300) || response.statusText}`);
    }
  }

  /**
   * Token-bucket rate limiter, per-bot. Refills `sendRateLimitPerMinute`
   * tokens every 60s window. Returns true if a token was available
   * (and consumed), false if exhausted.
   */
  _consumeSendToken(botId) {
    const now = Date.now();
    const state = this.sendRateState.get(botId) || {
      tokens: this.sendRateLimitPerMinute,
      lastRefillMs: now,
    };
    // Refill if a full minute has passed since last refill.
    if (now - state.lastRefillMs >= 60_000) {
      state.tokens = this.sendRateLimitPerMinute;
      state.lastRefillMs = now;
    }
    if (state.tokens <= 0) {
      this.sendRateState.set(botId, state);
      return false;
    }
    state.tokens -= 1;
    this.sendRateState.set(botId, state);
    return true;
  }

  async _auditSentMessage({ botInfo, text, isBroadcast }) {
    if (!this.db) return;
    try {
      const entry = this.orgState?.peek(botInfo.orgId);
      const sessionId = entry?.sm?.current?.id ?? null;
      await this.db.query(
        `INSERT INTO sent_messages
           (id, recall_bot_id, meeting_id, session_id, text, is_broadcast, org_id, tenant_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($7, 'ryteproductions'))`,
        [
          randomUUID(),
          botInfo.botId,
          botInfo.meetingId,
          sessionId,
          text,
          isBroadcast,
          botInfo.orgId,
        ]
      );
    } catch (err) {
      console.error('[Recall] sent_messages audit INSERT failed:', err.message);
    }
  }
}
