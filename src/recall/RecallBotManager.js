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
export class RecallBotManager {
  constructor({ messageAggregator, apiKey, apiBase, publicWebhookUrl }) {
    this.messageAggregator = messageAggregator;
    this.apiKey = apiKey || '';
    this.apiBase = (apiBase || 'https://us-east-1.recall.ai/api/v1').replace(/\/+$/, '');
    this.publicWebhookUrl = (publicWebhookUrl || '').replace(/\/+$/, '');

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

    const webhookUrl = `${this.publicWebhookUrl}/webhook/recall/chat`;

    const body = {
      meeting_url: meetingUrl,
      bot_name: 'Chat Capture by RYTE Productions',
      recording_config: {
        realtime_endpoints: [
          {
            type: 'webhook',
            url: webhookUrl,
            events: ['participant_events.chat_message'],
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
      throw new Error(
        `Recall API returned ${response.status}: ${errorText.slice(0, 500) || response.statusText}`
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
   * Called by the /webhook/recall/chat route. Recall's realtime webhook
   * envelope shape varies slightly across event types and SDK versions,
   * so we probe a few common paths rather than asserting a single shape.
   * Any payload we can't recognize is logged and dropped (the route
   * still returns 200 so Recall doesn't retry).
   */
  handleChatEvent(payload) {
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

    // Locate the chat message body — try common envelope shapes in order.
    const candidates = [
      payload?.data?.data,
      payload?.data?.message,
      payload?.data,
      payload?.message,
      payload,
    ].filter(Boolean);

    let chat = null;
    for (const c of candidates) {
      if (c && (c.text || c.message_text || c.content || c.body)) {
        chat = c;
        break;
      }
    }

    if (!chat) {
      console.warn(
        '[Recall] handleChatEvent: no chat body found in payload:',
        JSON.stringify(payload).slice(0, 400)
      );
      return;
    }

    const content = chat.text || chat.message_text || chat.content || chat.body || '';
    const sender =
      chat.participant?.name ||
      chat.sender?.name ||
      chat.from?.name ||
      chat.participant_name ||
      chat.sender_name ||
      chat.user?.name ||
      payload?.participant?.name ||
      'Unknown';
    const timestamp =
      chat.timestamp ||
      chat.created_at ||
      chat.sent_at ||
      payload?.timestamp ||
      new Date().toISOString();

    this.messageAggregator.addMessage({
      sender,
      content,
      room: botInfo?.roomName || 'Unknown Room',
      roomColor: botInfo?.roomColor || '#ef4444',
      meetingId: meetingId || botInfo?.meetingId || null,
      timestamp,
      type: 'chat',
    });
  }
}
