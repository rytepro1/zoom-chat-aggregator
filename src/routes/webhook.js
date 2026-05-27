import express from 'express';
import crypto from 'crypto';
import { RTMSManager } from '../rtms/RTMSManager.js';
import { verifyRecallWebhook } from '../recall/verifyRecallWebhook.js';

const router = express.Router();

// Initialize RTMS Manager
let rtmsManager = null;

/**
 * Validate Zoom webhook signature
 */
function validateWebhookSignature(req) {
  const signature = req.headers['x-zm-signature'];
  const timestamp = req.headers['x-zm-request-timestamp'];
  const webhookSecret = process.env.ZOOM_WEBHOOK_SECRET_TOKEN;

  if (!signature || !timestamp || !webhookSecret) {
    return false;
  }

  // Check timestamp is within 5 minutes
  const currentTime = Math.floor(Date.now() / 1000);
  if (Math.abs(currentTime - parseInt(timestamp)) > 300) {
    console.warn('Webhook timestamp too old');
    return false;
  }

  // Calculate expected signature
  const message = `v0:${timestamp}:${JSON.stringify(req.body)}`;
  const expectedSignature = 'v0=' + crypto
    .createHmac('sha256', webhookSecret)
    .update(message)
    .digest('hex');

  return crypto.timingSafeEquals(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

/**
 * Handle URL validation challenge from Zoom
 */
function handleValidationChallenge(req, res) {
  const { payload } = req.body;
  const plainToken = payload?.plainToken;
  const webhookSecret = process.env.ZOOM_WEBHOOK_SECRET_TOKEN;

  if (!plainToken) {
    return res.status(400).json({ error: 'Missing plainToken' });
  }

  // Generate encrypted token
  const encryptedToken = crypto
    .createHmac('sha256', webhookSecret)
    .update(plainToken)
    .digest('hex');

  console.log('Responding to URL validation challenge');

  res.json({
    plainToken,
    encryptedToken
  });
}

/**
 * Main Zoom webhook endpoint
 */
router.post('/zoom', (req, res) => {
  console.log('Received webhook:', req.body.event);

  // Handle URL validation (doesn't require signature validation)
  if (req.body.event === 'endpoint.url_validation') {
    return handleValidationChallenge(req, res);
  }

  // Validate signature for all other events
  if (!validateWebhookSignature(req)) {
    console.error('Invalid webhook signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const { event, payload } = req.body;
  const messageAggregator = req.app.get('messageAggregator');

  // Initialize RTMS manager if needed
  if (!rtmsManager) {
    rtmsManager = new RTMSManager(messageAggregator);
  }

  switch (event) {
    case 'meeting.rtms_started':
      console.log('RTMS stream started for meeting:', payload.object.id);
      handleRTMSStarted(payload, rtmsManager, messageAggregator);
      break;

    case 'meeting.rtms_stopped':
      console.log('RTMS stream stopped for meeting:', payload.object.id);
      handleRTMSStopped(payload, rtmsManager, messageAggregator);
      break;

    case 'meeting.started':
      console.log('Meeting started:', payload.object.id);
      // Track meeting for potential RTMS connection
      break;

    case 'meeting.ended':
      console.log('Meeting ended:', payload.object.id);
      rtmsManager?.disconnect(payload.object.id);
      break;

    default:
      console.log('Unhandled event:', event);
  }

  // Acknowledge receipt
  res.status(200).json({ received: true });
});

/**
 * Handle RTMS stream started event
 */
async function handleRTMSStarted(payload, rtmsManager, messageAggregator) {
  const meetingId = payload.object.id;
  const meetingTopic = payload.object.topic || `Meeting ${meetingId}`;
  const streamUrl = payload.object.rtms_stream_url;

  // Add room to aggregator
  messageAggregator.addRoom({
    id: meetingId,
    name: meetingTopic,
    streamUrl
  });

  // Connect to RTMS stream
  try {
    await rtmsManager.connect(meetingId, streamUrl, meetingTopic);
    console.log(`Connected to RTMS stream for: ${meetingTopic}`);
  } catch (error) {
    console.error(`Failed to connect to RTMS: ${error.message}`);
  }
}

/**
 * Handle RTMS stream stopped event
 */
function handleRTMSStopped(payload, rtmsManager, messageAggregator) {
  const meetingId = payload.object.id;

  rtmsManager?.disconnect(meetingId);
  messageAggregator.removeRoom(meetingId);

  console.log(`Disconnected from meeting: ${meetingId}`);
}

/**
 * Recall.ai realtime webhook — receives chat_message events for bots
 * dispatched via RecallBotManager. When RECALL_WEBHOOK_SECRET is set we
 * verify the Svix-style signature over the raw body; otherwise we accept
 * with a warning (dev convenience). We always return 200 on accepted
 * requests so Recall doesn't retry on our parsing bugs.
 */
router.post('/recall/chat', (req, res) => {
  const recallBotManager = req.app.get('recallBotManager');
  if (!recallBotManager) {
    return res.status(503).json({ error: 'Recall manager not initialized' });
  }

  const secret = process.env.RECALL_WEBHOOK_SECRET;
  if (secret) {
    const result = verifyRecallWebhook(req.headers, req.rawBody, secret);
    if (!result.ok) {
      console.warn(`[Recall webhook] rejected: ${result.reason}`);
      return res.status(401).json({ error: 'Invalid signature' });
    }
  } else {
    console.warn('[Recall webhook] RECALL_WEBHOOK_SECRET not set — accepting without verification (set it in Railway env vars)');
  }

  try {
    recallBotManager.handleChatEvent(req.body);
  } catch (err) {
    console.error('[Recall webhook] handler error:', err);
  }
  // Always 200 so Recall doesn't retry on our parsing bugs.
  res.status(200).json({ received: true });
});

/**
 * Recall.ai bot lifecycle webhook — receives `bot.status_change` events.
 * Used to close the bot_usage row (set left_at + duration_seconds) when
 * a bot reaches a terminal state (done / fatal), which feeds the SaaS
 * billing layer per docs/MONETIZATION-PLAN.md. Same signature
 * verification as /recall/chat; same 200-always policy.
 */
router.post('/recall/status', (req, res) => {
  const recallBotManager = req.app.get('recallBotManager');
  if (!recallBotManager) {
    return res.status(503).json({ error: 'Recall manager not initialized' });
  }

  const secret = process.env.RECALL_WEBHOOK_SECRET;
  if (secret) {
    const result = verifyRecallWebhook(req.headers, req.rawBody, secret);
    if (!result.ok) {
      console.warn(`[Recall status webhook] rejected: ${result.reason}`);
      return res.status(401).json({ error: 'Invalid signature' });
    }
  } else {
    console.warn('[Recall status webhook] RECALL_WEBHOOK_SECRET not set — accepting without verification');
  }

  // Fire-and-forget — the handler is async but we don't need to block
  // the 200 response on the DB write.
  Promise.resolve(recallBotManager.handleStatusChangeEvent(req.body))
    .catch(err => console.error('[Recall status webhook] handler error:', err));

  res.status(200).json({ received: true });
});

export default router;
