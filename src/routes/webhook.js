import express from 'express';
import crypto from 'crypto';
import { RTMSManager } from '../rtms/RTMSManager.js';

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
 * Recall.ai realtime webhook — receives chat_message events for any bot
 * we've dispatched via RecallBotManager. We always return 200 so Recall
 * doesn't retry on internal parsing bugs; the manager logs anything it
 * couldn't make sense of.
 *
 * TODO: validate Recall's webhook signature once we know which header
 * they sign with and have a shared secret in the env.
 */
router.post('/recall/chat', (req, res) => {
  try {
    const recallBotManager = req.app.get('recallBotManager');
    if (recallBotManager) {
      recallBotManager.handleChatEvent(req.body);
    } else {
      console.warn('[Recall webhook] no recallBotManager registered');
    }
  } catch (error) {
    console.error('[Recall webhook] error handling chat event:', error);
  }
  res.status(200).json({ received: true });
});

export default router;
