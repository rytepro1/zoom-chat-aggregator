import Stripe from 'stripe';
import { TIERS, getTier, tierForPriceId } from './tiers.js';

/**
 * StripeService — thin wrapper around the Stripe SDK with the helpers
 * our routes need:
 *
 *   - getOrCreateCustomer(org, userEmail)
 *   - createCheckoutSession(org, userEmail, tierKey, { successUrl, cancelUrl })
 *   - createPortalSession(org, { returnUrl })
 *   - verifyWebhook(rawBody, signature)
 *   - tierForPriceId(priceId)  (re-exported)
 *
 * Tier price IDs are resolved at call time from env vars (see tiers.js)
 * so swapping STRIPE_PRICE_ID_* env vars for live mode doesn't require
 * a code change.
 */
export class StripeService {
  constructor({ secretKey, webhookSecret, db } = {}) {
    if (!secretKey) {
      console.warn('[Stripe] STRIPE_SECRET_KEY not set — billing disabled');
      this.client = null;
    } else {
      this.client = new Stripe(secretKey, { apiVersion: '2025-04-30.basil' });
    }
    this.webhookSecret = webhookSecret || null;
    this.db = db || null;
  }

  isConfigured() {
    // At least one purchasable tier must have its price ID set.
    return Boolean(this.client && Object.values(TIERS).some(t => process.env[t.priceEnvVar]));
  }

  /** Look up a tier and its env-resolved Stripe Price ID. Throws if missing. */
  _resolvePrice(tierKey) {
    const tier = getTier(tierKey);
    if (!tier) throw new Error(`Unknown tier: ${tierKey}`);
    const priceId = process.env[tier.priceEnvVar];
    if (!priceId) {
      throw new Error(`Tier "${tier.name}" is not available on this server (${tier.priceEnvVar} not set).`);
    }
    return { tier, priceId };
  }

  async getOrCreateCustomer(org, userEmail) {
    if (!this.client) throw new Error('Stripe not configured');
    if (org.stripeCustomerId) return org.stripeCustomerId;

    const customer = await this.client.customers.create({
      email: userEmail,
      name: org.name,
      metadata: { org_id: org.id },
    });

    if (this.db) {
      await this.db.query(
        `UPDATE organizations SET stripe_customer_id = $1 WHERE id = $2`,
        [customer.id, org.id]
      );
    }
    return customer.id;
  }

  async createCheckoutSession(org, userEmail, tierKey, { successUrl, cancelUrl }) {
    if (!this.client) throw new Error('Stripe not configured');
    const { tier, priceId } = this._resolvePrice(tierKey);
    const customerId = await this.getOrCreateCustomer(org, userEmail);

    const session = await this.client.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      // Metadata flows through so the webhook can find the org +
      // identify the tier without a price-id round-trip.
      metadata: { org_id: org.id, tier_key: tier.key },
      subscription_data: {
        metadata: { org_id: org.id, tier_key: tier.key },
      },
      allow_promotion_codes: true,
    });
    return { url: session.url, sessionId: session.id, tier: tier.key };
  }

  async createPortalSession(org, { returnUrl }) {
    if (!this.client) throw new Error('Stripe not configured');
    if (!org.stripeCustomerId) {
      throw new Error('No Stripe customer for this organization yet');
    }
    const session = await this.client.billingPortal.sessions.create({
      customer: org.stripeCustomerId,
      return_url: returnUrl,
    });
    return { url: session.url };
  }

  verifyWebhook(rawBody, signature) {
    if (!this.webhookSecret) {
      throw new Error('STRIPE_WEBHOOK_SECRET not configured');
    }
    return this.client.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
  }

  /** Map a Stripe Price ID → tier definition (pass-through). */
  tierForPriceId(priceId) {
    return tierForPriceId(priceId);
  }
}
