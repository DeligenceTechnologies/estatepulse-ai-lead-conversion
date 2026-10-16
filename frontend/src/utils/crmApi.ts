import { ApiError, apiFetch } from '../lib/api';

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
const SOURCE = 'estatepulse:crm-oauth';
const CHANNEL = 'estatepulse:crm-oauth';
/** The server's state lives ten minutes; a consent screen left open longer is dead anyway. */
const CALLBACK_TIMEOUT_MS = 10 * 60 * 1000;

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
export const disconnectCrm = (p: CrmProvider): Promise<void> => apiFetch<void>(`${base(p)}/connection`, { method: 'DELETE', auth: true });

/**
 * Run the CRM's consent screen and finish the connection on THIS session.
 *
 * Call it straight from a click: the window is opened before the first await,
 * which keeps popup blockers out of the way.
 */
export async function connectCrm(p: CrmProvider, displayName: string, signal?: AbortSignal): Promise<CrmStatus> {
  const popup = window.open('', 'estatepulse-crm-oauth', 'width=560,height=760');
  if (!popup) throw new Error(`Your browser blocked the ${displayName} window. Allow pop-ups for this site and try again.`);

  let start: { authorizeUrl: string; state: string };
  try {
    start = await apiFetch<{ authorizeUrl: string; state: string }>(`${base(p)}/oauth/start`, { method: 'POST', auth: true });
  } catch (e) {
    popup.close();
    throw e;
  }
  popup.location.href = start.authorizeUrl;

  const result = await waitForCallback(start.state, signal);
  if (result.error) {
    throw new Error(result.error === 'access_denied' ? `${displayName} access was not granted.` : `${displayName} returned an error: ${result.error}`);
  }
  if (!result.code) throw new Error(`${displayName} did not return an authorization code. Try again.`);

  return apiFetch<CrmStatus>(`${base(p)}/oauth/complete`, { method: 'POST', auth: true, body: { code: result.code, state: result.state } });
}

function waitForCallback(state: string, signal?: AbortSignal): Promise<{ code: string | null; state: string; error: string | null }> {
  return new Promise((resolve, reject) => {
    const channel = 'BroadcastChannel' in window ? new BroadcastChannel(CHANNEL) : null;
    let settled = false;

    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      channel?.close();
      clearTimeout(timer);
      settle();
    };

    const accept = (data: unknown) => {
      const d = data as { source?: string; code?: string | null; state?: string | null; error?: string | null } | null;
      // Only the authorization this tab started. Another tab's flow, or one an
      // attacker began, carries a different state and is ignored.
      if (d?.source !== SOURCE || d.state !== state) return;
      finish(() => resolve({ code: d.code ?? null, state, error: d.error ?? null }));
    };
    const onMessage = (e: MessageEvent) => {
      if (e.origin === window.location.origin) accept(e.data);
    };

    window.addEventListener('message', onMessage);
    if (channel) channel.onmessage = (e) => accept(e.data);

    const timer = setTimeout(() => finish(() => reject(new Error('Timed out waiting for the connection. Try again.'))), CALLBACK_TIMEOUT_MS);
    signal?.addEventListener('abort', () => finish(() => reject(new DOMException('Cancelled', 'AbortError'))));
  });
}
