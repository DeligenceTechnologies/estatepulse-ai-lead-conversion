/**
 * Every third-party account an organization connects. Nango holds all of their
 * credentials (OAuth grants and API keys alike); our tables keep the account,
 * its business data and the Nango connection id.
 *
 * Each value is the integration's "Unique Key" (providerConfigKey) in the Nango
 * dashboard; create the integrations under exactly these keys.
 */
export const NANGO_INTEGRATIONS = {
  // OAuth 2
  google: 'google',
  airtable: 'airtable',
  hubspot: 'hubspot',
  calendly: 'calendly',
  typeform: 'typeform',
  // API key
  tally: 'tally',
  telnyx: 'telnyx',
  cal: 'cal-com',
} as const;

export type NangoIntegration = keyof typeof NANGO_INTEGRATIONS;

export const NANGO_INTEGRATION_LABELS: Record<NangoIntegration, string> = {
  google: 'Google',
  airtable: 'Airtable',
  hubspot: 'HubSpot',
  calendly: 'Calendly',
  typeform: 'Typeform',
  tally: 'Tally',
  telnyx: 'Telnyx',
  cal: 'Cal.com',
};

/**
 * Tags set on every connect session, server side. Nango copies them onto the
 * connection and into its auth webhooks; they are how a connection is tied to
 * its organization. Keys must start with a letter and Nango lowercases them.
 */
export const NANGO_TAG = {
  organizationId: 'organization_id',
  userId: 'end_user_id',
  userEmail: 'end_user_email',
  integration: 'integration',
} as const;

export const NANGO_QUEUE = 'nango';

export const NangoJob = {
  /** Apply one stored webhook event. */
  Webhook: 'webhook',
  /**
   * A connection Nango created that the browser never reported back (the tab
   * was closed mid-flow): finish it from the webhook, a little later, so the
   * browser's own completion normally wins.
   */
  Reconcile: 'reconcile',
} as const;

/** How long after a "creation"/"override" webhook the server finishes a connection itself. */
export const RECONCILE_DELAY_MS = 2 * 60_000;
