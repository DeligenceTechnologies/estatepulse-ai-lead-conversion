# Billing API

App routes are served under `/api` and need a session (`Authorization: Bearer <access token>`)
unless marked public. The organization is always the session's own; no route accepts an
organization id. Errors use the app's envelope:

```json
{ "error": { "code": "BILLING_NOT_CONFIGURED", "message": "Checkout for Business (yearly) is not configured yet." } }
```

Amounts are integers in the currency's smallest unit (paise for INR).

## GET /api/billing/plans (public)

The catalog with display prices. Price IDs never leave the server.

```json
{
  "currency": "inr",
  "mode": "test",
  "checkoutConfigured": true,
  "features": [{ "key": "lead_automation", "label": "Lead automation (follow-up sequences)" }],
  "plans": [
    {
      "key": "PROFESSIONAL",
      "name": "Professional",
      "description": "…",
      "recommended": true,
      "prices": { "MONTHLY": 299900, "YEARLY": 2999900 },
      "checkoutAvailable": { "MONTHLY": true, "YEARLY": true },
      "features": ["lead_management", "basic_crm", "basic_dashboard", "advanced_crm", "lead_automation", "advanced_analytics", "calendar_integration"],
      "limits": { "maxMembers": 10 }
    }
  ]
}
```

## GET /api/billing/subscription (`billing.read`)

```json
{
  "plan": "PROFESSIONAL",            // features that apply NOW (see the access policy)
  "subscribedPlan": "PROFESSIONAL",  // what is on file
  "accessReason": "paid",            // free_plan | paid | trial | past_due_grace | past_due_expired | unpaid | canceled | incomplete | paused
  "graceEndsAt": null,
  "status": "active",                // Stripe's status, or null on the free plan
  "hasSubscription": true,
  "hasBillingAccount": true,
  "billingInterval": "MONTHLY",
  "currentPeriodStart": "2026-11-23T10:00:00.000Z",
  "currentPeriodEnd": "2026-12-23T10:00:00.000Z",
  "renewsAt": "2026-12-23T10:00:00.000Z",   // null once set to cancel
  "trialEnd": null,
  "cancelAtPeriodEnd": false,
  "canceledAt": null,
  "endedAt": null,
  "pendingChange": { "plan": "STARTER", "interval": "MONTHLY", "effectiveAt": "2026-12-23T10:00:00.000Z" },
  "checkoutPending": false,
  "features": ["…"],
  "limits": { "maxMembers": 10 },
  "enforced": true,
  "mode": "test",
  "immediateCancelAllowed": false,
  "lastSyncedAt": "2026-11-23T10:00:05.000Z"
}
```

## GET /api/billing/usage (`billing.read`)

```json
{
  "plan": "STARTER",
  "enforced": true,
  "members": { "used": 3, "limit": 3, "atLimit": true, "overLimit": false },
  "features": ["lead_management", "basic_crm", "basic_dashboard"],
  "upgradeRecommendation": { "plan": "PROFESSIONAL", "reason": "Your plan allows 3 team members." }
}
```

## GET /api/billing/invoices (`billing.read`)

Paginated with the app's standard list parameters: `page`, `limit` (max 100),
`sortBy=issuedAt|amountDue`, `sortOrder`, `status=paid|open|void|uncollectible|draft`.

```json
{
  "data": [{
    "id": "…", "stripeInvoiceId": "in_…", "number": "ABCD-0001",
    "amountDue": 299900, "amountPaid": 299900, "currency": "inr", "status": "paid",
    "invoiceUrl": "https://invoice.stripe.com/…", "invoicePdf": "https://pay.stripe.com/…/pdf",
    "periodStart": "…", "periodEnd": "…", "dueDate": null, "paidAt": "…", "issuedAt": "…"
  }],
  "meta": { "page": 1, "limit": 10, "count": 1, "total": 1, "totalPages": 1, "hasNextPage": false, "hasPrevPage": false }
}
```

## POST /api/billing/checkout (`billing.manage`)

```json
{ "plan": "PROFESSIONAL", "interval": "MONTHLY" }
```

`plan` must be `STARTER`, `PROFESSIONAL` or `BUSINESS`, and `interval` `MONTHLY` or
`YEARLY`. Any other field is rejected with 400.

Response `200`:
```json
{ "url": "https://checkout.stripe.com/c/pay/cs_test_…", "sessionId": "cs_test_…", "reused": false }
```

`reused: true` means an open session from an earlier click was returned.

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Unknown plan or interval, or extra fields |
| 400 | `BILLING_INVALID_PLAN` | `FREE` |
| 409 | `SUBSCRIPTION_EXISTS` | A live subscription exists; use change-plan |
| 409 | `SUBSCRIPTION_PENDING` | A first payment is still being confirmed |
| 503 | `BILLING_NOT_CONFIGURED` | No Stripe key, Price ID or return URL |
| 503 | `BILLING_PRICE_MISMATCH` | The Stripe Price differs from the catalog |
| 502 | `UPSTREAM_ERROR` / `BILLING_PROVIDER_ERROR` | Stripe unavailable or rejected the request |

## GET /api/billing/checkout/:sessionId (`billing.read`)

Where a Checkout Session stands, **read from Stripe**. The session must belong to the
caller's organization (404 otherwise). A completed session's subscription is synced
from Stripe on the spot.

```json
{ "status": "complete", "paymentStatus": "paid" }   // status: open | complete | expired
```

## POST /api/billing/portal (`billing.manage`)

Response `{ "url": "https://billing.stripe.com/p/session/…" }`. Returns 409
`NO_BILLING_ACCOUNT` before the first checkout.

## POST /api/billing/change-plan (`billing.manage`)

Same body as checkout. Upgrades apply now, prorated, once paid. Downgrades are booked
for the period end.

```json
{ "change": "upgrade", "effectiveAt": "2026-11-23T10:05:00.000Z", "paymentRequired": false, "invoiceUrl": null }
```

`change` is `upgrade`, `downgrade`, or `kept` (choosing the current plan while a
downgrade is booked cancels the downgrade). With `paymentRequired: true` the plan has
not changed yet; `invoiceUrl` is where to finish the payment.

| Status | Code | When |
|---|---|---|
| 409 | `NO_ACTIVE_SUBSCRIPTION` | Nothing to change; use checkout |
| 409 | `ALREADY_ON_PLAN` | Same plan and interval |
| 409 | `SUBSCRIPTION_PAYMENT_ISSUE` | past_due / unpaid / incomplete; fix payment first |
| 402 | `PAYMENT_FAILED` | The card was declined (message is the bank's) |

## POST /api/billing/cancel (`billing.manage`)

Body `{}` or `{ "immediately": true }`. Response:
`{ "cancelAtPeriodEnd": true, "endsAt": "2026-12-23T10:00:00.000Z" }`.
Immediate cancellation is refused (400 `IMMEDIATE_CANCEL_DISABLED`) unless
`BILLING_ALLOW_IMMEDIATE_CANCEL=1`.

## POST /api/billing/reactivate (`billing.manage`)

Undoes a scheduled cancellation and returns `{ "reactivated": true }`. Returns 409
`SUBSCRIPTION_NOT_CANCELING` if the subscription is not set to cancel.

## POST /billing/webhook (public, Stripe only)

At the API **root**, not under `/api`. Authenticated by the `Stripe-Signature` header
over the raw body.

| Status | Body | Meaning |
|---|---|---|
| 200 | `{"received":true,"status":"processed"}` | Applied |
| 200 | `…"ignored"` | Not ours, not handled, or wrong mode |
| 200 | `…"duplicate"` | Already processed; nothing done |
| 400 | `{"error":"invalid_signature"}` / `empty_body` | Rejected, nothing stored |
| 409 | `{"error":"in_progress"}` | Being processed by another delivery; Stripe retries |
| 500 | `{"error":"processing_failed"}` | Stored as failed; Stripe and the reconciler retry |
| 503 | `{"error":"not_configured"}` / `temporarily_unavailable` | Missing config, or the DB is down |

## Plan restriction errors (any route)

Gated routes and member creation answer `403` with:

```json
{ "error": { "code": "PLAN_UPGRADE_REQUIRED", "message": "Lead automation (follow-up sequences) needs the Professional plan.",
             "feature": "lead_automation", "requiredPlan": "PROFESSIONAL", "currentPlan": "STARTER" } }

{ "error": { "code": "PLAN_LIMIT_REACHED", "message": "Your Starter plan allows 3 team members. Upgrade to Professional to add more.",
             "limit": "maxMembers", "used": 3, "max": 3, "requiredPlan": "PROFESSIONAL", "currentPlan": "STARTER" } }
```

These are only raised with `BILLING_ENFORCEMENT_ENABLED=1`; otherwise the check is
logged and the request proceeds.
