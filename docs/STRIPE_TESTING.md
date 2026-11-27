# Testing billing

## Automated tests

All Stripe calls are mocked. No test needs network access, a Stripe account or a real
payment. Webhook signatures are generated and verified with the real SDK's HMAC, so a
forged delivery fails exactly as it would in production.

```bash
cd backend  && pnpm test -- src/billing         # 68 tests
cd frontend && npx vitest run src/utils/billingApi.spec.ts src/components/billing   # 28 tests
```

| Suite | Covers |
|---|---|
| `billing-plans.spec.ts` | Catalog, plan ordering, upgrade/downgrade classification, config mapping, access policy for every status |
| `services/stripe.service.spec.ts` | Not configured, error translation (decline 402, bad key, Stripe down), signature accept/reject/tamper |
| `services/stripe-checkout.service.spec.ts` | Customer created once, server-side Price, metadata, session reuse, duplicate subscription refused, missing Price ID, no key, FREE refused, price mismatch, DTO rejects amount/priceId/organizationId, cross-tenant session status → 404 |
| `services/stripe-webhook.service.spec.ts` | Invalid signature, activation from Stripe state, duplicate events, out-of-order events, stale subscription ignored, unknown customer ignored, tenant mismatch never applied, unknown Price fails, retry after failure, failed payment → past_due, recovery, one payment per invoice, test event on live server |
| `services/subscription.service.spec.ts` | Cancel at period end, immediate cancel gated, reactivate, upgrade with `pending_if_incomplete`, upgrade awaiting payment keeps old plan, downgrade via schedule, keep-current-plan, past_due blocks changes |
| `entitlements/entitlement.service.spec.ts` | Free default, feature gating, incomplete grants nothing, member limit, per-org isolation, shadow mode, decorator on existing routes, guard |
| `billing.controller.spec.ts` | Owner / agent / read-only permissions per route, only plans + webhook public, routes use the session's org |
| frontend `billingApi.spec.ts` | Money formatting, plan button actions, success-page confirmation rule, polling, checkout redirect only to Stripe, error wording |
| frontend `components/billing/billing.spec.tsx` | Pricing cards, toggle, current/recommended badges, buttons per state, unavailable plans, loading/error, read-only viewer, billing summary, cancellation, paused features, usage + upgrade prompt, invoices |

## Local end-to-end with Stripe test mode

### 1. Prerequisites

- Test keys and six test Prices configured (`STRIPE_SETUP.md` steps 2 and 3).
- The billing migration applied to your local database.
- The [Stripe CLI](https://docs.stripe.com/stripe-cli) installed, then `stripe login`.

### 2. Forward webhooks to the backend

The backend listens on `PORT` (4000 by default). The webhook is at the root path:

```bash
stripe listen --forward-to localhost:4000/billing/webhook
```

If your backend runs on 3001, use `localhost:3001/billing/webhook`.

The CLI prints `Your webhook signing secret is whsec_…`. Put it in
`STRIPE_WEBHOOK_SECRET` and restart the backend. The secret stays the same across
`stripe listen` runs for the same device.

### 3. Run the app

```bash
cd backend && pnpm dev
cd frontend && npm run dev      # http://localhost:3000
```

Set `APP_URL=http://localhost:3000` in `backend/.env` so Stripe returns to the frontend.

### 4. Buy a plan

1. Sign in as an owner and open **Plans & Billing** in the sidebar.
2. Choose **Professional**, monthly, then **Subscribe**. You are sent to `checkout.stripe.com`.
3. Pay with a test card from the table below (any future expiry, any CVC, any postcode).
4. Stripe returns you to `/billing/success`, which shows **Confirming your payment…**
   until the server reports the subscription as active.
5. In the `stripe listen` terminal you should see `checkout.session.completed`,
   `customer.subscription.created`, `invoice.paid` and others, each answered
   `[200]`.
6. **Settings → Billing** shows Professional, Active, the period and next billing date,
   and the invoice with PDF and hosted links.

### Test cards

| Card | Result |
|---|---|
| `4242 4242 4242 4242` | Succeeds |
| `4000 0025 0000 3155` | Requires 3-D Secure authentication (complete or fail the challenge) |
| `4000 0000 0000 9995` | Declined: insufficient funds |
| `4000 0000 0000 0002` | Declined: generic |
| `4000 0000 0000 0341` | Attaches to the customer, then **fails when charged**; use it to test failed renewals |
| `4000 0035 6000 0008` | Indian card (Visa), for testing India-specific flows on an Indian account |

The full list is in Stripe's testing docs (docs.stripe.com/testing).

### 5. Scenarios

**Duplicate delivery.** Find an event id in the CLI output, then replay it:
```bash
stripe events resend evt_…
```
The response is `{"received":true,"status":"duplicate"}` and nothing changes.

**Invalid signature.** This returns 400 `invalid_signature`:
```bash
curl -i -X POST localhost:4000/billing/webhook -H 'Content-Type: application/json' \
  -H 'Stripe-Signature: t=1,v1=deadbeef' -d '{"id":"evt_fake"}'
```

**Cancel and reactivate.** In Settings → Billing, choose **Cancel subscription**: the
status becomes *Cancels at period end* and the plan stays on. **Keep my subscription**
undoes it. In the Dashboard you can end it immediately (Subscriptions → Cancel →
Immediately). The webhook moves the org to Free and the history stays.

**Upgrade and downgrade.** On Plans & Billing, **Upgrade** to Business. A prorated
invoice is paid at once, and with card `…3155` it waits for authentication while the
plan stays Professional. **Downgrade** to Starter shows *Changes to Starter on <date>*,
and the Dashboard shows a subscription schedule.

**Failed renewal → past_due → recovery.**
1. Open **Manage payment method** (Stripe portal) and replace the card with `4000 0000 0000 0341`.
2. Force a renewal now:
   ```bash
   stripe subscriptions update sub_… --billing-cycle-anchor=now --proration-behavior=none
   ```
3. `invoice.payment_failed` arrives and the status becomes **Payment failed** (past_due).
   Paid features stay for `BILLING_PAST_DUE_GRACE_DAYS`, and the payment history shows
   the failure reason.
4. Put `4242…` back in the portal and pay the open invoice from its hosted page.
   `invoice.paid` arrives and the status returns to Active.

For time-based scenarios (trial ending, renewals a month out), use Stripe **test clocks**
(Dashboard → Billing → Test clocks) with a customer and subscription created on the clock.

**Triggered fixtures.** `stripe trigger customer.subscription.updated` (and similar)
create *new* Stripe customers that no organization owns, so the app records the
event as `ignored` (200). That confirms delivery, signature checking and storage, but
use the real checkout above to test state changes.

### 6. Watching it

```sql
-- every event, its outcome and any error
SELECT stripe_event_id, event_type, processing_status, attempts, error_message, created_at
FROM billing_events ORDER BY created_at DESC LIMIT 20;

-- an organization's subscription
SELECT plan, status, billing_interval, current_period_end, cancel_at_period_end,
       pending_plan, past_due_since, synced_at
FROM subscriptions WHERE organization_id = '…';
```

Rows in `processing_status = 'failed'` are retried by Stripe and by the reconciler
(every 10 minutes, up to 10 attempts). Their `error_message` gives the reason.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Plan button says **Not available yet** | No Price ID for that plan/interval in env, no `STRIPE_SECRET_KEY`, or no `APP_URL` / success URL |
| Checkout answers `BILLING_PRICE_MISMATCH` | The Stripe Price's amount, currency, interval, mode or active flag differs from `billing-plans.ts`. The backend log names the difference |
| Backend refuses to boot: "must be a test key" | `STRIPE_SECRET_KEY` does not match `STRIPE_MODE` |
| `stripe listen` shows `[400]` | Wrong `STRIPE_WEBHOOK_SECRET` (use the one `stripe listen` printed), or a proxy changed the body |
| `[404]` on the webhook | Posting to `/api/billing/webhook`; the path is `/billing/webhook` at the root |
| `[503] not_configured` | `STRIPE_SECRET_KEY` or `STRIPE_WEBHOOK_SECRET` is missing |
| Event `failed`: "Price … which no plan is configured with" | A subscription on a Price not in env (created in the Dashboard or portal). Add the Price ID or change the subscription; the reconciler then retries |
| Event `failed`: `TenantMismatchError` | Stripe metadata names another organization than the customer's owner. Investigate before replaying |
| Success page stays on **Payment still processing** | The webhook is not reaching the backend, or the payment is genuinely pending (bank or 3-D Secure). The plan unlocks when Stripe confirms |
| `PLAN_LIMIT_REACHED` when adding a member | Working as intended with enforcement on. Upgrade, or set `BILLING_ENFORCEMENT_ENABLED=0` while testing |
| Logs show `[not enforced] … would be blocked` | Enforcement is off. This is the dry-run log |
