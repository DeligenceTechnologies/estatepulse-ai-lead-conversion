import { ApiError, apiFetch } from '../lib/api';

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    google?: any;
    gapi?: any;
  }
}

/**
 * Google Sheets import — connecting the Google account (owner only).
 *
 * Two different Google tokens exist here, and only one of them is ours:
 *  - The server's refresh token, from the consent popup. The browser never
 *    sees it; it carries the authorization code to the API and nothing else.
 *  - A short-lived token the BROWSER gets from Google Identity Services just to
 *    show the Google Picker. It stays in this tab's memory and is never sent to
 *    EstatePulse. Picking a file is what grants this app (drive.file) access to
 *    it, which the server then proves by reading it.
 */

export interface GoogleSheetsConfig {
  configured: boolean;
  clientId: string | null;
  apiKey: string | null;
  appId: string | null;
  scope: string;
}

export interface GoogleConnection {
  id: string;
  accountEmail: string | null;
  /** ACTIVE | INVALID (needs reconnect) */
  status: string;
  lastVerifiedAt: string | null;
  lastErrorCode: string | null;
  connectedAt: string;
}

export interface SpreadsheetInspection {
  spreadsheetId: string;
  title: string;
  version: string | null;
  modifiedTime: string | null;
  tabs: { sheetId: number; title: string; index: number; rowCount: number | null; columnCount: number | null }[];
  sample: { sheetId: number; title: string; rows: string[][] } | null;
}

const BASE = '/integrations/google-sheets';
const SOURCE = 'estatepulse:google-oauth';
const CHANNEL = 'estatepulse:google-oauth';
/** A consent screen left open longer than the server's state lifetime is dead anyway. */
const CALLBACK_TIMEOUT_MS = 10 * 60 * 1000;

export const getGoogleSheetsConfig = (): Promise<GoogleSheetsConfig> =>
  apiFetch<GoogleSheetsConfig>(`${BASE}/config`, { auth: true });

/** These routes exist only where the server has GOOGLE_SHEETS_ENABLED=1; elsewhere every one answers 404. */
export const isSheetsDisabled = (e: unknown): boolean => e instanceof ApiError && e.status === 404;

export const googleSheetsEnabled = (): Promise<boolean> =>
  getGoogleSheetsConfig().then(
    () => true,
    (e) => !isSheetsDisabled(e),
  );

export const listGoogleConnections = (): Promise<GoogleConnection[]> =>
  apiFetch<{ connections: GoogleConnection[] }>(`${BASE}/connections`, { auth: true }).then((r) => r.connections);

export const disconnectGoogle = (id: string): Promise<void> =>
  apiFetch<void>(`${BASE}/connections/${id}`, { method: 'DELETE', auth: true });

export const inspectSpreadsheet = (connectionId: string, spreadsheetId: string): Promise<SpreadsheetInspection> =>
  apiFetch<SpreadsheetInspection>(
    `${BASE}/connections/${connectionId}/spreadsheets/${encodeURIComponent(spreadsheetId)}`,
    { auth: true },
  );

// --- sources: one connected spreadsheet tab each --------------------------------

export type MappingTarget =
  | 'first_name'
  | 'last_name'
  | 'full_name'
  | 'phone'
  | 'email'
  | 'location'
  | 'min_budget'
  | 'max_budget'
  | 'bedrooms'
  | 'motivation'
  | '__custom__';

export interface ColumnMapping {
  fieldKey: string;
  target: MappingTarget;
}

export type Identity = { mode: 'column'; fieldKey: string } | { mode: 'fallback' };

export interface SheetSource {
  id: string;
  name: string;
  spreadsheetId: string;
  sheetId: number;
  connectionId: string | null;
  /** NEEDS_MAPPING | PAUSED | ACTIVE */
  status: string | null;
  mappingStatus: string | null;
  identity: Identity | null;
  /** A sync is due now: requested, scheduled, or a retry. */
  syncQueued: boolean;
  nextSyncAt: string | null;
  syncing: boolean;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  pendingReview: number;
  createdAt: string;
}

export interface PreviewLead {
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  normalized_phone: string | null;
  email: string | null;
  email_valid: boolean;
  location: string | null;
  min_budget: number | null;
  max_budget: number | null;
  bedrooms: number | null;
}

export interface SheetPreview {
  source: SheetSource;
  tab: { title: string; rowCount: number | null; columnCount: number | null };
  headers: { fieldKey: string; label: string; column: string; duplicate: boolean; samples: string[] }[];
  mapping: { saved: boolean; columns: ColumnMapping[]; identity: Identity };
  identityCandidates: string[];
  problems: { path: string; message: string }[];
  /** Every non-blank row, with the flags the import would give it (a warning, a possible duplicate, an opt-out). */
  rows: { rowNumber: number; issue: string | null; lead: PreviewLead | null; reviewReasons: string[] }[];
}

export interface RunSummary {
  rowsRead?: number;
  blank?: number;
  inserted?: number;
  updated?: number;
  unchanged?: number;
  flagged?: number;
  flagsCleared?: number;
  rebaselined?: number;
  missingMarked?: number;
  reappeared?: number;
  skipped?: Record<string, number>;
  dncInherited?: number;
  possibleDuplicates?: number;
  durationMs?: number;
  errorSample?: { row: number; code: string }[];
  /** Failed runs only. */
  code?: string;
  permanent?: boolean;
  retryAt?: string | null;
}

export interface SheetRun {
  ok: boolean;
  at: string;
  durationMs: number | null;
  summary: RunSummary;
}

export const listSheetSources = (): Promise<SheetSource[]> =>
  apiFetch<{ sources: SheetSource[] }>(`${BASE}/sources`, { auth: true }).then((r) => r.sources);

export const createSheetSource = (body: { connectionId: string; spreadsheetId: string; sheetId: number }): Promise<SheetSource> =>
  apiFetch<SheetSource>(`${BASE}/sources`, { method: 'POST', auth: true, body });

export const previewSheetSource = (id: string): Promise<SheetPreview> =>
  apiFetch<SheetPreview>(`${BASE}/sources/${id}/preview`, { auth: true });

export const saveSheetMapping = (
  id: string,
  body: { columns: ColumnMapping[]; identity: { mode: 'column'; fieldKey: string } | { mode: 'fallback'; acknowledged: true } },
): Promise<SheetSource> => apiFetch<SheetSource>(`${BASE}/sources/${id}/mapping`, { method: 'PUT', auth: true, body });

/** What "Start importing" did there and then: the first run, with the ticked rows approved as they landed. */
export interface FirstRun {
  /** False: the run failed, and the source's lastErrorMessage says why. */
  ok: boolean;
  imported: number;
  approval: ApproveResult;
}

/** Switch the sheet on and run its first import now; `approveRows` (sheet row numbers) are approved as they land. */
export const enableSheetSource = (id: string, approveRows: number[]): Promise<SheetSource & { firstRun: FirstRun | null }> =>
  apiFetch<SheetSource & { firstRun: FirstRun | null }>(`${BASE}/sources/${id}/enable`, { method: 'POST', auth: true, body: { approveRows } });

export const pauseSheetSource = (id: string): Promise<SheetSource> =>
  apiFetch<SheetSource>(`${BASE}/sources/${id}/pause`, { method: 'POST', auth: true });

/** Archives the sheet: it stops syncing; its leads stay (pending ones in Import Review). */
export const removeSheetSource = (id: string): Promise<{ removed: true; pendingReview: number }> =>
  apiFetch<{ removed: true; pendingReview: number }>(`${BASE}/sources/${id}`, { method: 'DELETE', auth: true });

export const syncSheetSource = (id: string): Promise<{ queued: true }> =>
  apiFetch<{ queued: true }>(`${BASE}/sources/${id}/sync`, { method: 'POST', auth: true });

export const sheetRuns = (id: string): Promise<SheetRun[]> =>
  apiFetch<{ runs: SheetRun[] }>(`${BASE}/sources/${id}/runs`, { auth: true }).then((r) => r.runs);

// --- review ---------------------------------------------------------------------------

export type ImportKind = 'google_sheets' | 'file_upload';

export interface ReviewItem {
  rowId: string;
  rowNumber: number;
  importedAt: string;
  /** Set once decided; shown on the Rejected tab. */
  reviewedAt: string | null;
  missing: boolean;
  /** The sheet tab or the uploaded file the row came from. */
  source: { id: string; name: string; kind: ImportKind } | null;
  lead: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
    email: string | null;
    location: string | null;
    minBudget: number | null;
    maxBudget: number | null;
    dncStatus: boolean;
    reviewReasons: string[];
  } | null;
}

export interface ReviewPage {
  items: ReviewItem[];
  nextCursor: string | null;
  /** First page only. */
  total?: number;
}

export interface ApproveResult {
  approved: number;
  released: number;
  held: { rowId: string; leadId: string; reason: string }[];
  skipped: string[];
}

export interface RejectResult {
  rejected: number;
  skipped: string[];
}

export interface ChangeItem {
  rowId: string;
  rowNumber: number;
  reviewState: string;
  changedAt: string;
  lead: { id: string; firstName: string | null; lastName: string | null } | null;
  incomingDoNotContact: boolean;
  diff: { field: string; current: unknown; incoming: unknown }[];
}

export const reviewQueue = (q: {
  state?: 'pending' | 'rejected';
  /** Sheets only, uploaded files only, or (default) both. */
  source?: 'all' | ImportKind;
  sourceId?: string;
  cursor?: string | null;
  limit?: number;
}): Promise<ReviewPage> => {
  const p = new URLSearchParams({ limit: String(q.limit ?? 50), state: q.state ?? 'pending' });
  if (q.source && q.source !== 'all') p.set('source', q.source);
  if (q.sourceId) p.set('sourceId', q.sourceId);
  if (q.cursor) p.set('cursor', q.cursor);
  return apiFetch<ReviewPage>(`${BASE}/review?${p.toString()}`, { auth: true });
};

export const approveRows = (rowIds: string[]): Promise<ApproveResult> =>
  apiFetch<ApproveResult>(`${BASE}/review/approve`, { method: 'POST', auth: true, body: { rowIds } });

export const rejectRows = (rowIds: string[]): Promise<RejectResult> =>
  apiFetch<RejectResult>(`${BASE}/review/reject`, { method: 'POST', auth: true, body: { rowIds } });

export const sheetChanges = (sourceId: string): Promise<ChangeItem[]> =>
  apiFetch<{ items: ChangeItem[] }>(`${BASE}/review/changes?sourceId=${sourceId}`, { auth: true }).then((r) => r.items);

export const resolveChanges = (rowIds: string[], action: 'apply' | 'keep'): Promise<{ resolved: number; skipped: string[] }> =>
  apiFetch<{ resolved: number; skipped: string[] }>(`${BASE}/review/changes/resolve`, {
    method: 'POST',
    auth: true,
    body: { rowIds, action },
  });

/**
 * Run Google's consent screen and finish the connection on THIS session.
 *
 * Call it straight from a click: the window is opened before the first await,
 * which is what keeps popup blockers out of the way.
 */
export async function connectGoogle(signal?: AbortSignal): Promise<GoogleConnection> {
  const popup = window.open('', 'estatepulse-google-oauth', 'width=520,height=720');
  if (!popup) throw new Error('Your browser blocked the Google window. Allow pop-ups for this site and try again.');

  let start: { authorizeUrl: string; state: string };
  try {
    start = await apiFetch<{ authorizeUrl: string; state: string }>(`${BASE}/oauth/start`, { method: 'POST', auth: true });
  } catch (e) {
    popup.close();
    throw e;
  }
  popup.location.href = start.authorizeUrl;

  const result = await waitForCallback(start.state, signal);
  if (result.error) {
    throw new Error(result.error === 'access_denied' ? 'Google access was not granted.' : `Google returned an error: ${result.error}`);
  }
  if (!result.code) throw new Error('Google did not return an authorization code. Try again.');

  return apiFetch<GoogleConnection>(`${BASE}/oauth/complete`, {
    method: 'POST',
    auth: true,
    body: { code: result.code, state: result.state },
  });
}

function waitForCallback(
  state: string,
  signal?: AbortSignal,
): Promise<{ code: string | null; state: string; error: string | null }> {
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

    // ponytail: no popup.closed polling. Google's pages can sever the opener,
    // after which `closed` reads true while the owner is still consenting. The
    // caller's Cancel and this timeout end an abandoned attempt instead.
    const timer = setTimeout(
      () => finish(() => reject(new Error('Timed out waiting for Google. Try again.'))),
      CALLBACK_TIMEOUT_MS,
    );
    signal?.addEventListener('abort', () => finish(() => reject(new DOMException('Cancelled', 'AbortError'))));
  });
}

// --- the Google Picker ---------------------------------------------------------

const scripts = new Map<string, Promise<void>>();

function loadScript(src: string): Promise<void> {
  let p = scripts.get(src);
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.async = true;
      el.onload = () => resolve();
      el.onerror = () => {
        scripts.delete(src);
        reject(new Error('Could not load Google’s picker. Check your connection or content blocker.'));
      };
      document.head.appendChild(el);
    });
    scripts.set(src, p);
  }
  return p;
}

/** Load ahead of the click, so the click itself can open Google's window. */
export async function loadPickerLibraries(): Promise<void> {
  await Promise.all([loadScript('https://accounts.google.com/gsi/client'), loadScript('https://apis.google.com/js/api.js')]);
  if (window.google?.picker) return;
  await new Promise<void>((resolve, reject) => window.gapi.load('picker', { callback: resolve, onerror: reject }));
}

export const pickerReady = (): boolean => Boolean(window.google?.accounts?.oauth2 && window.google?.picker);

/**
 * Let the owner choose one spreadsheet in Google's own UI. Resolves its file id,
 * or null if they cancel. `accountEmail` steers Google to the connected account:
 * a file picked as a different account grants the server nothing.
 */
export function pickSpreadsheet(cfg: GoogleSheetsConfig, accountEmail: string | null): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const g = window.google;
    const tokenClient = g.accounts.oauth2.initTokenClient({
      client_id: cfg.clientId,
      scope: cfg.scope,
      login_hint: accountEmail ?? undefined,
      prompt: '',
      callback: (resp: { access_token?: string; error?: string }) => {
        if (resp.error || !resp.access_token) {
          reject(new Error('Google did not grant access for the picker.'));
          return;
        }
        const view = new g.picker.DocsView(g.picker.ViewId.SPREADSHEETS)
          .setMode(g.picker.DocsViewMode.LIST)
          .setIncludeFolders(false);
        new g.picker.PickerBuilder()
          // The project number: what lets drive.file grant THIS app the file.
          .setAppId(cfg.appId)
          .setOAuthToken(resp.access_token)
          .setDeveloperKey(cfg.apiKey)
          .addView(view)
          .setCallback((data: { action: string; docs?: { id: string }[] }) => {
            if (data.action === g.picker.Action.PICKED) resolve(data.docs?.[0]?.id ?? null);
            else if (data.action === g.picker.Action.CANCEL) resolve(null);
          })
          .build()
          .setVisible(true);
      },
      error_callback: (err: { type?: string }) =>
        reject(new Error(err?.type === 'popup_closed' ? 'The Google window was closed.' : 'Google sign-in for the picker failed.')),
    });
    tokenClient.requestAccessToken();
  });
}
