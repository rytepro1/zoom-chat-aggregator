# Stripe

> Subscription billing layer for RYTE Chat Aggregator — handles plan upgrades, customer portal, and subscription lifecycle webhooks. Pinned to Node SDK `stripe ^22.2`, API version `2025-04-30.basil`.

---

## How we use it

### Integration end-to-end

1. **Startup** (`src/server/index.js:59-62`): `StripeService` is instantiated with `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` from env, and stored on the Express app with `app.set('stripeService', ...)`. The `db` handle is injected later in `start()` at line 604 so the service can write `stripe_customer_id` back to Postgres.

2. **Tier definitions** (`src/services/tiers.js`): Three billable plans are declared as a static map (`TIERS`). Each tier carries a `priceEnvVar` pointing at the env var that holds the Stripe Price ID (`STRIPE_PRICE_ID_SOLO`, `STRIPE_PRICE_ID_PRO`, `STRIPE_PRICE_ID_STUDIO`). Price IDs are never hardcoded; they are resolved at call-time by reading `process.env[tier.priceEnvVar]`. The `availableTiers()` helper (used by `GET /api/billing/tiers`) filters to only tiers whose env var is set, so the upgrade page is dynamic.

3. **Checkout flow** (`src/routes/billing.js:35-63`, `src/services/StripeService.js:65-85`):
   - Client posts `{ tier }` to `POST /api/billing/checkout`.
   - Server calls `StripeService.createCheckoutSession()`, which first calls `getOrCreateCustomer()` to upsert a Stripe Customer, then calls `stripe.checkout.sessions.create()` in `subscription` mode.
   - Key session params: `customer`, `mode: 'subscription'`, `line_items: [{ price: priceId, quantity: 1 }]`, `success_url`, `cancel_url`, `allow_promotion_codes: true`, `metadata: { org_id, tier_key }`, `subscription_data.metadata: { org_id, tier_key }`.
   - Response: `{ url, sessionId, tier }`. The route returns just `{ url }` to the client, which redirects.

4. **Customer portal** (`src/routes/billing.js:66-84`, `src/services/StripeService.js:87-97`):
   - Client posts to `POST /api/billing/portal`.
   - Server calls `stripe.billingPortal.sessions.create({ customer, return_url })`.
   - Returns `{ url }`; client redirects to Stripe-hosted portal where the customer can cancel, change payment method, switch tiers, or download invoices.

5. **Webhook handler** (`src/routes/webhook.js:213-322`):
   - `POST /webhook/stripe` receives Stripe events. Raw body is captured via the `verify` hook on `express.json()` (`src/server/index.js:80-83`): `req.rawBody = buf`.
   - Signature verified via `stripe.webhooks.constructEvent(req.rawBody, req.headers['stripe-signature'], webhookSecret)`.
   - Three events handled: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`.
   - On `checkout.session.completed`: reads `session.metadata.org_id` and `session.subscription`, resolves tier (fast path: `session.metadata.tier_key`; fallback: fetches subscription from Stripe and maps `items.data[0].price.id` via `tierForPriceId()`), then UPDATEs `organizations` with `plan_tier`, `concurrent_bot_limit`, `trial_minutes_remaining = NULL`, and `stripe_subscription_id`.
   - On `customer.subscription.updated` (status `active` or `trialing`): re-fetches subscription, resolves tier, UPDATEs org. Handles portal-initiated upgrades/downgrades.
   - On `customer.subscription.deleted`: sets `plan_tier = 'canceled'`, `concurrent_bot_limit = 0`, `trial_minutes_remaining = 0`, `stripe_subscription_id = NULL`.
   - Always returns `200` for accepted events (even on internal errors) so Stripe does not retry on application bugs. Returns `400` only for signature verification failures.

6. **Bot-dispatch enforcement**: `TrialEnforcer.checkCanDispatch()` reads `org.concurrentBotLimit` from the DB (set by webhooks above) to gate `POST /api/meetings/connect` and `POST /api/rosters/:id/deploy`. No Stripe API calls at request time — all enforcement uses the DB copy.

---

## Core concepts

**Customer** (`cus_*`): Stripe entity representing an organization. We create one per org via `customers.create()` and store the ID in `organizations.stripe_customer_id`. Creating twice with the same email produces two separate Stripe Customers — Stripe does not deduplicate by email.

**Price** (`price_*`): Defines the recurring amount and interval (e.g., $49.99/month). Price IDs are environment-specific: test mode prices start with `price_test_*`, live mode with `price_*`. Swapping env vars is how we move from test to live without code changes.

**Checkout Session** (`cs_*`): Stripe-hosted payment page. Created server-side, returned as a URL. The session expires in 24 hours by default. In `subscription` mode, a successful checkout creates a Subscription and fires `checkout.session.completed`.

**Subscription** (`sub_*`): The recurring billing contract. Status values relevant to us: `active`, `trialing`, `past_due`, `canceled`, `incomplete`, `incomplete_expired`, `unpaid`, `paused`. We write to the DB on `active` and `trialing`; we do not currently handle `past_due` or `unpaid`.

**Customer Portal**: Stripe-hosted UI. Customers can cancel, update payment methods, switch plans (up to 10 products must be configured in the portal configuration in the Stripe dashboard), and download invoices. Plan switches fire `customer.subscription.updated`.

**Webhook endpoint secret** (`whsec_*`): Each registered webhook endpoint in the Stripe dashboard has its own secret. This is distinct from the API secret key.

**Metadata**: Up to 50 key-value pairs, max 500 chars combined value length. We write `org_id` and `tier_key` on both the Checkout Session and the Subscription's `subscription_data.metadata`. This is the fast-path for resolving which org/tier a webhook event belongs to.

---

## API / SDK surface we touch

| Method | Purpose | Used |
|---|---|---|
| `stripe.customers.create()` | Create Stripe Customer for new org | Yes |
| `stripe.checkout.sessions.create()` | Create Checkout Session (subscription mode) | Yes |
| `stripe.billingPortal.sessions.create()` | Create Customer Portal session | Yes |
| `stripe.webhooks.constructEvent()` | Verify webhook signature + parse event | Yes |
| `stripe.subscriptions.retrieve()` | Fetch subscription to resolve tier from price ID (fallback path) | Yes (indirect, via `resolveTierFromSubscription`) |
| `stripe.customers.list()` | Search for existing customers | No |
| `stripe.subscriptions.update()` | Programmatically change tier | No (portal handles this) |
| `stripe.coupons.create()` | Create comp/promo coupons | No |
| `stripe.promotionCodes.*` | Manage promo codes | No |
| `stripe.invoices.*` | Invoice management | No |
| `stripe.prices.create()` | Create prices | No (done in dashboard) |

### Webhook events handled

| Event | Trigger | Our action |
|---|---|---|
| `checkout.session.completed` | Customer completes Stripe Checkout | Upgrade org plan, set bot limit, clear trial |
| `customer.subscription.updated` | Subscription changes (portal upgrade/downgrade, renewal status) | Sync tier when status is `active` or `trialing` |
| `customer.subscription.deleted` | Subscription canceled and period has ended | Set org to `canceled`, zero bot limit |

### Webhook events NOT handled (but worth adding)

| Event | Why it matters |
|---|---|
| `invoice.payment_failed` | No user notification or grace period handling; subscription goes `past_due` silently |
| `customer.subscription.trial_will_end` | No warning email before trial converts |
| `checkout.session.expired` | Not tracked; user left checkout silently |

---

## Auth & secrets

| Env var | Purpose | Where resolved |
|---|---|---|
| `STRIPE_SECRET_KEY` | Server-side API auth (`sk_live_*` or `sk_test_*`) | `StripeService` constructor (`src/services/StripeService.js:20-24`) |
| `STRIPE_WEBHOOK_SECRET` | Webhook signature verification (`whsec_*`) | `StripeService.verifyWebhook()` (`src/services/StripeService.js:99-104`) |
| `STRIPE_PRICE_ID_SOLO` | Stripe Price ID for Solo tier ($49.99/mo) | `tiers.js:36`, resolved at checkout session creation time |
| `STRIPE_PRICE_ID_PRO` | Stripe Price ID for Pro tier ($199/mo) | `tiers.js:46` |
| `STRIPE_PRICE_ID_STUDIO` | Stripe Price ID for Studio tier ($499/mo) | `tiers.js:56` |

`APP_URL` is also used to construct `success_url` and `cancel_url` in `src/routes/billing.js:53,74`. Defaults to `https://zoomchat.ryteproductions.com` if unset.

**Live vs test mode**: The `STRIPE_SECRET_KEY` value determines the mode. Test keys are `sk_test_*`; live keys are `sk_live_*`. Price IDs are mode-specific — you must create separate prices in test and live Stripe dashboards, then set different env vars per environment. The webhook secret is also per-endpoint and per-mode (Stripe creates separate endpoint registrations for test and live).

**Secret storage**: In production, all secrets live in Railway environment variables. They are not committed to the repo — `.env.example` documents the variable names but not values.

---

## Webhooks / events

### Route and middleware

`POST /webhook/stripe` is mounted at `src/server/index.js:121` before any auth middleware. It is NOT behind `requireAuth`.

Raw body is captured globally via the `verify` callback on `express.json()`:

```js
// src/server/index.js:80-83
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
```

This means `req.rawBody` is a `Buffer` on every request, not just webhook routes.

### Signature verification

```js
// src/services/StripeService.js:99-104
verifyWebhook(rawBody, signature) {
  if (!this.webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET not configured');
  return this.client.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
}
```

`constructEvent` validates the HMAC-SHA256 signature and checks the timestamp is within the default 5-minute tolerance window. Returns the parsed event object or throws `Stripe.errors.StripeSignatureVerificationError`.

### checkout.session.completed payload (key fields)

```
event.type: 'checkout.session.completed'
event.data.object: {
  id: 'cs_...',
  mode: 'subscription',
  customer: 'cus_...',
  subscription: 'sub_...',       // ID, not expanded
  metadata: { org_id, tier_key },
  payment_status: 'paid'
}
```

Note: `session.subscription` is a string ID in the `checkout.session.completed` event. We call `stripe.subscriptions.retrieve(subscriptionId)` in the fallback path only (when `tier_key` metadata is absent).

### customer.subscription.updated / deleted payload (key fields)

```
event.data.object: {
  id: 'sub_...',
  status: 'active' | 'trialing' | 'past_due' | 'canceled' | ...,
  customer: 'cus_...',
  metadata: { org_id, tier_key },
  items: {
    data: [{
      price: { id: 'price_...', unit_amount: 4999, recurring: { interval: 'month' } }
    }]
  },
  cancel_at_period_end: false,
  canceled_at: null
}
```

`cancel_at_period_end: true` means the subscription will cancel at period end but is still `active` now. The `customer.subscription.deleted` event fires when the period actually ends, not when the user initiates cancellation. Our handler does not distinguish `cancel_at_period_end` on the `updated` event — this is correct; we should only revoke access on `deleted`.

### Event context field (new in 2025-04-30.basil)

Stripe added a `context` field to all event payloads in this version. Our code does not use it; it is harmless.

### Retry behavior

- Live mode: Stripe retries for up to 3 days with exponential backoff.
- Test/sandbox: 3 retries over a few hours.
- Each retry carries a new `Stripe-Signature` header (new timestamp + recomputed HMAC). Our idempotency relies on the DB `UPDATE` being idempotent (same tier key → same DB values), not on event ID deduplication.

---

## Version-specific notes (API 2025-04-30.basil)

This is the GA release we pin. Key facts:

- **No breaking changes in this GA release.** Breaking changes landed in `2025-03-31.basil`. Upgrading to Basil from a pre-Basil version is safe for our usage surface.
- **New `context` field on all event payloads.** Added in this version. Our code ignores it — no impact.
- **New `ping` event type** for testing webhook endpoints. Useful for verifying our `/webhook/stripe` endpoint is reachable.
- **Affirm support for subscriptions.** Not relevant to us unless we want to add Affirm as a payment method — currently not configured.
- **`allow_promotion_codes: true` behavior**: This parameter works as before (user-redeemable promo codes shown in Checkout). Our use of it is unaffected by Basil.
- **Preview-only features in Basil** that we do NOT use: `billing_mode[type]=flexible`, third-party tax providers, Global Payouts API. The `flexible` billing mode is recommended in the docs for new integrations but is preview-only — do not enable it without testing since it changes proration and invoice behavior.
- **API version is pinned in the SDK constructor** (`src/services/StripeService.js:24`): `{ apiVersion: '2025-04-30.basil' }`. This overrides the account default. All requests from our server use this version. Webhook event shapes are determined by the account's default API version set in the Stripe dashboard, NOT by our SDK pin — to get Basil-shaped webhook payloads, the Stripe dashboard must also be set to `2025-04-30.basil` for the webhook endpoint.

---

## Rate limits / quotas / scaling

| Limit | Value |
|---|---|
| Global live mode | 100 requests/second |
| Global sandbox | 25 requests/second |
| Subscriptions: new invoices per subscription | 10/minute, 20/day |
| Subscriptions: quantity updates per subscription | 200/hour |
| Search API | 20 reads/second |

Our current usage pattern: one Stripe API call per user-initiated checkout or portal open, plus one `subscriptions.retrieve()` call per webhook event that lacks `tier_key` metadata. No polling, no batch operations. We are nowhere near rate limits at current scale.

If we add proration previews or invoice listing to the UI, the rate limit for those list/preview endpoints becomes relevant.

---

## Gotchas & failure modes

**1. Duplicate Stripe Customers**
`getOrCreateCustomer()` (`src/services/StripeService.js:46-63`) guards against creating a duplicate only if `org.stripeCustomerId` is already set in memory. If a row in the DB has `stripe_customer_id = NULL` and two concurrent checkout requests arrive before the first one writes back, two Stripe Customers can be created for the same org. Stripe does not deduplicate by email. The second checkout will orphan the first customer.

**2. Webhook event ordering is not guaranteed**
Stripe can deliver `customer.subscription.updated` before `checkout.session.completed` (e.g., if the completed event retries). Our handler for `updated` calls `resolveTierFromSubscription()`, which is resilient, but if `org_id` is not yet in the sub metadata (out-of-band subscription), we silently skip (`if (!orgId) break`).

**3. No idempotency key on customer creation**
We do not pass an `Idempotency-Key` header when calling `customers.create()`. A network retry on the checkout flow could create a second customer if the first request timed out but succeeded on Stripe's side.

**4. `resolveTierFromSubscription` makes a live API call in the webhook handler**
`src/routes/webhook.js:329-338` calls `stripeService.client.subscriptions.retrieve(subscriptionId)` synchronously inside the webhook handler. If Stripe's API is slow or rate-limited, this adds latency to the webhook acknowledgment. The recommended pattern is to return `200` immediately and process asynchronously, but we return `200` after all DB writes complete — low risk at current load.

**5. Webhook handler returns `200` even on DB errors**
`src/routes/webhook.js:316-320`: the outer `try/catch` logs but doesn't propagate, so a Postgres write failure is swallowed. Stripe won't retry the event, and the org's plan won't be updated. There is no dead-letter queue or alerting.

**6. Canceled subscriptions cannot be reactivated**
Once `customer.subscription.deleted` fires and we set `plan_tier = 'canceled'`, the customer must start a new Checkout Session to re-subscribe. The existing Stripe Customer is still valid (`cus_*` persists), so `getOrCreateCustomer()` will reuse it. This works correctly.

**7. `past_due` and `unpaid` statuses are unhandled**
When a renewal payment fails, the subscription transitions to `past_due` and a `customer.subscription.updated` event fires. Our handler checks `status === 'active' || status === 'trialing'` (`src/routes/webhook.js:276`) and does nothing for `past_due`. The customer retains full access until the subscription is eventually canceled. This is a billing leak.

**8. No "first event free" comp / coupon implemented**
The docs comment in `StripeService.js:13` mentions "coupons/promo codes (our 'first event free' comp)" but `allow_promotion_codes: true` merely allows users to enter promo codes they already have. No coupon is auto-applied. If the intent is to give new users a free trial event, this must be done either via Stripe trial period on the subscription or by issuing a promotion code manually and distributing it.

**9. Portal requires dashboard configuration**
`billingPortal.sessions.create()` requires a Customer Portal configuration to be activated in the Stripe dashboard. If it hasn't been configured (logo, business info, allowed products for switching), the API call returns a `400`. This is a deployment step, not a code step — must be done once per Stripe account (live and test).

**10. Checkout Session `success_url` does not include `{CHECKOUT_SESSION_ID}`**
`src/routes/billing.js:56`: `successUrl: \`${appUrl}/?upgrade=success\`` — the URL does not include the `{CHECKOUT_SESSION_ID}` template variable. Stripe recommends including it so you can look up the completed session on the success page if needed. Not strictly required if you trust webhooks, but makes debugging easier.

**11. Test vs live mode mix**
If `STRIPE_SECRET_KEY` is a test key but `STRIPE_PRICE_ID_*` holds a live Price ID, checkout sessions will fail with a `resource_missing` error. If `STRIPE_WEBHOOK_SECRET` is from a test endpoint and the live Stripe dashboard sends to production, signature verification will fail. Both are subtle mis-configurations.

---

## Risks / TODOs in our current code

| Risk | Location | Severity |
|---|---|---|
| Race condition creating duplicate Stripe Customers | `src/services/StripeService.js:46-63` | Medium — could happen on concurrent checkout if `stripe_customer_id` is NULL in DB |
| No idempotency key on `customers.create()` | `src/services/StripeService.js:50-53` | Low — network retries could duplicate customers |
| Webhook DB write failures silently swallowed, no alerting | `src/routes/webhook.js:316-320` | High — plan not updated, Stripe won't retry |
| `past_due` / `unpaid` subscription statuses not handled | `src/routes/webhook.js:276` | Medium — customers with failed payments retain access |
| No event ID deduplication; DB UPDATE idempotency assumed | `src/routes/webhook.js:229-320` | Low — UPDATE is idempotent only if tier resolves to same value |
| `resolveTierFromSubscription` blocking API call inside webhook handler | `src/routes/webhook.js:329-338` | Low (today), Medium at scale |
| `success_url` lacks `{CHECKOUT_SESSION_ID}` placeholder | `src/routes/billing.js:56` | Low — no functional breakage, limits debug capability |
| `invoice.payment_failed` event not handled; no dunning logic | Entire webhook handler | Medium — billing leak on renewal failures |
| Portal "allowed products" must be configured in Stripe dashboard | Deployment | Deployment blocker if not done |
| Webhook event shapes depend on Stripe dashboard API version setting | Deployment | Deployment blocker — must match `2025-04-30.basil` |
| No Stripe-specific error handling in `createCheckoutSession` beyond generic `err.message` | `src/routes/billing.js:59-62` | Low — Stripe errors have a `type` and `code` that could improve UX |

---

## Key links

- [Stripe API reference](https://docs.stripe.com/api)
- [Subscriptions guide](https://docs.stripe.com/billing/subscriptions/build-subscriptions)
- [Checkout Sessions — create (subscription mode)](https://docs.stripe.com/api/checkout/sessions/create)
- [Customer Portal guide](https://docs.stripe.com/billing/subscriptions/customer-portal)
- [Billing Portal Sessions — create](https://docs.stripe.com/api/customer_portal/sessions/create)
- [Webhook signature verification](https://docs.stripe.com/webhooks/best-practices)
- [Webhook event types](https://docs.stripe.com/api/events/types)
- [Subscription object](https://docs.stripe.com/api/subscriptions/object)
- [Rate limits](https://docs.stripe.com/rate-limits)
- [Basil changelog](https://docs.stripe.com/changelog/basil)
- [API upgrades guide](https://docs.stripe.com/upgrades)
