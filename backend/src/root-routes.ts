/**
 * Routes that stay at the root, outside API_PREFIX: outside services were handed
 * these URLs (lead webhooks, Telnyx, calendar webhooks, booking tools, the
 * Calendly OAuth redirect), so moving them would break every connection already
 * installed. Health stays put for uptime checks.
 */
export const ROOT_ROUTES = [
  'health',
  'v1/health',
  'ingest/v1/tally/:token',
  'ingest/v1/typeform/:token',
  'ingest/v1/jotform/:token',
  'ingest/v1/webhook/:token',
  'ingest/v1/custom/:token',
  // The URL baked into the Apps Script on an owner's Google Form.
  'ingest/v1/google-forms/:token',
  'ingest/v1/crm/hubspot/webhook',
  // Where Airtable sends a base's change notifications.
  'ingest/v1/airtable/webhook',
  'webhooks/leads/:token',
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
  'org-settings/calendar/calendly/callback',
];
