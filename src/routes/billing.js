import { Router } from 'express';

/**
 * Billing routes — Stripe Checkout + Customer Portal.
 *
 * - POST /api/billing/checkout : returns { url } pointing at Stripe-hosted
 *   Checkout for the Solo $49/mo subscription. Client redirects.
 * - POST /api/billing/portal   : returns { url } for Stripe-hosted Customer
 *   Portal (cancel, change payment method, download invoices). Stripe
 *   owns the whole UI — no code on our side.
 *
 * Both require auth (mounted under /api which has requireAuth applied
 * in src/server/index.js).
 */
export default function billingRouter() {
  const router = Router();

  router.post('/checkout', async (req, res) => {
    const stripe = req.app.get('stripeService');
    if (!stripe?.isConfigured()) {
      return res.status(503).json({ error: 'Billing is not configured on this server.' });
    }
    if (!req.org || !req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (req.org.planTier === 'solo') {
      return res.status(400).json({ error: "You're already on Solo." });
    }

    const appUrl = (process.env.APP_URL || 'https://zoomchat.ryteproductions.com').replace(/\/$/, '');
    try {
      const { url } = await stripe.createCheckoutSession(req.org, req.user.email, {
        successUrl: `${appUrl}/?upgrade=success`,
        cancelUrl: `${appUrl}/upgrade?canceled=1`,
      });
      return res.json({ url });
    } catch (err) {
      console.error('[billing] checkout session failed:', err.message);
      return res.status(500).json({ error: 'Failed to start checkout. Please try again.' });
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
