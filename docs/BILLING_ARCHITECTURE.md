# Billing architecture

EstatePulse bills **organizations**, not users. Each organization has at most one
subscription, paid through Stripe. Stripe is the source of truth for money; the
database mirrors only the references and state the app needs to decide what an
organization may use.

## Principles

| Rule | Where it is enforced |
|---|---|
| The browser chooses only a plan and an interval. No price, amount, Price ID or organization id is accepted. | `SelectPlanDto` + the global `ValidationPipe` (`forbidNonWhitelisted`) |
| The organization is always the session's own. | Every billing route reads `auth.organizationId`; no route takes an org id |
| The Price charged is resolved on the server, from env, and checked against the catalog before checkout starts. | `StripePriceService.verifiedPriceId` |
| Nothing is granted because the success page opened. | Plan and status are written only by `SubscriptionSyncService`, from objects fetched from Stripe |
| Every webhook is signature-checked, stored once, and processed once. | `StripeWebhookService` + `billing_events.stripe_event_id` (unique) |
| Plan features and limits are defined once. | `backend/src/billing/billing-plans.ts` |
| Billing history is never deleted on cancellation. | Cancel only changes status; rows stay |

## Code map

```
backend/src/billing/
  billing-plans.ts             Plan catalog: display prices (paise), features, member limits
  billing.config.ts            Env → BillingConfig (Price IDs both ways, URLs, flags)
  billing.constants.ts         Error codes, terminal statuses, metadata keys
  access-policy.ts             Subscription status → plan whose features apply
  billing.repository.ts        Every billing DB read/write, always scoped by orgId
  billing.service.ts           Read side: plans, subscription, usage, invoices
  billing.controller.ts        /api/billing/* (JWT + permissions)
  billing-webhook.controller.ts  POST /billing/webhook (public, signature only)
  billing.module.ts            @Global: exports EntitlementService and BillingConfig
  dto/billing.dto.ts
  entitlements/
    entitlement.service.ts     The single "may this org do X?" answer
    require-feature.decorator.ts  @RequireFeature(feature) + EntitlementGuard
  services/
    stripe.service.ts          The only SDK owner; maps Stripe errors to safe API errors
    stripe-price.service.ts    Plan+interval → verified Stripe Price
    stripe-checkout.service.ts Checkout Sessions, customer creation, session status
    stripe-customer-portal.service.ts
    subscription.service.ts    Upgrade / downgrade / cancel / reactivate
    subscription-sync.service.ts  Stripe subscription & invoice → our rows (sole writer)
    stripe-webhook.service.ts  Verify → store → claim → dispatch → mark
    billing-reconcile.service.ts  Cron safety net (failed events, stale subscriptions)

frontend/src/
  utils/billingApi.ts          API client + pure helpers (planAction, statusMeta, …)
  components/billing/          PricingPlans, BillingSettings, BillingReturnPage, useBilling
  components/views/PricingView.tsx   /pricing ("Plans & Billing" in the sidebar)
  Settings → Billing tab       /settings?tab=billing
  /billing/success, /billing/cancel  Stripe Checkout return pages
```

## Data model (`backend/prisma/schema/billing.prisma`)

- **Subscription**: one row per organization (`organization_id` unique), created lazily.
  No row, or a row without a Stripe subscription, means the free plan. Holds the
  Stripe customer/subscription/price ids, plan, interval, status, period dates,
  trial, cancellation, a booked downgrade (`pending_*` + `stripe_schedule_id`),
  the open Checkout Session (to reuse it on a second click), `past_due_since`
  (start of the grace period), and `last_stripe_event_at` / `synced_at` for monitoring.
- **Invoice**: mirrored from Stripe, unique on `stripe_invoice_id`. Hosted URL and PDF link.
- **Payment**: one per Stripe invoice (unique `stripe_invoice_id`), with the payment
  intent id, amount, status, method type only (e.g. `card`) and the decline reason.
  No card number, expiry or CVC is ever stored.
- **BillingEvent**: every webhook received, unique on `stripe_event_id`, with ids only
  (object, customer, subscription), processing status, attempts and the last error.

Plans are not a table: they live in code with Price IDs in env. Changing what a plan
includes is a one-file change, and changing a price is a new Stripe Price plus env and
catalog values — never a migration.

## Checkout flow

```
Browser                     API                                   Stripe
  │ POST /api/billing/checkout {plan, interval}
  │ ─────────────────────────► resolve Price from env
  │                            prices.retrieve → amount/currency/interval match? ──►
  │                            reuse open session for same plan? (else expire old)
  │                            customers.create (idempotent, once per org)  ───────►
  │                            checkout.sessions.create (idempotency key)  ────────►
  │ ◄───────────────────────── { url }
  │ ── redirect to checkout.stripe.com ───────────────────────────────────────────►
  │                                                        customer pays
  │ ◄── redirect /billing/success?session_id=cs_… ─────────────────────────────────
  │ poll GET /api/billing/checkout/:id ─► sessions.retrieve (must be this org's) ──►
  │      + GET /api/billing/subscription   if complete: subscriptions.retrieve ────►
  │                                     ◄─ POST /billing/webhook (checkout.session.completed)
  │                                        verify, store, subscriptions.retrieve ─►
  │                                        write plan/status from Stripe's answer
  │ "You're on Professional" once the server reports active/trialing
```

`session_id` in the URL is only a lookup key. The server asks Stripe for that session,
checks it belongs to the caller's Stripe customer and organization, and syncs the
subscription from Stripe. Either the webhook or this check gets there first; the
result is the same.

## Plan changes

| Change | How | When it applies |
|---|---|---|
| Upgrade (higher plan, or monthly → yearly) | `subscriptions.update` with `proration_behavior: always_invoice` and `payment_behavior: pending_if_incomplete` | Immediately, but **only once the prorated invoice is paid**; until then Stripe keeps the old price and so do we |
| Downgrade (lower plan, or yearly → monthly) | Subscription schedule: current phase to period end, then the new price; `end_behavior: release` | At the end of the period already paid for |
| Choose the current plan while a downgrade is booked | Release the schedule | Keeps the current plan |
| Cancel | `cancel_at_period_end: true` (immediate only with `BILLING_ALLOW_IMMEDIATE_CANCEL`) | Period end |
| Reactivate | `cancel_at_period_end: false` | Immediately |

The row is updated from the subscription object Stripe returns, and the webhooks that
follow re-apply the same state.

## Subscription lifecycle and access policy (`access-policy.ts`)

| Stripe status | Features granted | Notes |
|---|---|---|
| none / FREE | Free | Default for every organization |
| `trialing` | Subscribed plan | `BILLING_TRIAL_DAYS` on the first subscription only |
| `active` | Subscribed plan | Also while `cancel_at_period_end` until the period ends |
| `past_due` | Subscribed plan for `BILLING_PAST_DUE_GRACE_DAYS`, then Free | Stripe Smart Retries keep trying; `invoice.paid` recovers |
| `unpaid` | Free | Stripe stopped retrying |
| `incomplete` | Free | First payment not confirmed (3-D Secure, bank delay); never granted on an unverified payment |
| `incomplete_expired` | Free | First payment never completed |
| `paused` | Free | Trial ended without a payment method (if configured) |
| `canceled` | Free | History kept; a new checkout is allowed |

Going over a limit after a downgrade never removes data or members. It only blocks
adding more.

## Webhook processing

1. **Verify**: `stripe.webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET)`.
   Nest keeps the exact bytes because `NestFactory.create(..., { rawBody: true })`
   is set in `server.ts`, which leaves every other route's JSON parsing unchanged.
   A bad signature returns 400 and stores nothing.
2. **Store**: insert into `billing_events`. The unique `stripe_event_id` turns a
   redelivery into a lookup. If the event is already processed or ignored, the
   endpoint returns 200 `duplicate`.
3. **Claim**: a conditional update moves `pending|failed` (or `processing` older than
   5 minutes, meaning a crashed worker) to `processing`. Only one delivery or one
   server wins; a loser gets 409 and Stripe retries later.
4. **Dispatch**: the handler **re-reads the object from Stripe** (subscription or
   invoice) and applies that, not the event body. This is how out-of-order events
   resolve: whichever arrives, the row ends at Stripe's current state. Two more guards:
   - an event for a *different* subscription than the current one is applied only if
     ours has ended and theirs has not, so a late event from an old, canceled
     subscription cannot overwrite the new one;
   - a Payment that succeeded is never moved back to failed.
5. **Verify ownership**: the Stripe customer must map to our row. If the object's
   `metadata.organizationId` (or `client_reference_id`) names a different
   organization, the event fails with `TenantMismatchError` and is never applied.
   Customers that are not ours are `ignored` (200), so Stripe stops retrying.
6. **Mark**: `processed` / `ignored`, or `failed` with the error. A failure returns
   500, Stripe retries with backoff for up to 3 days, and the reconciler retries too.

A test-mode event reaching a live server, or the reverse, is ignored.

Handled events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`checkout.session.expired`, `customer.subscription.{created,updated,deleted,paused,resumed,pending_update_applied,pending_update_expired,trial_will_end}`,
`invoice.{paid,payment_succeeded,payment_failed,finalized,payment_action_required,voided,marked_uncollectible}`.

## Reliability

- **Stripe down**: every Stripe call goes through `StripeService.call`, which uses the
  SDK's automatic retries (2) and a 20s timeout. A failure becomes a 502
  `UPSTREAM_ERROR` to the user, or a `failed` event that is retried later.
- **Database down**: the webhook cannot store the event and answers 503, so Stripe retries.
- **Reconciler** (`BillingReconcileService`, every 10 minutes, on with
  `BILLING_RECONCILE_ENABLED`): re-fetches failed or stuck events from Stripe
  (`events.retrieve`) and runs them through the same claim, up to 10 attempts. It also
  re-reads every paid subscription not synced in 24h. It is safe on several
  instances.
- **Idempotency keys** on customer creation, checkout sessions, upgrades and schedules,
  so a retried or double-clicked request never creates a second object.

## Entitlements

`EntitlementService` is the only place plan names are compared:

- `@RequireFeature(FEATURES.X)` on a route (a route guard, so it runs after JWT and
  permissions). Applied today to:
  - follow-up sequence create, step edit and enroll (`lead_automation`, Professional+);
  - calendar connect: Calendly authorize, Cal.com teams/connect, activate
    (`calendar_integration`, Professional+).
  Reads, disconnects and existing connections are never gated.
- `assertCanAddMembers(orgId)` in `UserService.create`, which covers Team → Add member
  and calendar member imports (`PLAN_LIMIT_REACHED`).
- `BILLING_ENFORCEMENT_ENABLED=0` (the default) puts checks in **shadow mode**: they run
  and log `[not enforced] … would be blocked` but allow the request. Existing
  organizations, all on Free until they subscribe, keep working when billing is
  deployed. Switch it on at launch.

To add a gated feature: add it to `FEATURES` and the right plans in `billing-plans.ts`,
then put `@RequireFeature(FEATURES.NEW_ONE)` on the route.

## Permissions

`billing.read` (view plan, usage, invoices) and `billing.manage` (checkout, change plan,
cancel, portal) are new entries in the permission catalog. The Owner (system role) has
both. Agents have neither, and custom roles can be granted them in Roles & Permissions.

## Security notes

- The secret key is read only by `StripeService` and never serialized. Stripe error
  messages (which can contain ids) are logged server-side and replaced by generic
  messages, except card declines, which are written for the cardholder.
- Webhook logs and `billing_events.metadata` hold ids only, never customer
  names, emails or addresses.
- POSTs to `/api/billing/*` are rate-limited (30 per 10 minutes per session).
  The webhook uses the inbound-provider bucket.
- Deleting an organization with a live subscription is refused, because deleting the
  org would not stop Stripe charging it.
- The frontend redirects only to `https://*.stripe.com/` URLs returned by the server.
