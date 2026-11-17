# Pricing: Model, Backend and Frontend Requirements

Owner: Rohit

## Summary

We price on usage that tracks our real cost (AI call minutes and leads handled), not on seats. Three plans at $149, $399 and $999 per month, two months free on annual billing, a 14-day trial with a hard usage cap, and Stripe for all billing. Customers bring their own Telnyx account, so call and SMS charges are billed by Telnyx and stay off our books; we charge only for the AI layer.

**Launch condition:** usage metering and plan limits must be live in the backend before the pricing page goes public.

## Pricing model

| Plan | Price / month | For | Included |
|---|---|---|---|
| Starter | $149 | Solo agent | 1 AI agent, 1 number, 300 AI call minutes, 500 leads, SMS follow-up, 1 CRM integration |
| Growth (recommended) | $399 | Teams of 2 to 10 | 3 AI agents, 5 numbers, 1,200 AI call minutes, 2,500 leads, all integrations, recordings and transcripts, lead routing |
| Scale | $999 | Brokerages | 10 AI agents, unlimited numbers, 4,000 AI call minutes, 10,000 leads, custom qualification flows, priority support |

Overage: $0.15 per extra AI minute. Annual billing: pay for 10 months, get 12.

The limits and the overage rate are starting values. Fix them only after we measure our cost per AI minute (LLM, speech-to-text and text-to-speech together). Rule: overage at least 3x unit cost, and at least 75% gross margin on every plan.

## Recommendations

- **Make AI minutes the main limit.** It is the one number that tracks our cost.
- **State Telnyx charges up front.** The pricing page says "Telnyx call and SMS charges are billed by Telnyx." This prevents surprise bills and support tickets.
- **No free plan.** Every AI minute costs us money.
- **Trial:** 14 days, no card, capped at 30 AI minutes. A card is needed only to go past the cap. Sign-up stays easy and abuse cost stays bounded.
- **Never stop calling a hot lead without warning.** Warn at 80% of a limit. At 100%, paid plans continue on overage by default, with an off switch.
- **Founding-customer offer:** price locked for 12 months for the first 20 customers, in exchange for a logo and a quote.
- **Keep prices in Stripe and limits in config**, never hard-coded, so we can change pricing without a release.
- **Review pricing after the first 20 paying customers**, using real usage data.

## Backend requirements

### Billing (Stripe)

- Products and prices live in Stripe; their IDs live in config.
- Stripe Checkout for sign-up and upgrades. Stripe Customer Portal for card changes, invoices and cancellation.
- Webhooks: checkout.session.completed, customer.subscription.created, customer.subscription.updated, customer.subscription.deleted, invoice.paid, invoice.payment_failed. Verify the signature and process each event only once (store the event ID).
- Turn on Stripe Tax for US sales tax and Canadian GST/HST.

### Data model

| Table | Fields |
|---|---|
| Plan | Name, monthly and annual Stripe price IDs, limits as JSON (minutes, leads, agents, numbers, features) |
| Subscription | Organisation, plan, status, period start and end, trial end, cancel at period end |
| UsageRecord | Organisation, metric, quantity, timestamp, source ID (call or lead ID, so nothing is counted twice) |
| WebhookEvent | Stripe event ID and processed time |

### Metering and limits

- Record AI minutes when a call ends, leads when they are created, and agents and numbers when they are added.
- One entitlement check, canUse(organisation, feature), runs before every AI call, new agent, new number and new integration. It returns a clear error code such as PLAN_LIMIT_REACHED, which the frontend turns into an upgrade prompt.
- Limits are enforced on the server. UI checks alone are not enough.
- Overage minutes are reported to a Stripe metered price once a day.

### Subscription lifecycle

- Daily job expires trials and sends the 80% and 100% usage emails.
- Failed payment: status becomes past_due, a 7-day grace period starts, then outbound AI calls pause. Data is never deleted.
- A downgrade takes effect at period end. If usage is over the new plan's limits, new usage is blocked; existing data stays.
- Internal admin endpoint to change a plan, extend a trial or add credit. Every change writes an audit log entry.

## Frontend requirements

### Public pricing page

- Three plan cards, a monthly/annual toggle and a "Recommended" badge on Growth.
- A full feature comparison table below the cards.
- FAQ covering Telnyx charges, overage, the trial, cancelling anytime and refunds.
- Each card's button opens sign-up with that plan already selected (/signup?plan=growth).

### In-app billing (Settings, Billing)

- Current plan, status, renewal date and price.
- Usage meters with progress bars for AI minutes, leads, agents and numbers.
- Upgrade and downgrade buttons that show the price difference.
- "Manage billing" button that opens the Stripe Customer Portal, plus an invoice list.
- Overage on/off switch with the per-minute price shown next to it.

### Prompts and states

- Banners for trial days left, 80% usage, limit reached and payment failed.
- At a limit (for example, adding a second agent on Starter), show an upgrade modal comparing the two plans instead of an error.
- Locked features stay visible with a lock icon and the name of the plan that unlocks them.
- Every subscription status has a screen state: trialing, active, past_due, paused, canceled.
- After Checkout, a "Setting up your plan" screen waits until the webhook confirms the subscription.

## Before launch

- Measure the real cost per AI minute and confirm every plan clears 75% gross margin.
- Run the full flow in Stripe test mode: sign-up, upgrade, downgrade, failed card, cancel and trial expiry.
- Confirm the API enforces every limit, not only the UI.
- Publish terms of service and a refund policy, linked from the pricing page.
