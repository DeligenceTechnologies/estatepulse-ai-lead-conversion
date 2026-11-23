# How billing works in the backend (quick guide)

A short tour for new developers. For full detail see `BILLING_ARCHITECTURE.md`.

## The big idea

- We bill an **organization**, not a user. One organization has one subscription.
- **Stripe holds the money and the truth.** Our database keeps a copy so the app
  can quickly answer "which plan is this org on?".
- We **never** decide "paid" ourselves. A plan becomes active only after we read
  the subscription back **from Stripe**.

## The 4 plans

Defined in one file: `backend/src/billing/billing-plans.ts`.

| Plan | Monthly | Yearly | Members |
|---|---|---|---|
| FREE | ₹0 | – | 1 |
| STARTER | ₹999 | ₹9,999 | 3 |
| PROFESSIONAL | ₹2,999 | ₹29,999 | 10 |
| BUSINESS | ₹5,999 | ₹59,999 | 25 |

Each paid plan + interval has a **Stripe Price ID** in `.env`
(`STRIPE_STARTER_MONTHLY_PRICE_ID`, …). Prices are never sent from the browser.

## Where the code is

```
backend/src/billing/
  billing-plans.ts            plans, features, member limits
  billing.config.ts           reads Stripe settings from .env
  billing.controller.ts       /api/billing/* routes for the app
  billing-webhook.controller.ts  POST /billing/webhook (Stripe calls this)
  billing.repository.ts       all billing database queries
  access-policy.ts            "status → which plan's features apply"
  entitlements/               "is this org allowed to do X?"
  services/
    stripe.service.ts         the only place that talks to the Stripe SDK
    stripe-checkout.service.ts   starts a payment (Checkout page)
    subscription.service.ts   upgrade, downgrade, cancel, reactivate
    subscription-sync.service.ts copies Stripe data into our tables
    stripe-webhook.service.ts handles Stripe's webhook events
    billing-reconcile.service.ts every 10 min: retry failures, re-check
```

## Database tables

| Table | What it stores |
|---|---|
| `subscriptions` | One row per org: Stripe customer/subscription id, plan, status, dates |
| `invoices` | Copy of Stripe invoices (with PDF and hosted links) |
| `payments` | One payment per invoice: amount, status, failure reason |
| `billing_events` | Every webhook received, so each is processed only once |

No card numbers are ever stored. Stripe keeps those.

## Flow 1: an org buys a plan

```
1. User clicks Subscribe        → POST /api/billing/checkout { plan, interval }
2. Backend:
   - finds the Price ID in .env and checks it in Stripe (amount, currency)
   - makes sure the org has no live subscription (in our DB and in Stripe)
   - creates a Stripe customer once per org
   - creates a Checkout Session and returns its URL
3. Browser goes to checkout.stripe.com, user pays
4. Stripe sends the user back to /billing/success?session_id=…
5. Two things now update our DB (whichever is first):
   a. the success page asks GET /api/billing/checkout/:id → backend reads the
      session and subscription from Stripe and saves them
   b. Stripe's webhook (checkout.session.completed, invoice.paid …)
6. Plan shows as active
```

The `session_id` in the URL is only used to ask Stripe. It is not proof of payment.

## Flow 2: webhooks (Stripe → us)

Stripe calls `POST /billing/webhook` (root path, **not** under `/api`) when
something changes: payment done, payment failed, subscription canceled, etc.

For every event:

1. **Check the signature** with `STRIPE_WEBHOOK_SECRET`. Wrong → 400.
2. **Save it** in `billing_events`. If we already processed this event id, stop
   (Stripe sometimes sends the same event twice).
3. **Lock it**, so two servers don't process the same event.
4. **Fetch fresh data from Stripe** (the subscription or invoice) and save that.
   We don't trust the event body alone, because events can arrive out of order.
5. **Mark it** `processed`, `ignored` or `failed`. Failed events are retried by
   Stripe and by our 10-minute job.

## Flow 3: changing the plan

| Action | What happens |
|---|---|
| Upgrade | Charged now for the difference. The plan changes **after** that payment succeeds |
| Downgrade | Booked for the end of the paid period (Stripe "subscription schedule") |
| Cancel | Stops at the end of the period. Features stay until then |
| Reactivate | Undo a cancel before the period ends |

## Which features an org gets

`access-policy.ts` turns Stripe's status into a plan:

| Status | Features |
|---|---|
| `active`, `trialing` | The paid plan |
| `past_due` (payment failed) | The paid plan for 7 days (`BILLING_PAST_DUE_GRACE_DAYS`), then Free |
| `incomplete`, `unpaid`, `canceled`, … | Free |

## Blocking features by plan

Use `EntitlementService` (or the decorator). Never compare plan names yourself.

```ts
// Block a route unless the plan includes the feature
@RequireFeature(FEATURES.LEAD_AUTOMATION)
@Post()
create() { … }

// Check a limit in a service
await this.entitlements.assertCanAddMembers(orgId);
```

To gate a new feature: add it to `FEATURES` and the right plans in
`billing-plans.ts`, then put `@RequireFeature` on the route.

`BILLING_ENFORCEMENT_ENABLED=0` (the default) only **logs** "would be blocked".
Set it to `1` when billing goes live.

## Who can do what

| Permission | Allows |
|---|---|
| `billing.read` | See plan, usage, invoices |
| `billing.manage` | Subscribe, change plan, cancel, open the Stripe portal |

Owners have both. Agents have neither.

## Golden rules

1. Only `subscription-sync.service.ts` writes plan and status, and only from Stripe data.
2. Never accept a price, amount or organization id from the frontend.
3. Every Stripe call goes through `StripeService.call()`. It handles errors and keeps secrets out of logs.
4. Don't edit billing rows by hand in the database. Our data goes out of sync
   with Stripe. To reset test data, cancel the subscription in Stripe too.
5. Test mode uses `sk_test_…` keys and fake cards like `4242 4242 4242 4242`.

## Run it locally

1. Fill the Stripe values in `backend/.env`. See `STRIPE_SETUP.md`.
2. Forward webhooks to your machine, either with
   `stripe listen --forward-to localhost:4000/billing/webhook` or with a
   tunnel (`cloudflared tunnel --url http://localhost:4000`) plus a Dashboard
   endpoint. Put the `whsec_…` in `STRIPE_WEBHOOK_SECRET`.
3. Start the backend with `pnpm dev`.
4. Run the billing tests with `pnpm test -- src/billing`. All Stripe calls are mocked.

More: `STRIPE_TESTING.md` (test scenarios) and `BILLING_API.md` (every endpoint).
