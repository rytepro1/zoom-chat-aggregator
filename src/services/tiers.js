/**
 * Tier definitions — the single source of truth for what each paid
 * plan includes. The Stripe price IDs come from env vars at runtime so
 * the same code works in test mode and live mode (just swap the env
 * vars when switching).
 *
 * Each tier:
 *   - `key`: stored in `organizations.plan_tier`
 *   - `name`: display name for UI
 *   - `priceCents`: display-only; the authoritative price lives on the
 *     Stripe Price object referenced by priceEnvVar
 *   - `priceDisplay`: formatted string the UI shows
 *   - `concurrentBotLimit`: enforced server-side on dispatch
 *   - `priceEnvVar`: env var name holding the Stripe Price ID
 *   - `features`: marketing-style bullet list shown on the upgrade page
 *
 * Special tier keys not represented here:
 *   - `trial`    — assigned at signup; no Stripe involvement
 *   - `admin`    — RYTE org bypass; no Stripe, no enforcement
 *   - `canceled` — post-cancellation; bot dispatch disabled
 */

export const TIERS = {
  solo: {
    key: 'solo',
    name: 'Solo',
    priceCents: 4999,
    priceDisplay: '$49.99/mo',
    concurrentBotLimit: 1,
    priceEnvVar: 'STRIPE_PRICE_ID_SOLO',
    features: [
      '1 concurrent meeting bot',
      'Unlimited bot-hours',
      'Saved messages, PNG quote cards',
      'Rosters + one-click deploy',
      'Presenter display, custom theming',
    ],
    tagline: 'Producer running one room at a time.',
  },
  pro: {
    key: 'pro',
    name: 'Pro',
    priceCents: 19900,
    priceDisplay: '$199/mo',
    concurrentBotLimit: 5,
    priceEnvVar: 'STRIPE_PRICE_ID_PRO',
    features: [
      '5 concurrent meeting bots',
      'Unlimited bot-hours',
      'Everything in Solo',
      'Team invitations (admin + operator roles)',
    ],
    tagline: 'Small production company. Multi-room shows.',
  },
  studio: {
    key: 'studio',
    name: 'Studio',
    priceCents: 49900,
    priceDisplay: '$499/mo',
    concurrentBotLimit: 20,
    priceEnvVar: 'STRIPE_PRICE_ID_STUDIO',
    features: [
      '20 concurrent meeting bots',
      'Unlimited bot-hours',
      'Everything in Pro',
      'Priority support',
    ],
    tagline: 'Agency or multi-stage events.',
  },
};

/** Ordered list for UI rendering (cheapest first). */
export const TIER_ORDER = ['solo', 'pro', 'studio'];

/**
 * Returns the tier definition for a given key, or null if unknown.
 * Trial / admin / canceled return null (they aren't billable tiers).
 */
export function getTier(key) {
  return TIERS[key] || null;
}

/**
 * Resolve a Stripe Price ID back to its tier definition. Used by the
 * webhook handler to figure out which tier a new subscription is for.
 * Reads the env vars fresh each call so a Railway redeploy with new
 * IDs takes effect without a restart of this module.
 */
export function tierForPriceId(priceId) {
  for (const tier of Object.values(TIERS)) {
    if (process.env[tier.priceEnvVar] === priceId) return tier;
  }
  return null;
}

/**
 * List of tiers that are actually purchasable on this server (their env
 * var is set). Used by the UpgradePage so we don't show a tier the
 * operator can't actually buy because we haven't configured Stripe yet.
 */
export function availableTiers() {
  return TIER_ORDER
    .map(k => TIERS[k])
    .filter(t => Boolean(process.env[t.priceEnvVar]));
}
