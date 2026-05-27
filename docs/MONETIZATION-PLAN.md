# Monetization Plan

**Status:** Future work — captured here so the architectural decisions
can ripen while the app gets real-event experience.
**Driver:** Recall.ai bills RYTE per bot-hour (~$0.50/hr). At scale this
needs to be passed on to customers with a margin, otherwise every event
loses money.

---

## The shape of the work

Three big new systems on top of the existing app, in this order:

1. **Multi-tenant auth + org isolation** (foundational; nothing else
   ships without this)
2. **Usage tracking** (the bot-hours we'll bill on)
3. **Stripe Billing** (the actual money flow)

Plus customer-facing dashboard surfaces and a handful of policy
decisions to make before touching code.

**Realistic effort to get from current state to "charging real
customers": 4–6 weeks of focused dev work + ~2 weeks of legal/policy
(ToS, privacy policy, support process).**

---

## Decisions to make first (blocks implementation)

### 1. Recall workspace model

| | Shared workspace (Otter / Fireflies model) | Per-customer Recall account |
|---|---|---|
| Customer onboarding | One signup (yours) | Two signups (yours + Recall's) |
| Cost flow | Recall bills us, we bill customer w/ markup | Customer pays Recall directly + us for software |
| Cost float | We carry it until invoicing | None |
| Customer experience | Cleaner | Worse |
| Liability for abuse | Falls to us (one bad actor → our workspace flagged) | Their account, their problem |
| Pricing flexibility | We control fully | Customer sees two line items |
| Volume discounts | We can negotiate with Recall as we grow | Customer doesn't benefit |

**Recommendation: shared workspace.** Matches what every comparable
tool does (Otter, Fireflies, Read.ai, Tactiq). The cost float is
manageable if we charge monthly upfront for base tiers.

### 2. Pricing model

| Model | Description | Pro | Con |
|---|---|---|---|
| Pure metered | $X per bot-hour, no monthly fee | Fair, no commitment | Hard to predict revenue; customer churn-risk |
| Flat monthly | Fixed price regardless of usage | Predictable revenue | High-usage customers eat margin |
| **Tiered + overage** | Monthly tier includes N hours; pay-per-hour after | Best of both | More complex to communicate |

**Recommendation: tiered + overage.** Standard SaaS pricing, lets
customers self-select.

Draft tiers (assumes ~$0.50/hr Recall cost basis, ~2–3× markup):

| Tier | Monthly | Included | Overage | Target customer |
|---|---|---|---|---|
| **Solo** | $49 | 50 bot-hours | $1.50/hr | Single producer doing a few events/month |
| **Pro** | $199 | 250 bot-hours | $1.00/hr | Small production company (RYTE's own profile) |
| **Studio** | $499 | 750 bot-hours | $0.80/hr | Full-time events team / agency |

These numbers are *starting points* — A/B with the first 5–10
customers, adjust on real feedback.

### 3. Auth provider

| Option | Effort | Cost | Notes |
|---|---|---|---|
| **Clerk** | ~1 day to integrate | ~$25/mo + per-user | Hosted UI, OAuth, MFA, password reset out of box |
| **Supabase Auth** | ~2–3 days | Free up to 50K MAU | Includes Postgres, but we already have Railway PG |
| **Auth0** | ~2 days | ~$25/mo + per-user | Heavier UI, more enterprise-oriented |
| **Roll own** (Passport + bcrypt) | ~1 week | Free | Maintenance burden, password reset / email verify / MFA all on us |

**Recommendation: Clerk.** The "hosted login UX + drop-in React
components + their dashboard for user management" is worth the $25
floor. Switching auth providers later is not impossibly hard if needs
change.

---

## Recommended architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Customer browser / desktop .app                            │
│                                                             │
│   ┌──────────────┐  ┌──────────────┐                       │
│   │ Clerk login  │→ │ React UI     │                       │
│   │ widget       │  │ (existing)   │                       │
│   └──────────────┘  └──────────────┘                       │
└────────┬────────────────────┬───────────────────────────────┘
         │ Clerk JWT          │ socket.io
         ▼                    ▼
┌─────────────────────────────────────────────────────────────┐
│  Railway: Express server                                    │
│                                                             │
│   * Verify Clerk JWT, attach user/org to each request       │
│   * All DB queries filtered by org_id                       │
│   * Bot dispatch: tagged with org_id + tracked              │
│   * Stripe webhooks: subscription updates                   │
│   * Recall webhooks: bot status changes → usage records     │
└────────┬─────────────┬──────────────────────────────────────┘
         │             │                   │
         ▼             ▼                   ▼
   ┌──────────┐  ┌──────────┐       ┌──────────┐
   │ Postgres │  │ Recall   │       │ Stripe   │
   │ +org_id  │  │ (shared  │       │ Billing  │
   │  on all  │  │  ws)     │       │          │
   │  tables  │  │          │       │          │
   └──────────┘  └──────────┘       └──────────┘
```

### Database schema additions

```sql
CREATE TABLE organizations (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  clerk_org_id        TEXT UNIQUE,                  -- maps to Clerk
  stripe_customer_id  TEXT UNIQUE,                  -- maps to Stripe
  plan_tier           TEXT NOT NULL DEFAULT 'solo', -- solo|pro|studio
  included_bot_hours  INTEGER NOT NULL DEFAULT 50,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE users (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  clerk_user_id       TEXT UNIQUE,
  email               TEXT NOT NULL,
  role                TEXT NOT NULL DEFAULT 'operator',  -- admin|operator
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE bot_usage (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  session_id          TEXT REFERENCES sessions(id),
  recall_bot_id       TEXT NOT NULL,
  meeting_id          TEXT,
  joined_at           TIMESTAMPTZ NOT NULL,
  left_at             TIMESTAMPTZ,
  duration_minutes    INTEGER,  -- computed when left_at lands
  billed              BOOLEAN NOT NULL DEFAULT FALSE,
  stripe_usage_record_id TEXT
);

-- Add org_id to existing tables
ALTER TABLE sessions  ADD COLUMN org_id TEXT REFERENCES organizations(id);
ALTER TABLE messages  ADD COLUMN org_id TEXT REFERENCES organizations(id);

-- Indices
CREATE INDEX idx_bot_usage_org_billing ON bot_usage(org_id, billed, left_at);
CREATE INDEX idx_sessions_org          ON sessions(org_id);
CREATE INDEX idx_messages_org          ON messages(org_id);
```

### Usage tracking flow

1. When operator clicks "Connect to Meeting", we call Recall's bot API
   (already do this). Also insert a row into `bot_usage` with
   `joined_at = NOW()`, `org_id = current user's org`,
   `recall_bot_id = bot.id`.
2. Subscribe to Recall's `bot.status_change` webhook (new — we don't
   currently). When status hits `done` / `kicked` / `error`, update
   the row with `left_at = NOW()` and `duration_minutes = computed`.
3. Hourly cron job: query `bot_usage WHERE billed = FALSE AND left_at
   IS NOT NULL`, group by `org_id`, sum minutes, report to Stripe
   metered subscription API, mark rows `billed = TRUE`.

### Stripe Billing setup

- Create Products: "ZoomChat Solo", "Pro", "Studio"
- Each has two Prices: monthly recurring + metered ("$1.50/bot-hour
  overage" — different per tier)
- Customer subscribes via Stripe Checkout; webhook updates
  `organizations.plan_tier` and `included_bot_hours`
- Usage records sent hourly via `stripe.subscriptionItems.createUsageRecord`
- Customer dashboard pulls current-month usage via Stripe API or our
  own `bot_usage` aggregation
- Failed payments handled by Stripe's dunning emails + auto-downgrade
  to suspended state after grace period

---

## Phased implementation plan

### Phase 1: Auth + org isolation (1–2 weeks)
- Integrate Clerk (server-side JWT verification + React `<ClerkProvider>`)
- Add `organizations` + `users` tables; add `org_id` to existing tables
- Middleware on every API route: extract user from Clerk JWT, attach
  `req.org_id`
- Update every DB query to filter by `req.org_id`
- Sign-up flow: new Clerk org → row in `organizations` (default tier:
  Solo trial)
- **Ship gate:** existing functionality works exactly the same when
  logged in as the single existing operator (RYTE)

### Phase 2: Usage tracking (3–5 days)
- New table: `bot_usage`
- Insert row on bot dispatch (`/api/meetings/connect`)
- Subscribe to Recall `bot.status_change` webhook; route updates the
  matching `bot_usage` row
- Operator dashboard: "Current month: X bot-hours used of Y included"
  — read from `bot_usage`
- **Ship gate:** we can answer "how many bot-hours did org X use this
  month?" with a single SQL query

### Phase 3: Stripe Billing (3–5 days)
- Create Stripe products + prices via dashboard
- Stripe Checkout integration on signup flow ("pick a plan")
- Webhook handler for `customer.subscription.updated` →
  `organizations.plan_tier` sync
- Hourly cron (Railway cron or simple `setInterval`) reports overage
  usage to Stripe
- Customer dashboard: invoices, current bill, payment method (use
  Stripe's Customer Portal — hosted, no code)
- **Ship gate:** end-to-end paid customer signs up, runs bots, gets
  charged correctly at month-end

### Phase 4: Polish + safety (~1 week)
- Hard cap on bot-hours per month per tier (prevents runaway costs)
- Email alerts at 80% / 100% of included hours
- Admin dashboard for Theo: list of orgs, MRR, total Recall cost,
  margin per org
- Customer-facing usage chart (last 30 days bot-hours per session)
- Auto-disconnect bots after configurable max-meeting-length (4hrs
  default) — backstop against forgotten bots
- **Ship gate:** Theo can see at a glance which customers are
  profitable and which are losing money on overage

### Phase 5: Legal / business / launch (~1–2 weeks, not code)
- Terms of Service + Privacy Policy (use a templated service like
  Iubenda or hire a startup-friendly lawyer for ~$1–2K)
- Data Processing Agreement template for enterprise customers
- Refund / cancellation policy
- Support process: dedicated email, response-time commitment
- Onboarding email sequence (first run guide, video walkthrough)
- Launch channel: ProductHunt? Direct outreach to event production
  companies? Twitter?

---

## Cost analysis at draft pricing

Assumes ~$0.50/bot-hour Recall cost.

| Tier | Monthly fee | Hours incl. | Recall cost @ all-incl. | Margin @ all-incl. | Margin % |
|---|---|---|---|---|---|
| Solo | $49 | 50 | $25 | $24 | 49% |
| Pro | $199 | 250 | $125 | $74 | 37% |
| Studio | $499 | 750 | $375 | $124 | 25% |

Margins compress at higher tiers (intentional — volume discount), but
the overage fee at higher tiers also has lower COGS coverage, so:

| Tier | Overage rate | Recall COGS | Overage margin % |
|---|---|---|---|
| Solo | $1.50/hr | $0.50 | 67% |
| Pro | $1.00/hr | $0.50 | 50% |
| Studio | $0.80/hr | $0.50 | 38% |

A customer using their full Pro allocation (250 hrs) + 100 hrs
overage = $199 + $100 = $299, costing us 350 × $0.50 = $175. Net
margin: 41%. Healthy.

**Breakeven** on infrastructure (Railway Hobby + Postgres ~$5/mo,
Clerk ~$25/mo, Recall): we need ~$60 MRR to cover fixed costs. That's
**one Solo customer**. Pro tier customers are pure margin after that.

---

## Open questions for Theo (decisions before Phase 1)

1. **Single Recall workspace or per-customer?**
   (recommended: shared, but you may have reasons to keep things
   separate — e.g. compliance, liability concerns)
2. **Pricing tiers — accept the draft above, or adjust?**
   The big variable is "how do RYTE's competitor tools price this?"
   Worth a quick survey of Otter / Fireflies / Tactiq / Read.ai / Vexa
   etc. before committing to numbers.
3. **Free trial?** "14 days, 25 bot-hours, no credit card" is the
   industry norm. Or freemium "always-free Solo tier with 5
   bot-hours/month"? Or no free anything?
4. **Custom enterprise tier?** Some buyers (large events teams) will
   want invoicing, SSO, dedicated support. Add a "Contact Sales"
   option above Studio.
5. **Multi-user per org from day one, or operator-only?**
   Most ops tools are multi-user. RYTE might start single-user per
   org and add team accounts later.
6. **Where do you want to host customer support / docs?**
   Intercom, Help Scout, plain email, Notion-based docs? This shapes
   the "Help" links in the React UI.

---

## What we could do *right now* to make Phase 1 easier later

Two small no-regret moves that don't require committing to any of the
above:

1. **Subscribe to Recall's `bot.status_change` webhook today and log
   the joined_at / left_at to a simple log table.** Even without
   billing, this gives us 1-2 weeks of real bot-duration data to
   inform pricing decisions before Phase 1 starts.
2. **Add a `tenant_id` placeholder column** (default `'ryteproductions'`)
   to sessions / messages / saved. When Phase 1 lands, the migration
   to real org_ids is a one-line UPDATE instead of a schema change.

Neither is urgent — flagging them so they don't get re-discovered as
"oh, we should have done that earlier" later.
