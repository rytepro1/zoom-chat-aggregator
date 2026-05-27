# Monetization Plan

**Status:** Decisions made (May 2026). Ready to start Phase 1 when
you say go. Real-event usage data being collected now via the
`bot_usage` table (commit `6980d49`) so the pricing tiers below can be
refined against actual numbers before launch.

**Driver:** Recall.ai bills RYTE ~$0.50/bot-hour. Every customer
session has a real cost-of-goods that needs to be passed on with
margin or the tool loses money at scale.

---

## Decisions made

| Question | Decision |
|---|---|
| Recall workspace model | **Shared** — RYTE pays Recall, customer pays RYTE with markup |
| Pricing model | **Tiered**, differentiated by **concurrent bot count** + included hours + overage |
| Free trial | **1 bot, single 30-minute session.** No credit card. Once consumed, must upgrade. |
| Enterprise tier | **Not yet** — revisit when an enterprise customer asks |
| Multi-user per org | **Yes from day one** — orgs have multiple users with roles (admin/operator) |
| Customer support | **Hosted manual** (docs site) + **support email** |
| Auth provider | **Open** — Clerk vs. roll-your-own (see "Auth: Clerk vs. roll-your-own" below for honest comparison; final call is Theo's) |

---

## Pricing v2

The **concurrent bot count** is the primary differentiator (Theo's
insight: "the big upsell is monitoring more than one room"). Included
hours and overage rate scale alongside.

| Tier | Monthly | Concurrent bots | Included bot-hours | Overage rate | Target customer |
|---|---|---|---|---|---|
| **Free trial** | $0 (one-time) | 1 | 30 minutes total | — (cuts off) | Anyone evaluating |
| **Solo** | $49 | 1 | 20 hrs | $1.50/hr | Producer running one room at a time |
| **Pro** | $199 | 5 | 200 hrs | $1.00/hr | Small production company (RYTE's profile) |
| **Studio** | $499 | 20 | 500 hrs | $0.80/hr | Agency / multi-stage events |

### Margin at draft numbers

(All assume Recall costs ~$0.50/bot-hour.)

| Tier | At included max | Revenue | Cost | Margin | % |
|---|---|---|---|---|---|
| Solo | 20 hrs | $49 | $10 | $39 | **80%** |
| Pro | 200 hrs | $199 | $100 | $99 | **50%** |
| Studio | 500 hrs | $499 | $250 | $249 | **50%** |

With overage (heavier use):

| Tier | 2× included usage | Revenue | Cost | Margin | % |
|---|---|---|---|---|---|
| Solo | 40 hrs (20 inc + 20 over) | $49 + $30 = $79 | $20 | $59 | **75%** |
| Pro | 400 hrs (200 inc + 200 over) | $199 + $200 = $399 | $200 | $199 | **50%** |
| Studio | 1000 hrs (500 inc + 500 over) | $499 + $400 = $899 | $500 | $399 | **44%** |

Healthy across the board. The numbers above are *starting points* —
data collection plan below to refine before launch.

---

## Predicting Recall costs (data collection plan)

Right now we're guessing how many bot-hours a typical customer uses.
The `bot_usage` table (just shipped in `6980d49`) collects real data
on every event you run. Use the next ~4 weeks to build a baseline.

### What to do during real events

Nothing! It's automatic — every bot dispatched is logged with start
time and (when it leaves) duration.

### Queries to run after each event

```sql
-- Per-event summary
SELECT
  s.name                                          AS session,
  s.started_at,
  s.ended_at,
  COUNT(b.id)                                     AS bots_dispatched,
  ROUND(SUM(b.duration_seconds) / 3600.0, 2)      AS bot_hours,
  ROUND(SUM(b.duration_seconds) / 3600.0 * 0.50, 2) AS recall_cost_usd,
  MAX((
    SELECT COUNT(*)
    FROM bot_usage b2
    WHERE b2.joined_at <= b.joined_at
      AND (b2.left_at IS NULL OR b2.left_at >= b.joined_at)
  ))                                              AS peak_concurrent_bots
FROM bot_usage b
LEFT JOIN sessions s ON s.id = b.session_id
WHERE b.left_at IS NOT NULL
GROUP BY s.id, s.name, s.started_at, s.ended_at
ORDER BY s.started_at DESC;
```

```sql
-- Last 30 days rollup
SELECT
  ROUND(SUM(duration_seconds) / 3600.0, 2)        AS total_bot_hours,
  ROUND(SUM(duration_seconds) / 3600.0 * 0.50, 2) AS total_recall_cost_usd,
  COUNT(*)                                        AS bot_count,
  COUNT(DISTINCT session_id)                      AS session_count
FROM bot_usage
WHERE left_at >= NOW() - INTERVAL '30 days';
```

### What we'll learn

After ~5-10 real events, you'll have data to answer:

- **What's an average event's bot-hour spend?** → drives the
  "included hours" number per tier
- **What's peak concurrent bot count for your typical event?** →
  validates the Pro tier's 5-bot cap and Studio's 20-bot cap
- **What's your variable margin per real event?** → tells you if the
  $0.50 cost assumption holds (Recall pricing can vary by region /
  volume tier)

If real data says "average Pro-tier customer would use 400 hrs/mo"
when we included 200, we know to either raise the included hours
(narrower margin) or accept that most customers will pay overage
(wider margin, but pricing perception worse).

### Add a usage endpoint later (small, can ship any time)

A simple `GET /api/usage` endpoint surfacing this data in the React
UI would save running SQL by hand. Not in Phase 1 scope but trivially
small once needed — say the word.

---

## Auth: Clerk vs. roll-your-own

**Theo asked:** *"Why do we need to use Clerk? What does that really
save us? Sounds like more overhead to me."*

Fair question. Honest comparison:

### What Clerk gives you

| Feature | Clerk | Roll-your-own |
|---|---|---|
| Email/password login UI | Drop-in React component | Build + style yourself (~2-3 days) |
| Email verification flow | Built-in | Integrate Resend/Postmark + UI (~1-2 days) |
| Password reset flow | Built-in | Build it (~1 day) |
| Multi-user org with roles | Built-in (Q5 requirement) | Build it (~3-5 days) |
| User invitation emails | Built-in | Build it (~1 day) |
| Magic-link login | Built-in (optional) | Build it (~1 day) |
| OAuth (Google, Microsoft) | Toggle in dashboard | Per-provider integration (~2-3 days each) |
| MFA (TOTP) | Toggle in dashboard | Build it (~2 days, security-sensitive) |
| Admin dashboard | Hosted (no code) | Build it (~2-3 days) |
| Session/JWT management | Handled | jose + refresh tokens + secure cookies (~1-2 days) |
| Password hashing, timing-attack protection, rate limiting | Built-in | Carefully implement (~1 day + ongoing vigilance) |
| Webhooks for user events | Built-in (good for billing sync) | Build it (~1 day) |
| Ongoing security maintenance | Their problem | Your problem |

**Total roll-your-own work (multi-user from day one):** ~2-3 weeks
focused dev + ongoing security responsibility.

**Clerk cost at typical scale:** $25/month base + $0.02/MAU after 10K
users. For 50 customers × 3 users each (150 MAU) = $25/month.

### Honest middle ground: Lucia Auth (or Better Auth)

If "vendor dependency" is the real concern (not the $25), there's a
genuine middle ground: **library, not service**.

- [Lucia](https://lucia-auth.com/) or [Better Auth](https://www.better-auth.com/)
  — open-source TS libraries providing the *primitives* (session
  management, password hashing, JWT, magic links, OAuth adapters) but
  not the UI or hosting
- You build the login forms (~2 days because Lucia handles the hard
  parts), wire up email service (Resend free tier, 3K emails/mo
  included), use Postgres for user storage
- Multi-user/org schema is on you, but it's just a few tables
- No subscription cost
- Total work: ~5-7 days vs. Clerk's "drop in and done" but ~2 weeks
  saved vs. truly building from scratch

### My recommendation, given Theo's "more overhead" pushback

| Option | When it's right |
|---|---|
| **Clerk ($25/mo)** | You want to ship Phase 1 in the *fewest possible days* and the $25 is a rounding error vs. the engineering cost |
| **Lucia + Postgres + Resend (~free)** | You're OK spending ~5 extra days of engineering to own everything, no monthly vendor cost, no vendor data dependency |
| **Build from scratch** | Don't. The security surface is large, the work isn't differentiating, and you're not learning anything you can't learn from Lucia's source code in less time |

For RYTE specifically — small bootstrapped tool, founder is sensitive
to recurring costs, single dev resource (Theo + me) — **Lucia is the
right call.** Clerk's "save 1-2 weeks" is real but Lucia gets you 80%
of the win for free.

**This becomes a Phase 1 sub-decision:** pick Clerk or Lucia at the
start of implementation. Schema and routes look largely the same
either way; the difference is who builds and hosts the login UI.

---

## Multi-user per org from day one

What this means in practice:

### Data model

```sql
CREATE TABLE organizations (
  id                       TEXT PRIMARY KEY,
  name                     TEXT NOT NULL,
  plan_tier                TEXT NOT NULL DEFAULT 'trial',  -- trial|solo|pro|studio
  concurrent_bot_limit     INTEGER NOT NULL DEFAULT 1,
  included_bot_hours       INTEGER NOT NULL DEFAULT 0,    -- 0 for trial (capped at 30min total)
  trial_minutes_remaining  INTEGER,                        -- NULL for paid plans; integer for trial
  stripe_customer_id       TEXT UNIQUE,
  stripe_subscription_id   TEXT UNIQUE,
  created_at               TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE users (
  id              TEXT PRIMARY KEY,
  org_id          TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  email           TEXT UNIQUE NOT NULL,
  password_hash   TEXT,                            -- NULL if Clerk-managed
  role            TEXT NOT NULL DEFAULT 'operator', -- admin|operator
  email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  last_login_at   TIMESTAMPTZ
);

CREATE TABLE invitations (
  id            TEXT PRIMARY KEY,
  org_id        TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'operator',
  invited_by    TEXT REFERENCES users(id),
  token         TEXT UNIQUE NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  accepted_at   TIMESTAMPTZ
);

CREATE INDEX idx_users_org ON users(org_id);
```

### Roles

- **Admin** — can manage billing, invite/remove users, change tier,
  access settings. Founder of the org by default.
- **Operator** — can use the app (connect meetings, save messages,
  end sessions). Can NOT manage billing or users.

### Invitation flow

1. Admin clicks "Invite operator" in the new Settings → Team panel
2. Enters email + role
3. Server creates `invitations` row, generates unique token, sends
   email with link `https://zoomchat.../accept-invite?token=...`
4. Recipient clicks link → signup form (email pre-filled) → on
   success, row in `users` with that `org_id` and `role`
5. `invitations.accepted_at` set; token can't be reused

### Concurrent-bot enforcement

In `/api/meetings/connect`:

```js
const activeBots = await db.query(
  `SELECT COUNT(*) FROM bot_usage
   WHERE tenant_id = $1 AND left_at IS NULL`,
  [req.org.id]
);
if (activeBots.rows[0].count >= req.org.concurrent_bot_limit) {
  return res.status(402).json({
    error: `You've reached your concurrent bot limit (${req.org.concurrent_bot_limit}). ` +
           `Upgrade your plan to monitor more rooms simultaneously.`,
    upgrade_url: '/settings/billing',
  });
}
```

Hour-limit enforcement (after billing layer lands) similar.

---

## Customer support: manual + email

### The manual (docs site)

Cheap path: **markdown files in `/docs/manual/`**, rendered as a
static site via [Docusaurus](https://docusaurus.io/) or
[VitePress](https://vitepress.dev/), deployed alongside the main app
(or to a `docs.zoomchat.ryteproductions.com` subdomain). Source lives
in the same repo so docs and code stay in sync.

Initial manual pages to write:
- **Getting started** — sign up, dispatch first bot, save first message
- **Inviting your team** — admin walkthrough
- **The presenter display** — drag, double-click fullscreen, idle
  behavior
- **Sessions** — naming, ending, browsing past
- **Saving and exporting messages** — bookmark, CSV, PNG cards
- **Billing** — tier comparison, upgrades, overage explanation
- **Troubleshooting** — bot stuck in waiting room, no chat appearing,
  webhook misses
- **Pricing & FAQ**

Effort: ~2-3 days of writing + ~half-day of Docusaurus setup.

### Support email

- Get a transactional inbox (free options: forward
  `support@ryteproductions.com` to your Gmail; or Google Workspace
  group at $0)
- Standard response: 24-business-hour commit (don't promise faster
  than you can deliver)
- Eventually consider Help Scout ($25/mo) or Crisp (free tier) when
  volume justifies it — for the first dozen customers, Gmail is fine

---

## Phased implementation plan (updated)

### Phase 1: Auth + org isolation + multi-user (1.5-2.5 weeks)

**Includes the multi-user-from-day-one decision so this is heavier
than the original Phase 1 estimate, but rolling it together with
auth is cheaper than adding it later.**

- Choose Clerk OR Lucia (start-of-phase decision)
- New tables: `organizations`, `users`, `invitations`
- Add `org_id` foreign keys to existing tables (replaces the
  `tenant_id` placeholder column shipped in `6980d49`)
- Middleware: extract user from auth, attach `req.user` + `req.org`
  to every request
- All DB queries filter by `req.org.id`
- Sign-up flow: new org created with trial tier (30-min, 1-bot cap)
- Settings → Team panel (admin only): invite users, change roles,
  remove users
- **Ship gate:** existing functionality works exactly the same when
  signed in as the single existing operator (you); a second user
  invited to the same org sees the same data

### Phase 2: Concurrent-bot + trial enforcement (3-5 days)

- `/api/meetings/connect` checks `org.concurrent_bot_limit`
- Trial accounts: deduct from `trial_minutes_remaining` as bots run;
  refuse dispatch when hits 0
- React UI: show "X of Y bots running" in the header; show "X minutes
  of trial remaining" for trial accounts; show upgrade CTA when
  hitting limit
- **Ship gate:** trial users get cut off correctly at 30 min; Solo
  users can't dispatch a second bot; Pro/Studio enforce their caps

### Phase 3: Stripe Billing (3-5 days)

- Create Stripe products (Solo, Pro, Studio) with monthly + metered
  prices
- Sign-up flow: trial → Stripe Checkout for paid tier
- Webhook: `customer.subscription.updated` syncs
  `organizations.plan_tier` + `concurrent_bot_limit` +
  `included_bot_hours`
- Hourly cron reports overage (hours > included) to Stripe metered
  subscription
- Settings → Billing: Stripe Customer Portal (hosted by Stripe — no
  code) for invoices, payment method, cancel
- **Ship gate:** end-to-end paying customer signs up, uses, gets
  invoiced correctly at month-end

### Phase 4: Polish + safety (1 week)

- Email alerts at 80% / 100% of included hours
- Hard cap on bot-hours per month per tier (configurable; default ON)
- Auto-disconnect bots after 4-hour max (backstop against forgotten
  bots)
- Admin dashboard (Theo-only): list of orgs, MRR, Recall cost, margin
  per org
- `GET /api/usage` endpoint + small usage chart in operator dashboard
  (last 30 days bot-hours per session)
- **Ship gate:** Theo can see at a glance which customers are
  profitable

### Phase 5: Docs + launch (1-2 weeks, mostly writing not coding)

- Set up Docusaurus / VitePress at `/docs/manual/`
- Write the 8 pages listed above
- Set up support@ryteproductions.com forward
- ToS + Privacy Policy (templated service like Iubenda ~$30/yr, or
  startup lawyer for ~$1-2K one-time)
- DPA template for enterprise contact-sales path (future)
- Launch list: ProductHunt? Direct outreach to event production
  companies you've worked with?

---

## Things still TBD (revisit at start of each phase)

### Before Phase 1
- **Clerk vs Lucia** — final call on auth approach
- **Org name on signup** — does the first user get to set the org
  name, or do we generate from their domain?
- **Domain-based org auto-join** — if `jane@acme.com` signs up after
  `bob@acme.com` already has an Acme org, do we auto-suggest joining?

### Before Phase 3
- **Tier numbers refined from real data** (the whole reason for the
  data collection plan above)
- **Free trial credit card requirement?** Currently planned as no-card
  to maximize signups. Stripe lets you require a card for trial
  later — toggle setting, not a code change

### Before Phase 5
- **ToS templating service vs. lawyer** — depends on launch budget
- **Marketing channel** — outside this doc's scope but worth deciding
  before the public launch
