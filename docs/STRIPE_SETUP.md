# Stripe setup

Everything here starts in **test mode**. Live mode is the same steps with live keys,
done once the Stripe account is activated.

## 1. Account

1. Create a Stripe account and turn on **Test mode** in the Dashboard.
2. **Currency.** The demo catalog is in INR (`BILLING_CURRENCY=inr`).
   - An **Indian** Stripe account bills INR natively. Recurring card payments in India
     fall under RBI e-mandate rules: the first payment sets up a mandate, and renewals
     above the RBI threshold need the cardholder to authenticate each charge. Stripe
     reports this as `invoice.payment_action_required`, which the app handles. The yearly
     demo prices (₹29,999 and ₹59,999) are above that threshold. Check Stripe's India
     recurring-payments documentation for the current limit before going live.
   - A non-Indian account can usually present INR prices, but confirm INR is supported
     for your account and payment methods before relying on it.
   - Whatever the currency, every configured Price must be in `BILLING_CURRENCY` or
     checkout refuses to start (`BILLING_PRICE_MISMATCH`).

## 2. Products and Prices

Create one Product per paid plan and two recurring Prices per Product. Amounts are in
the smallest unit (paise):

| Plan | Monthly | Yearly |
|---|---|---|
| Starter | 99900 (₹999) | 999900 (₹9,999) |
| Professional | 299900 (₹2,999) | 2999900 (₹29,999) |
| Business | 599900 (₹5,999) | 5999900 (₹59,999) |

You can do this in the Dashboard (Product catalog → Add product → Recurring price) or
with the Stripe CLI:

```bash
stripe products create --name="EstatePulse Starter"
# → prod_…  (repeat for Professional and Business)

stripe prices create --product=prod_STARTER --currency=inr --unit-amount=99900   -d "recurring[interval]=month"
stripe prices create --product=prod_STARTER --currency=inr --unit-amount=999900  -d "recurring[interval]=year"
stripe prices create --product=prod_PRO     --currency=inr --unit-amount=299900  -d "recurring[interval]=month"
stripe prices create --product=prod_PRO     --currency=inr --unit-amount=2999900 -d "recurring[interval]=year"
stripe prices create --product=prod_BUSINESS --currency=inr --unit-amount=599900  -d "recurring[interval]=month"
stripe prices create --product=prod_BUSINESS --currency=inr --unit-amount=5999900 -d "recurring[interval]=year"
```

Each Price must be **recurring**, **licensed** (not metered), `interval_count` 1, active,
and equal to the amount in `backend/src/billing/billing-plans.ts`. The server checks all
of this before each checkout and caches the result for 10 minutes.

## 3. Environment (`backend/.env`)

```bash
STRIPE_MODE=test
STRIPE_SECRET_KEY=sk_test_…            # Developers → API keys (or a restricted rk_test_ key)
STRIPE_PUBLISHABLE_KEY=pk_test_…       # optional; checkout is Stripe-hosted
STRIPE_WEBHOOK_SECRET=whsec_…          # from step 4

STRIPE_STARTER_MONTHLY_PRICE_ID=price_…
STRIPE_STARTER_YEARLY_PRICE_ID=price_…
STRIPE_PROFESSIONAL_MONTHLY_PRICE_ID=price_…
STRIPE_PROFESSIONAL_YEARLY_PRICE_ID=price_…
STRIPE_BUSINESS_MONTHLY_PRICE_ID=price_…
STRIPE_BUSINESS_YEARLY_PRICE_ID=price_…
BILLING_CURRENCY=inr

# Optional; these are the defaults when APP_URL is set
BILLING_SUCCESS_URL=${APP_URL}/billing/success
BILLING_CANCEL_URL=${APP_URL}/billing/cancel
BILLING_PORTAL_RETURN_URL=${APP_URL}/settings?tab=billing

BILLING_TRIAL_DAYS=0
BILLING_PAST_DUE_GRACE_DAYS=7
BILLING_ENFORCEMENT_ENABLED=0      # 1 at launch
BILLING_ALLOW_IMMEDIATE_CANCEL=0
BILLING_RECONCILE_ENABLED=1
```

Startup validation (`env.validation.ts`) refuses to boot when:
- the key does not match the mode (`sk_live_` with `STRIPE_MODE=test`, or the reverse);
- a Price ID is not of the form `price_…`;
- one Price ID is configured for two plans.

A plan without a Price ID shows **Not available yet**, and its checkout answers 503
`BILLING_NOT_CONFIGURED`. With no secret key at all, everyone is on Free and checkout
is unavailable. No payment is ever faked.

**Restricted key permissions** (if you use `rk_…`): write access to Customers, Checkout
Sessions, Subscriptions, Subscription Schedules, Customer Portal; read access to Prices,
Invoices, Events.

## 4. Webhook endpoint

The endpoint is at the API root, **not** under `/api`:

```
POST https://<your-api-host>/billing/webhook
```

**Locally**, use the Stripe CLI (see `STRIPE_TESTING.md`). `stripe listen` prints a
`whsec_…` to put in `STRIPE_WEBHOOK_SECRET`.

**Deployed**: Dashboard → Developers → Webhooks → Add endpoint with the URL above.
Select these events:

```
checkout.session.completed
checkout.session.async_payment_succeeded
checkout.session.expired
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
customer.subscription.paused
customer.subscription.resumed
customer.subscription.pending_update_applied
customer.subscription.pending_update_expired
customer.subscription.trial_will_end
invoice.paid
invoice.payment_succeeded
invoice.payment_failed
invoice.finalized
invoice.payment_action_required
invoice.voided
invoice.marked_uncollectible
```

Copy the endpoint's **Signing secret** into `STRIPE_WEBHOOK_SECRET`. The handler uses
only ids from the event body and re-reads each object through the SDK, which is pinned
to API version `2026-11-18.endive` (stripe-node 23.2.0). The endpoint's own API version
therefore does not affect parsing, though matching it is tidiest.

## 5. Customer Portal

Dashboard → Settings → Billing → **Customer portal**:

- **Payment methods**: allow updating.
- **Invoice history**: on.
- **Cancellations**: allow, **at end of billing period**. Immediate cancellation in the
  portal would bypass `BILLING_ALLOW_IMMEDIATE_CANCEL`.
- **Subscription updates**: either off (plan changes then happen only in the app, with
  its upgrade and downgrade rules), or on with exactly the six Prices above. Any change
  made in the portal reaches the app through `customer.subscription.updated`. A Price
  not configured in env fails that event and grants nothing.
- Set the business name, privacy policy and terms URLs.

To use a non-default portal configuration, set `STRIPE_PORTAL_CONFIGURATION_ID=bpc_…`.

## 6. Recommended Stripe settings

- **Billing → Subscriptions and emails → Manage failed payments**: Smart Retries on, and
  after the final retry *mark the subscription unpaid* or *cancel it*. Both map to Free.
- **Emails**: turn on Stripe's receipts, failed-payment and upcoming-renewal emails.
- **Stripe Tax** (optional): enable it in the Dashboard, then set `STRIPE_AUTOMATIC_TAX=1`.
  Checkout then collects the address and adds tax.

## 7. Database

Apply the migration `20261123000001_billing_subscriptions`. It only adds tables and
enums; nothing existing changes:

```bash
cd backend
pnpm prisma:deploy        # prisma migrate deploy
```

Never use `prisma db push` against a shared or production database.

## 8. Going live

1. Activate the Stripe account (business details, bank account, identity).
2. Re-create the six Prices **in live mode**. Test and live objects are separate, and
   the server checks `livemode` on each Price.
3. Add the live webhook endpoint with the same event list and copy its signing secret.
4. Configure the live Customer Portal (it is separate from test mode's).
5. In production env: `STRIPE_MODE=live`, `STRIPE_SECRET_KEY=sk_live_…`, the live
   `whsec_…` and the live Price IDs. Keep test keys out of production entirely.
6. Decide `BILLING_ENFORCEMENT_ENABLED`. Watch the `[not enforced] … would be blocked`
   logs first to see who a limit would affect, then set it to `1`.
7. Make one real low-value purchase with your own card and refund it from the Dashboard.
   Confirm the subscription reached `active` in Settings → Billing and that
   `billing_events` shows the events `processed`.

Changing a price later means creating a new Price in Stripe, setting its id in env,
and updating the display amount in `billing-plans.ts` (checkout refuses a mismatch).
Existing subscribers stay on their old Price until you migrate them in Stripe.
