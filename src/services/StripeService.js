import Stripe from 'stripe';

/**
 * StripeService — thin wrapper around the Stripe SDK with the helpers
 * our routes need:
 *
 *   - getOrCreateCustomer(org, userEmail)  — lazily creates the Stripe
 *     customer record on first checkout, persists customer id to the
 *     org row, returns it on subsequent calls.
 *   - createCheckoutSession(org, userEmail, { successUrl, cancelUrl })
 *     — creates a Stripe-hosted Checkout Session for the Solo $49/mo
 *     subscription. Returns the URL the client should redirect to.
 *   - createPortalSession(org, { returnUrl }) — opens the Stripe-hosted
 *     Customer Portal for cancel/payment-method/invoices. Stripe owns
 *     the whole UI — we just hand the user the URL.
 *   - verifyWebhook(rawBody, signature) — passes through to Stripe's
 *     signature verification; throws on tamper.
 *
 * The single PRICE id (Solo $49/mo) is read from env. When we add Pro
 * and Studio later, this gets parameterized by tier.
 */
export class StripeService {
  constructor({ secretKey, priceIdSolo, webhookSecret, db } = {}) {
    if (!secretKey) {
      console.warn('[Stripe] STRIPE_SECRET_KEY not set — billing disabled');
      this.client = null;
    } else {
      this.client = new Stripe(secretKey, { apiVersion: '2025-04-30.basil' });
    }
    this.priceIdSolo = priceIdSolo || null;
    this.webhookSecret = webhookSecret || null;
    this.db = db || null;
  }

  isConfigured() {
    return Boolean(this.client && this.priceIdSolo);
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

  async createCheckoutSession(org, userEmail, { successUrl, cancelUrl }) {
    if (!this.isConfigured()) throw new Error('Stripe not configured');
    const customerId = await this.getOrCreateCustomer(org, userEmail);

    const session = await this.client.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: this.priceIdSolo, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      // Metadata flows through to the webhook so we can find the org
      // without having to reverse-lookup customer → org.
      metadata: { org_id: org.id },
      subscription_data: {
        metadata: { org_id: org.id },
      },
      // Lets Stripe collect tax info / address if you later enable it
      // in the dashboard. Off for now — no overhead until configured.
      allow_promotion_codes: true,
    });
    return { url: session.url, sessionId: session.id };
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
}
