import { Router } from 'express';
import { availableTiers, getTier } from '../services/tiers.js';

/**
 * Billing routes — Stripe Checkout + Customer Portal.
 *
 * - GET  /api/billing/tiers    : returns the list of purchasable tiers
 *   (filtered to those whose Stripe Price ID env var is set). UI uses
 *   this to render the Upgrade page dynamically — adding a tier just
 *   means setting its env var + price ID in Stripe, no code change.
 * - POST /api/billing/checkout : { tier } body → returns { url }
 *   pointing at Stripe-hosted Checkout. Client redirects.
 * - POST /api/billing/portal   : returns { url } for Stripe-hosted
 *   Customer Portal (cancel, change payment method, download invoices,
 *   upgrade/downgrade between tiers).
 *
 * All require auth (mounted under /api with requireAuth applied).
 */
export default function billingRouter() {
  const router = Router();

  router.get('/tiers', async (req, res) => {
    res.json({
      tiers: availableTiers().map(t => ({
        key: t.key,
        name: t.name,
        priceDisplay: t.priceDisplay,
        concurrentBotLimit: t.concurrentBotLimit,
        features: t.features,
        tagline: t.tagline,
      })),
    });
  });

  router.post('/checkout', async (req, res) => {
    const stripe = req.app.get('stripeService');
    if (!stripe?.isConfigured()) {
      return res.status(503).json({ error: 'Billing is not configured on this server.' });
    }
    if (!req.org || !req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const tierKey = req.body?.tier;
    const tier = getTier(tierKey);
    if (!tier) {
      return res.status(400).json({ error: `Unknown tier "${tierKey}". Pick one of: solo, pro, studio.` });
    }
    if (req.org.planTier === tier.key) {
      return res.status(400).json({ error: `You're already on ${tier.name}.` });
    }

    const appUrl = (process.env.APP_URL || 'https://zoomchat.ryteproductions.com').replace(/\/$/, '');
    try {
      const { url } = await stripe.createCheckoutSession(req.org, req.user.email, tier.key, {
        successUrl: `${appUrl}/?upgrade=success`,
        cancelUrl: `${appUrl}/upgrade?canceled=1`,
      });
      return res.json({ url });
    } catch (err) {
      console.error('[billing] checkout session failed:', err.message);
      return res.status(500).json({ error: err.message || 'Failed to start checkout. Please try again.' });
    }
  });

  router.post('/portal', async (req, res) => {
    const stripe = req.app.get('stripeService');
    if (!stripe?.isConfigured()) {
      return res.status(503).json({ error: 'Billing is not configured on this server.' });
    }
    if (!req.org || !req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const appUrl = (process.env.APP_URL || 'https://zoomchat.ryteproductions.com').replace(/\/$/, '');
    try {
      const { url } = await stripe.createPortalSession(req.org, {
        returnUrl: `${appUrl}/`,
      });
      return res.json({ url });
    } catch (err) {
      console.error('[billing] portal session failed:', err.message);
      return res.status(500).json({ error: err.message || 'Failed to open billing portal.' });
    }
  });

  return router;
}
