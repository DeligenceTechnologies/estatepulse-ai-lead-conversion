import type { IntegrationConnectionStatus, IntegrationSyncStatus, IntegrationSyncTrigger } from '@prisma/client';
import type { IntegrationCapability, SetupState } from './adapters/adapter.interface';

/**
 * Whether a marketplace provider can be connected right now.
 * - ready                   EstatePulse implements it and Nango has it configured: Connect works.
 * - configuration_required  EstatePulse implements it, but Nango is not set up for it yet
 *                           (no NANGO_SECRET_KEY, no integration in the dashboard, or missing fields).
 * - unsupported             Nango offers it, EstatePulse has no business functionality for it yet.
 */
export type ProviderReadiness = 'ready' | 'configuration_required' | 'unsupported';

/** How the organization stands with a provider, summarised over all its accounts. */
export type ProviderConnectionSummary = 'connected' | 'attention' | 'not_connected';

export interface MarketplaceProvider {
  /** Nango's provider name in its catalog, e.g. "airtable". */
  id: string;
  name: string;
  logoUrl: string | null;
  categories: string[];
  /** OAUTH2, API_KEY... from the catalog. */
  authMode: string | null;
  docsUrl: string | null;
  description: string | null;
  features: string[];
  capabilities: IntegrationCapability[];
  /** EstatePulse has built functionality for this provider. */
  supported: boolean;
  /** An integration exists for it in our Nango environment. */
  configured: boolean;
  readiness: ProviderReadiness;
  /** Why it is not ready, in a sentence for the customer. Null when ready. */
  readinessMessage: string | null;
  connectionCount: number;
  connectionSummary: ProviderConnectionSummary;
}

export interface MarketplaceProviderDetail extends MarketplaceProvider {
  requiredScopes: string[];
  /** Missing pieces in the Nango dashboard, for an admin (never secrets). */
  missingFields: string[];
  connections: ConnectionView[];
}

export interface MarketplaceCategory {
  id: string;
  label: string;
  count: number;
}

export interface MarketplaceList {
  nango: { configured: boolean; webhooksConfigured: boolean; catalogAvailable: boolean };
  items: MarketplaceProvider[];
  total: number;
  limit: number;
  offset: number;
  categories: MarketplaceCategory[];
  counts: {
    /** Providers in Nango's catalog (or the ones EstatePulse implements when the catalog is unreachable). */
    catalog: number;
    supported: number;
    ready: number;
    /** Providers the organization has at least one live account of. */
    connectedProviders: number;
    connectedAccounts: number;
  };
}

export interface SyncRunView {
  id: string;
  trigger: IntegrationSyncTrigger;
  status: IntegrationSyncStatus;
  stats: SyncStats;
  attempts: number;
  errorMessage: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface SyncStats {
  fetched: number;
  created: number;
  attached: number;
  unchanged: number;
  skipped: number;
  failed: number;
  /** True when the run stopped at INTEGRATION_SYNC_MAX_RECORDS. */
  truncated?: boolean;
}

export interface TwoWayView {
  enabled: boolean;
  /** Why writing back is paused (e.g. the grant has no write access). Cleared on reconnect. */
  error: string | null;
  errorAt: string | null;
  /** Scopes the provider grant needs for writing. */
  writeScopes: string[];
  /** Linked records whose last write-back failed. */
  failedRecords: number;
  lastPushedAt: string | null;
}

export const EMPTY_STATS: SyncStats = { fetched: 0, created: 0, attached: 0, unchanged: 0, skipped: 0, failed: 0 };

export interface ConnectionView {
  id: string;
  provider: string;
  providerName: string;
  providerConfigKey: string;
  status: IntegrationConnectionStatus;
  accountName: string | null;
  accountEmail: string | null;
  externalAccountId: string | null;
  metadata: Record<string, unknown>;
  setup: SetupState | null;
  /** The provider-specific settings (Airtable base/table/field map). No secrets are ever stored there. */
  settings: Record<string, unknown>;
  canSync: boolean;
  lastSyncedAt: string | null;
  lastError: { code: string | null; message: string | null; at: string | null } | null;
  latestRun: SyncRunView | null;
  leadSource: { id: string; name: string } | null;
  /** Two-way sync, for providers that can write back. null = this provider only imports. */
  twoWay: TwoWayView | null;
  connectedAt: string;
  disconnectedAt: string | null;
}

/** What POST /integrations/:providerId/connect answers: only what Nango's Connect UI needs. */
export interface ConnectSessionView {
  sessionToken: string;
  expiresAt: string;
  providerConfigKey: string;
  /** Self-hosted Nango only; null = Nango Cloud defaults. */
  apiURL: string | null;
  baseURL: string | null;
}

export interface PushJobData {
  recordId: string;
}

export interface SyncJobData {
  runId: string;
}
