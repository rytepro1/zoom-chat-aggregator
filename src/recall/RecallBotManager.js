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
  constructor({ messageAggregator, apiKey, apiBase, publicWebhookUrl, db, sessionManager } = {}) {
    this.messageAggregator = messageAggregator;
    this.apiKey = apiKey || '';
    this.apiBase = (apiBase || 'https://us-east-1.recall.ai/api/v1').replace(/\/+$/, '');
    this.publicWebhookUrl = (publicWebhookUrl || '').replace(/\/+$/, '');
    // Optional — when present, every dispatched bot writes a bot_usage
    // row that gets closed out by /webhook/recall/status (or by
    // disconnect()). Foundation for the eventual SaaS billing layer;
    // safe to leave null in dev / in-memory mode.
    this.db = db || null;
    this.sessionManager = sessionManager || null;

    // Two-way mapping. botsByMeeting holds the canonical record; meetingsByBot
    // is a reverse index used when an inbound webhook only carries a bot id.
    this.botsByMeeting = new Map(); // meetingId -> { botId, meetingId, roomName, roomColor, connectedAt }
    this.meetingsByBot = new Map(); // botId     -> meetingId
  }

  isConfigured() {
    return Boolean(this.apiKey && this.publicWebhookUrl);
  }

  /**
   * Spawn a Recall bot for a meeting. Mirrors RTMSManager.connect's
   * shape, but the second argument is the Zoom passcode (not a stream
   * URL).
   */
  async connect(meetingId, passcode, roomName, roomColor = '#ef4444') {
    if (!this.isConfigured()) {
      throw new Error(
        'RecallBotManager is not configured. Set RECALL_API_KEY and PUBLIC_WEBHOOK_URL in your environment.'
      );
    }

    if (this.botsByMeeting.has(meetingId)) {
      console.log(`[Recall] Already have a bot for meeting: ${meetingId}`);
      return this.botsByMeeting.get(meetingId);
    }

    // Build the Zoom URL the way Recall expects (plain join link with pwd query string).
    let meetingUrl = `https://zoom.us/j/${meetingId}`;
    if (passcode && String(passcode).trim()) {
      meetingUrl += `?pwd=${encodeURIComponent(String(passcode).trim())}`;
    }

    const chatWebhookUrl   = `${this.publicWebhookUrl}/webhook/recall/chat`;
    const statusWebhookUrl = `${this.publicWebhookUrl}/webhook/recall/status`;

    const body = {
      meeting_url: meetingUrl,
      bot_name: 'Chat Capture by RYTE Productions',
      recording_config: {
        realtime_endpoints: [
          // Chat events go to the chat handler.
          {
            type: 'webhook',
            url: chatWebhookUrl,
            events: ['participant_events.chat_message'],
          },
          // Bot lifecycle events go to the status handler, which closes
          // bot_usage rows for billing once the bot reaches a terminal
          // state. Separate URL keeps each handler focused.
          {
            type: 'webhook',
            url: statusWebhookUrl,
            events: ['bot.status_change'],
          },
        ],
      },
    };

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
      connectedAt: new Date(),
    };

    this.botsByMeeting.set(meetingId, botInfo);
    this.meetingsByBot.set(botId, meetingId);

    // Persist a usage record so the eventual billing layer can sum
    // bot-hours per tenant per month. The status webhook (or our own
    // disconnect()) closes the row.
    if (this.db) {
      try {
        const sessionId = this.sessionManager?.current?.id ?? null;
        await this.db.query(
          `INSERT INTO bot_usage (id, recall_bot_id, meeting_id, session_id)
           VALUES ($1, $2, $3, $4)`,
          [randomUUID(), botId, meetingId, sessionId]
        );
      } catch (err) {
        console.error('[Recall] bot_usage INSERT failed (bot still dispatched):', err.message);
      }
    }

    console.log(`[Recall] Bot ${botId} dispatched to meeting ${meetingId} (${roomName})`);
    return botInfo;
  }

  /**
   * Ask Recall to have the bot leave the call. Idempotent — safe to
   * call for a meetingId we don't have a bot for.
   */
  async disconnect(meetingId) {
    const botInfo = this.botsByMeeting.get(meetingId);
    if (!botInfo) {
      console.log(`[Recall] No bot tracked for meeting: ${meetingId}`);
      return;
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
   * Same shape RTMSManager returns so server routes don't need to
   * branch on which manager they're talking to.
   */
  getActiveConnections() {
    return Array.from(this.botsByMeeting.values()).map((info) => ({
      meetingId: info.meetingId,
      roomName: info.roomName,
      roomColor: info.roomColor,
      connectedAt: info.connectedAt,
      isMock: false,
    }));
  }

  /**
   * Called by the /webhook/recall/chat route. Delegates payload parsing
   * to extractChatMessage() (which targets Recall's documented schema
   * first, with a tolerant fallback). Bot-id lookup is handled here so
   * we can correlate the message back to a room/meeting we know about.
   */
  handleChatEvent(payload) {
    const chat = extractChatMessage(payload);
    if (!chat) {
      console.warn(
        '[Recall] handleChatEvent: no chat body found in payload:',
        JSON.stringify(payload).slice(0, 400)
      );
      return;
    }

    // Bot id can live at several levels of the envelope.
    const botId =
      payload?.bot?.id ||
      payload?.bot_id ||
      payload?.data?.bot?.id ||
      payload?.data?.bot_id ||
      payload?.data?.data?.bot?.id ||
      null;

    const meetingId = botId ? this.meetingsByBot.get(botId) || null : null;
    const botInfo = meetingId ? this.botsByMeeting.get(meetingId) : null;

    if (botId && !botInfo) {
      // Probably a stale webhook for a bot we no longer track (process
      // restart, manual cleanup). Surface the mismatch but still forward
      // the message — better an "Unknown Room" entry than a silent drop.
      console.warn(`[Recall] unknown bot ${botId} — forwarding message without room context`);
    }

    this.messageAggregator.addMessage({
      sender: chat.sender || 'Unknown',
      content: chat.text,
      room: botInfo?.roomName || 'Unknown Room',
      roomColor: botInfo?.roomColor || '#ef4444',
      meetingId: meetingId || botInfo?.meetingId || null,
      timestamp: chat.timestamp || new Date().toISOString(),
      type: 'chat',
    });
  }

  /**
   * Called by /webhook/recall/status. Updates the bot_usage row for
   * this bot: always records last_status, and on terminal states
   * (done / fatal) closes left_at + duration_seconds. Idempotent via
   * COALESCE so the operator-initiated disconnect path doesn't get
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

    // Recall labels the new status under a few possible keys depending
    // on envelope version; probe a few likely paths.
    const statusRaw =
      payload?.data?.data?.code ||
      payload?.data?.data?.status ||
      payload?.data?.code ||
      payload?.data?.status ||
      payload?.code ||
      payload?.status ||
      null;
    const status = statusRaw ? String(statusRaw).toLowerCase() : null;

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
}
