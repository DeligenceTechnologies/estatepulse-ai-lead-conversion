import { ApiError, apiFetch } from '../lib/api';
import { connectProvider, connectionsOf, disconnectConnection } from './connectionsApi';

/**
 * A connected CRM (HubSpot today) — owner only.
 *
 * The browser never holds a CRM token. It carries the authorization code from
 * the CRM's consent screen to the API, once, and everything after that happens
 * on the server: tokens, imports, webhooks.
 */

export type CrmProvider = 'hubspot';

export interface CrmCounts {
  fetched: number;
  created: number;
  updated: number;
  unchanged: number;
  linked: number;
  conflicts: number;
  duplicates: number;
  skipped: number;
  failed: number;
  missing: number;
}

export interface CrmRun {
  id: string;
  /** initial: the first import; full: a later complete re-read. */
  kind: 'initial' | 'full';
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  counts: CrmCounts;
  pages: number;
  /** Consecutive failures so far; with nextAttemptAt, a run that is waiting to retry. */
  attempts: number;
  nextAttemptAt: string | null;
  error: { code: string; message: string | null } | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface CrmStatus {
  provider: string;
  displayName: string;
  configured: boolean;
  status: 'not_connected' | 'connected' | 'reauthorization_required' | 'disconnected' | 'error';
  account: {
    id: string | null;
    name: string | null;
    /** The CRM user who approved the connection. */
    authorizedBy: string | null;
    /** The EstatePulse user who connected it. */
    connectedBy: string | null;
    connectedAt: string | null;
  } | null;
  sourceId: string | null;
  lastSuccessfulSyncAt: string | null;
  lastFailureAt: string | null;
  lastWebhookAt: string | null;
  nextReconcileAt: string | null;
  lastError: { code: string; message: string | null } | null;
  activeRun: CrmRun | null;
  lastRun: CrmRun | null;
  importedLeads: number;
  pendingReview: number;
  changesToReview: number;
}

const base = (p: CrmProvider) => `/integrations/crm/${p}`;

/** A CRM switched off on this server answers 404 everywhere. */
export const isCrmDisabled = (e: unknown): boolean => e instanceof ApiError && e.status === 404;

export const crmEnabled = (p: CrmProvider): Promise<boolean> =>
  apiFetch(`${base(p)}/config`, { auth: true }).then(
    () => true,
    (e) => !isCrmDisabled(e),
  );

export const getCrmStatus = (p: CrmProvider): Promise<CrmStatus> => apiFetch<CrmStatus>(`${base(p)}/status`, { auth: true });

/** A complete re-read now (or the first import). Asking while one runs returns that one. */
export const startCrmSync = (p: CrmProvider): Promise<{ run: CrmRun; alreadyActive: boolean }> =>
  apiFetch<{ run: CrmRun; alreadyActive: boolean }>(`${base(p)}/sync`, { method: 'POST', auth: true });

export const crmRuns = (p: CrmProvider): Promise<CrmRun[]> =>
  apiFetch<{ runs: CrmRun[] }>(`${base(p)}/runs`, { auth: true }).then((r) => r.runs);

/** Stops syncing and forgets the grant. Imported leads are kept. */
export async function disconnectCrm(p: CrmProvider): Promise<void> {
  const [connection] = await connectionsOf(p);
  if (connection) await disconnectConnection(connection.id);
}

/**
 * Connect the CRM through Nango Connect, then link the connection to this
 * organization (which queues the first import). Resolves null when the window
 * was closed without connecting.
 */
export async function connectCrm(p: CrmProvider, signal?: AbortSignal): Promise<CrmStatus | null> {
  const [existing] = await connectionsOf(p);
  const connection = await connectProvider(p, { signal, reconnectId: existing?.state === 'broken' ? existing.id : undefined });
  return connection ? getCrmStatus(p) : null;
}
