/**
 * Routes that stay at the root, outside API_PREFIX: outside services were handed
 * these URLs (Telnyx, calendar webhooks, booking tools, Stripe), so moving
 * them would break every connection already installed. Health stays put for uptime checks.
 */
export const ROOT_ROUTES = [
  'health',
  'v1/health',
  'webhooks/telnyx/voice',
  'webhooks/telnyx/messaging',
  'webhooks/telnyx/assistant-variables',
  'calendar-webhooks/:connectionId',
  'tools/telnyx/booking/availability',
  'tools/telnyx/booking/book',
  'tools/telnyx/outcome/callback',
  'tools/telnyx/outcome/text',
  'tools/telnyx/outcome/record',
  'tools/telnyx/outcome/meeting',
  'tools/telnyx/outcome/transfer',
  // Registered in the Stripe Dashboard as the billing webhook endpoint.
  'billing/webhook',
  // Registered in the Nango dashboard (Environment Settings → Webhooks).
  'webhooks/nango',
];
