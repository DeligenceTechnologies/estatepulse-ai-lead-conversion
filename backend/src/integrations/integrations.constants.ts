/** Every route of the marketplace lives under /api/integrations. */
export const INTEGRATIONS_ROUTE = 'integrations';

/** Nango's webhook endpoint. Root route (outside /api): it is registered in the Nango dashboard. */
export const NANGO_WEBHOOK_ROUTE = 'webhooks/nango';

/**
 * Tags written on every connect session this server creates. Nango copies them
 * onto the connection, so a connection that carries them was made from a
 * session we issued for that organization and user.
 */
export const NANGO_TAG = {
  organizationId: 'organization_id',
  userId: 'end_user_id',
  integration: 'integration',
} as const;

/** DI token for the list of provider adapters (one per provider EstatePulse implements). */
export const INTEGRATION_ADAPTERS = Symbol('INTEGRATION_ADAPTERS');

/** How long a webhook delivery id is remembered, so a redelivery is not processed twice. */
export const WEBHOOK_DEDUPE_TTL_SECONDS = 48 * 60 * 60;

/** Category labels for the ones Nango uses most; others are title-cased from the slug. */
export const CATEGORY_LABELS: Record<string, string> = {
  crm: 'CRM',
  marketing: 'Marketing',
  productivity: 'Productivity',
  communication: 'Communication',
  storage: 'Storage',
  automation: 'Automation',
  'knowledge-base': 'Knowledge base',
  'dev-tools': 'Developer tools',
  ticketing: 'Ticketing',
  accounting: 'Accounting',
  hr: 'HR',
  analytics: 'Analytics',
  design: 'Design',
  'e-commerce': 'E-commerce',
  erp: 'ERP',
  legal: 'Legal',
  payment: 'Payments',
  sports: 'Sports',
  surveys: 'Surveys',
  video: 'Video',
  banking: 'Banking',
  cybersecurity: 'Security',
  gaming: 'Gaming',
  invoicing: 'Invoicing',
  mcp: 'MCP',
  other: 'Other',
};
