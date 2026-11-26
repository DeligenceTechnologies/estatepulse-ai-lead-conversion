import { apiFetch } from '../lib/api';

/**
 * The Integration Marketplace API (backend/src/integrations). The catalog comes
 * from Nango through the backend; nothing about which providers exist is
 * hardcoded here. No secret ever reaches this module: a connect returns only a
 * short-lived Nango Connect session token.
 */

export type ProviderReadiness = 'ready' | 'configuration_required' | 'unsupported';
export type ProviderConnectionSummary = 'connected' | 'attention' | 'not_connected';
export type ConnectionStatus = 'connected' | 'reauth_required' | 'error' | 'disconnected';
export type SyncStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export type SyncTrigger = 'manual' | 'connected' | 'webhook' | 'schedule';

export interface MarketplaceProvider {
  id: string;
  name: string;
  logoUrl: string | null;
  categories: string[];
  authMode: string | null;
  docsUrl: string | null;
  description: string | null;
  features: string[];
  capabilities: string[];
  supported: boolean;
  configured: boolean;
  readiness: ProviderReadiness;
  readinessMessage: string | null;
  connectionCount: number;
  connectionSummary: ProviderConnectionSummary;
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
  counts: { catalog: number; supported: number; ready: number; connectedProviders: number; connectedAccounts: number };
}

export interface SyncStats {
  fetched: number;
  created: number;
  attached: number;
  unchanged: number;
  skipped: number;
  failed: number;
  truncated?: boolean;
}

export interface SyncRun {
  id: string;
  trigger: SyncTrigger;
  status: SyncStatus;
  stats: SyncStats;
  attempts: number;
  errorMessage: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface SetupState {
  complete: boolean;
  missing: string | null;
  summary: string | null;
}

export interface IntegrationConnection {
  id: string;
  provider: string;
  providerName: string;
  providerConfigKey: string;
  status: ConnectionStatus;
  accountName: string | null;
  accountEmail: string | null;
  externalAccountId: string | null;
  metadata: Record<string, unknown>;
  setup: SetupState | null;
  settings: Record<string, unknown>;
  canSync: boolean;
  lastSyncedAt: string | null;
  lastError: { code: string | null; message: string | null; at: string | null } | null;
  latestRun: SyncRun | null;
  leadSource: { id: string; name: string } | null;
  /** Two-way sync; null when this provider only imports. */
  twoWay: TwoWaySync | null;
  connectedAt: string;
  disconnectedAt: string | null;
}

export interface TwoWaySync {
  enabled: boolean;
  /** Why writing back is paused (the grant has no write access...). Cleared on reconnect. */
  error: string | null;
  errorAt: string | null;
  writeScopes: string[];
  failedRecords: number;
  lastPushedAt: string | null;
}

export interface MarketplaceProviderDetail extends MarketplaceProvider {
  requiredScopes: string[];
  missingFields: string[];
  connections: IntegrationConnection[];
}

export interface ConnectSession {
  sessionToken: string;
  expiresAt: string;
  providerConfigKey: string;
  apiURL: string | null;
  baseURL: string | null;
}

export interface SetupResource {
  id: string;
  name: string;
  detail?: Record<string, unknown>;
}

export interface ProviderQuery {
  search?: string;
  category?: string;
  status?: 'all' | 'connected' | 'not_connected' | 'supported';
  limit?: number;
  offset?: number;
}

const BASE = '/integrations';
const id = (value: string) => encodeURIComponent(value);

export const integrationsApi = {
  listProviders: (query: ProviderQuery = {}) => {
    const q = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === '' || value === 'all') continue;
      q.set(key, String(value));
    }
    const qs = q.toString();
    return apiFetch<MarketplaceList>(`${BASE}/providers${qs ? `?${qs}` : ''}`, { auth: true });
  },
  provider: (providerId: string) => apiFetch<MarketplaceProviderDetail>(`${BASE}/providers/${id(providerId)}`, { auth: true }),
  /** A Nango Connect session for one more account of this provider. */
  connect: (providerId: string) => apiFetch<ConnectSession>(`${BASE}/${id(providerId)}/connect`, { method: 'POST', auth: true }),
  /** What Connect UI reported; the server verifies it with Nango before linking. */
  confirm: (providerConfigKey: string, connectionId: string) =>
    apiFetch<IntegrationConnection>(`${BASE}/connections/confirm`, { method: 'POST', body: { providerConfigKey, connectionId }, auth: true }),
  connections: (filter: { provider?: string; status?: ConnectionStatus } = {}) => {
    const q = new URLSearchParams(Object.entries(filter).filter(([, v]) => v) as [string, string][]).toString();
    return apiFetch<IntegrationConnection[]>(`${BASE}/connections${q ? `?${q}` : ''}`, { auth: true });
  },
  connection: (connectionId: string) => apiFetch<IntegrationConnection>(`${BASE}/connections/${id(connectionId)}`, { auth: true }),
  reconnect: (connectionId: string) =>
    apiFetch<ConnectSession>(`${BASE}/connections/${id(connectionId)}/reconnect`, { method: 'POST', auth: true }),
  disconnect: (connectionId: string) =>
    apiFetch<IntegrationConnection>(`${BASE}/connections/${id(connectionId)}/disconnect`, { method: 'POST', auth: true }),
  sync: (connectionId: string) =>
    apiFetch<{ run: SyncRun; created: boolean }>(`${BASE}/connections/${id(connectionId)}/sync`, { method: 'POST', auth: true }),
  runs: (connectionId: string, limit = 10) =>
    apiFetch<SyncRun[]>(`${BASE}/connections/${id(connectionId)}/sync-runs?limit=${limit}`, { auth: true }),
  resources: (connectionId: string, kind: string, parentId?: string) => {
    const q = new URLSearchParams({ kind, ...(parentId ? { parentId } : {}) }).toString();
    return apiFetch<SetupResource[]>(`${BASE}/connections/${id(connectionId)}/resources?${q}`, { auth: true });
  },
  updateSettings: (connectionId: string, settings: Record<string, unknown>) =>
    apiFetch<IntegrationConnection>(`${BASE}/connections/${id(connectionId)}/settings`, { method: 'PATCH', body: { settings }, auth: true }),
  setWriteBack: (connectionId: string, enabled: boolean) =>
    apiFetch<IntegrationConnection>(`${BASE}/connections/${id(connectionId)}/write-back`, { method: 'PATCH', body: { enabled }, auth: true }),
};

export const isSyncActive = (run: SyncRun | null | undefined): boolean => run?.status === 'queued' || run?.status === 'running';
