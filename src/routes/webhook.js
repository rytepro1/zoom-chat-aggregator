import express from 'express';
import crypto from 'crypto';
import { RTMSManager } from '../rtms/RTMSManager.js';
import { verifyRecallWebhook } from '../recall/verifyRecallWebhook.js';
import { getTier } from '../services/tiers.js';

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

  // Fire-and-forget — handler is async now (looks up org state) but the
  // 200 response shouldn't wait on the DB write or socket emit.
  Promise.resolve(recallBotManager.handleChatEvent(req.body))
    .catch(err => console.error('[Recall webhook] handler error:', err));
  res.status(200).json({ received: true });
});

/**
 * Recall.ai bot lifecycle webhook — receives `bot.status_change` events.
 * Used to close the bot_usage row (set left_at + duration_seconds) when
 * a bot reaches a terminal state (done / fatal), which feeds the SaaS
 * billing layer per docs/MONETIZATION-PLAN.md. Same signature
 * verification as /recall/chat; same 200-always policy.
 */
/**
 * Stripe webhook — fires on subscription lifecycle events. We rely on
 * Stripe's signature verification (constructEvent), so this route MUST
 * see the raw request body. The express.json() middleware in index.js
 * captures rawBody on every request, so we use that.
 *
 * Events handled:
 *   - checkout.session.completed       → first-time upgrade success
 *   - customer.subscription.updated    → plan changes / renewals
 *   - customer.subscription.deleted    → cancellation reached period end
 *
 * Always 200 on accepted events so Stripe doesn't retry on our internal
 * errors (we log instead). The exception is verification failure — that's
 * a real 400 so Stripe surfaces it in their dashboard.
 */
router.post('/stripe', async (req, res) => {
  const stripe = req.app.get('stripeService');
  const db = req.app.get('db');
  if (!stripe?.isConfigured()) {
    return res.status(503).json({ error: 'Stripe not configured' });
  }

  let event;
  try {
    const signature = req.headers['stripe-signature'];
    event = stripe.verifyWebhook(req.rawBody, signature);
  } catch (err) {
    console.warn('[stripe webhook] signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const orgId = session.metadata?.org_id;
        const subscriptionId = session.subscription;
        if (!orgId || !subscriptionId) {
          console.warn('[stripe webhook] checkout.session.completed missing org_id or subscription');
          break;
        }
        // Fetch the subscription to read its line item's price → resolve
        // to a tier. Metadata.tier_key is the fast path (set by our
        // createCheckoutSession), but we fall back to price-id mapping
        // in case metadata was stripped or the sub was created out-of-band.
        let tier = null;
        const tierKey = session.metadata?.tier_key;
        if (tierKey) tier = getTier(tierKey);
        if (!tier) {
          tier = await resolveTierFromSubscription(stripe, subscriptionId);
        }
        if (!tier) {
          console.warn(`[stripe webhook] could not resolve tier for sub ${subscriptionId} — defaulting to solo`);
          tier = { key: 'solo', concurrentBotLimit: 1, name: 'Solo' };
        }
        if (db) {
          await db.query(
            `UPDATE organizations
                SET plan_tier               = $2,
                    concurrent_bot_limit    = $3,
                    trial_minutes_remaining = NULL,
                    stripe_subscription_id  = $4
              WHERE id = $1`,
            [orgId, tier.key, tier.concurrentBotLimit, subscriptionId]
          );
        }
        console.log(`[stripe webhook] org ${orgId} upgraded to ${tier.key} (${tier.concurrentBotLimit} bots, sub ${subscriptionId})`);
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const orgId = sub.metadata?.org_id;
        const status = sub.status;
        if (!orgId) break;
        // Keep the org tier in sync with the subscription's current
        // line item — this handles tier upgrades / downgrades initiated
        // from the Stripe Customer Portal.
        if (db && (status === 'active' || status === 'trialing')) {
          const tier = await resolveTierFromSubscription(stripe, sub.id);
          if (tier) {
            await db.query(
              `UPDATE organizations
                  SET plan_tier              = $2,
                      concurrent_bot_limit   = $3,
                      stripe_subscription_id = $4
                WHERE id = $1`,
              [orgId, tier.key, tier.concurrentBotLimit, sub.id]
            );
            console.log(`[stripe webhook] org ${orgId} sub ${sub.id} → ${tier.key} (${status})`);
          }
        } else {
          console.log(`[stripe webhook] org ${orgId} sub ${sub.id} status=${status} — no tier change`);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const orgId = sub.metadata?.org_id;
        if (orgId && db) {
          await db.query(
            `UPDATE organizations
                SET plan_tier               = 'canceled',
                    concurrent_bot_limit    = 0,
                    trial_minutes_remaining = 0,
                    stripe_subscription_id  = NULL
              WHERE id = $1`,
            [orgId]
          );
          console.log(`[stripe webhook] org ${orgId} subscription canceled — bot dispatch disabled`);
        }
        break;
      }

      default:
        console.log(`[stripe webhook] ignored event: ${event.type}`);
    }
  } catch (err) {
    console.error('[stripe webhook] handler error:', err);
    // Still 200 — Stripe shouldn't retry on our internal failures.
  }

  res.json({ received: true });
});

/**
 * Helper — given a Stripe subscription id, pull the subscription, find
 * the first line item's price id, and look up our tier definition.
 * Returns null if we can't resolve (unconfigured price id, API error).
 */
async function resolveTierFromSubscription(stripeService, subscriptionId) {
  try {
    const sub = await stripeService.client.subscriptions.retrieve(subscriptionId);
    const priceId = sub.items?.data?.[0]?.price?.id;
    if (!priceId) return null;
    return stripeService.tierForPriceId(priceId);
  } catch (err) {
    console.error(`[stripe webhook] resolveTierFromSubscription(${subscriptionId}) failed:`, err.message);
    return null;
  }
}

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
