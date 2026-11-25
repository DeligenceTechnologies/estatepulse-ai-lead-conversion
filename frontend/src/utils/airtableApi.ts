import { ApiError, apiFetch } from '../lib/api';
import { connectProvider, disconnectConnection } from './connectionsApi';

/**
 * A connected Airtable account — owner only.
 *
 * The browser never holds an Airtable token. It carries the authorization code
 * from Airtable's consent screen to the API, once, and everything after that
 * happens on the server: tokens, imports, webhooks.
 */

/** What the grant actually allows. Record write and schema write are separate permissions. */
export interface AirtablePermissions {
  readRecords: boolean;
  writeRecords: boolean;
  readSchema: boolean;
  /** Creating columns. Never implied by writeRecords. */
  writeSchema: boolean;
  manageWebhooks: boolean;
}

export interface AirtableConnection {
  id: string;
  /** The Airtable user whose account this is. */
  accountId: string | null;
  accountEmail: string | null;
  status: 'active' | 'inactive' | 'invalid' | 'revoked';
  permissions: AirtablePermissions;
  scopes: string[];
  /** Asked for by this server but not granted. */
  missingScopes: string[];
  /** When the grant lapses if unused (Airtable: 60 days). */
  refreshExpiresAt: string | null;
  lastVerifiedAt: string | null;
  lastErrorCode: string | null;
  connectedAt: string;
}

export interface AirtableConfig {
  provider: 'airtable';
  displayName: string;
  /** False when the server has no Airtable client id/secret. */
  configured: boolean;
  requestedScopes: string[];
}

const BASE = '/integrations/airtable';

/** Airtable switched off on this server answers 404 everywhere. */
export const isAirtableDisabled = (e: unknown): boolean => e instanceof ApiError && e.status === 404;

export const getAirtableConfig = (): Promise<AirtableConfig> => apiFetch<AirtableConfig>(`${BASE}/config`, { auth: true });

export const listAirtableConnections = (): Promise<AirtableConnection[]> =>
  apiFetch<{ connections: AirtableConnection[] }>(`${BASE}/connections`, { auth: true }).then((r) => r.connections);

/** Stops using the grant and forgets it. Imported leads are kept. */
export const disconnectAirtable = (id: string): Promise<void> => disconnectConnection(id);

/**
 * Connect Airtable through Nango Connect, then link the connection to this
 * organization. Resolves null when the window was closed without connecting.
 */
export async function connectAirtable(signal?: AbortSignal, reconnectId?: string): Promise<AirtableConnection | null> {
  const connection = await connectProvider('airtable', { signal, reconnectId });
  if (!connection) return null;
  return (await listAirtableConnections()).find((c) => c.id === connection.id) ?? null;
}

// ---------------------------------------------------------------------------
// Bases, tables and the sources built from them
// ---------------------------------------------------------------------------

export interface AirtableBaseSummary {
  id: string;
  name: string;
  /** none | read | comment | edit | create — what the grant may do in this base. */
  permissionLevel: string | null;
}

export interface AirtableFieldSummary {
  id: string;
  name: string;
  /** Airtable's own type string, e.g. "singleLineText". */
  type: string;
  /** Airtable computes it: readable, never writable. */
  readOnly: boolean;
  /** The shape it holds: text, number, date, boolean, list. Absent on older responses. */
  kind?: string;
  choices: string[] | null;
  /** Which lead fields this one may fill. Absent on the table listing. */
  allowedTargets?: string[];
}

export interface AirtableTableSummary {
  id: string;
  name: string;
  fieldCount: number;
  fields: AirtableFieldSummary[];
}

export interface AirtableSource {
  id: string;
  name: string;
  baseId: string;
  tableId: string;
  connectionId: string | null;
  status: string | null;
  mappingStatus: string | null;
  lastImportedAt: string | null;
  lastFailureAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  pendingReview: number;
  importedLeads: number;
  /** Which way this table syncs. Shown on the row so the mode is never hidden behind a click. */
  direction: SyncDirection;
  createdAt: string;
}

/** One Airtable field mapped to one lead field. `fieldKey` is the Airtable FIELD ID. */
export interface AirtableColumn {
  fieldKey: string;
  target: string;
}

export interface AirtablePreview {
  source: AirtableSource;
  table: { baseId: string; tableId: string; name: string | null };
  fields: AirtableFieldSummary[];
  mapping: AirtableColumn[];
  problems: { path: string; message: string }[];
  records: {
    recordId: string;
    issue: string | null;
    lead: Record<string, unknown> | null;
    reviewReasons: string[];
  }[];
}

/**
 * Airtable's own permission levels, in words an owner reads rather than the API
 * string. Printed raw, "create" sits next to a base name looking like a button
 * rather than like the access EstatePulse was given.
 *
 * It is worth showing: a base this connection can only read will never accept a
 * record written back to it, and that is better known before a table is picked
 * than after a write fails.
 */
export const BASE_ACCESS: Record<string, string> = {
  none: 'No access',
  read: 'Read only',
  comment: 'Read only',
  edit: 'Can edit records',
  create: 'Full access',
};

export const listAirtableBases = (connectionId: string): Promise<AirtableBaseSummary[]> =>
  apiFetch<{ bases: AirtableBaseSummary[] }>(`${BASE}/connections/${connectionId}/bases`, { auth: true }).then((r) => r.bases);

export const listAirtableTables = (connectionId: string, baseId: string): Promise<AirtableTableSummary[]> =>
  apiFetch<{ tables: AirtableTableSummary[] }>(`${BASE}/connections/${connectionId}/bases/${baseId}/tables`, { auth: true }).then((r) => r.tables);

export const listAirtableSources = (): Promise<AirtableSource[]> =>
  apiFetch<{ sources: AirtableSource[] }>(`${BASE}/sources`, { auth: true }).then((r) => r.sources);

export const createAirtableSource = (body: { connectionId: string; baseId: string; tableId: string }): Promise<AirtableSource> =>
  apiFetch<AirtableSource>(`${BASE}/sources`, { method: 'POST', auth: true, body });

export const previewAirtableSource = (sourceId: string): Promise<AirtablePreview> =>
  apiFetch<AirtablePreview>(`${BASE}/sources/${sourceId}/preview`, { auth: true });

export const saveAirtableMapping = (sourceId: string, columns: AirtableColumn[]): Promise<AirtableSource> =>
  apiFetch<AirtableSource>(`${BASE}/sources/${sourceId}/mapping`, { method: 'PUT', auth: true, body: { columns } });

export interface AirtableImportResult {
  source: AirtableSource;
  read: number;
  imported: number;
  updated: number;
  unchanged: number;
  skipped: number;
  /** The table held more than one import brings in; the worker is fetching the rest. */
  moreComing: boolean;
  approval: { approved: number; released: number; held: { rowId: string; leadId: string; reason: string }[] };
}

/** Ticked records are approved; everything else waits in Import Review. */
export const importAirtableSource = (sourceId: string, approveRecordIds: string[]): Promise<AirtableImportResult> =>
  apiFetch<AirtableImportResult>(`${BASE}/sources/${sourceId}/import`, { method: 'POST', auth: true, body: { approveRecordIds } });

export const removeAirtableSource = (sourceId: string): Promise<{ removed: true; pendingReview: number }> =>
  apiFetch<{ removed: true; pendingReview: number }>(`${BASE}/sources/${sourceId}`, { method: 'DELETE', auth: true });

// ---------------------------------------------------------------------------
// Sync: direction, conflicts, status
// ---------------------------------------------------------------------------

export type SyncDirection = 'import' | 'export' | 'two_way';
/** Which leads get written out, for a direction that writes at all. */
export type ExportScope = 'this_table' | 'all_leads';

/**
 * Something EstatePulse can report back about a lead it has worked. The
 * catalogue is the server's; which of them travel, and into which column, is
 * the owner's choice.
 */
export interface AirtableWriteBackField {
  key: string;
  label: string;
  help: string;
  /** The column EstatePulse would create for it, if asked. */
  type: string;
  /** The shape this writes, matched against a column's own shape. */
  kind?: string;
  choices?: string[];
  group: string;
}

/** One chosen report and the Airtable column it lands in. */
export interface AirtableWriteBack {
  key: string;
  fieldId: string;
}

export const listAirtableWriteBackFields = (): Promise<AirtableWriteBackField[]> =>
  apiFetch<{ fields: AirtableWriteBackField[] }>(`${BASE}/write-back-fields`, { auth: true }).then((r) => r.fields);

/** This table's columns alone — no records read. */
export const listAirtableTableFields = (sourceId: string): Promise<AirtableFieldSummary[]> =>
  apiFetch<{ fields: AirtableFieldSummary[] }>(`${BASE}/sources/${sourceId}/fields`, { auth: true }).then((r) => r.fields);

export interface AirtableSyncStatus {
  source: AirtableSource;
  direction: SyncDirection;
  exportScope: ExportScope;
  writeBack: AirtableWriteBack[];
  permissions: AirtablePermissions | null;
  /** Watching for changes, rather than re-reading the whole table. */
  watching: boolean;
  remoteState: string | null;
  syncing: boolean;
  lastSuccessfulSyncAt: string | null;
  lastFailureAt: string | null;
  lastWebhookAt: string | null;
  nextSyncAt: string | null;
  consecutiveFailures: number;
  lastError: { code: string; message: string | null } | null;
  counts: { importedLeads: number; pendingReview: number; changesToReview: number; exported: number; failed: number };
  failures: { rowId: string; code: string | null; message: string | null; attempts: number; nextAttemptAt: string | null }[];
}

export const getAirtableStatus = (sourceId: string): Promise<AirtableSyncStatus> =>
  apiFetch<AirtableSyncStatus>(`${BASE}/sources/${sourceId}/status`, { auth: true });

export const setAirtableSync = (
  sourceId: string,
  direction: SyncDirection,
  exportScope: ExportScope,
  /** Left out keeps whatever was chosen before. */
  writeBack?: AirtableWriteBack[],
): Promise<AirtableSource> =>
  apiFetch<AirtableSource>(`${BASE}/sources/${sourceId}/sync-config`, {
    method: 'PUT',
    auth: true,
    body: { direction, exportScope, ...(writeBack ? { writeBack } : {}) },
  });

export const syncAirtableNow = (sourceId: string): Promise<{ queued: true }> =>
  apiFetch<{ queued: true }>(`${BASE}/sources/${sourceId}/sync`, { method: 'POST', auth: true });

export const retryAirtableFailed = (sourceId: string): Promise<{ retrying: number }> =>
  apiFetch<{ retrying: number }>(`${BASE}/sources/${sourceId}/retry`, { method: 'POST', auth: true });

/**
 * What each direction and policy means. The server is the authority; this is
 * the same wording.
 *
 * `short` is the badge on a table row, where the arrow form is too wide to sit
 * beside a table name without pushing it out. It says the same thing.
 */
export const DIRECTION_LABELS: Record<SyncDirection, { label: string; short: string; help: string }> = {
  import: {
    label: 'Airtable → EstatePulse',
    short: 'Import only',
    help: 'Airtable records create and update EstatePulse leads. EstatePulse never writes to your Airtable table.',
  },
  export: {
    label: 'EstatePulse → Airtable',
    short: 'Send only',
    help: 'EstatePulse leads create and update Airtable records. Edits made in Airtable are not read back.',
  },
  two_way: {
    label: 'Both ways',
    short: 'Both ways',
    help: 'Changes flow both ways. A lead edited in EstatePulse is written to Airtable, and a record edited in Airtable is applied to the lead.',
  },
};

/** What goes out, when anything goes out. The server is the authority; this is the same wording. */
export const SCOPE_LABELS: Record<ExportScope, { label: string; help: string }> = {
  this_table: {
    label: 'Only leads from this table',
    help: 'Leads that came from this Airtable table are kept up to date. Nothing new is added to your base.',
  },
  all_leads: {
    label: 'All EstatePulse leads',
    help: 'Every lead in EstatePulse, including ones that came from other sources, gets a record created in this Airtable table.',
  },
};

// ---------------------------------------------------------------------------
// Creating an Airtable column
// ---------------------------------------------------------------------------

export interface NewAirtableField {
  name: string;
  type: string;
  currencySymbol?: string;
  choices?: string[];
  /** Start sending this report into the new column, in the same request. */
  sendAs?: string;
}

export const airtableFieldTypes = (): Promise<{ type: string; label: string }[]> =>
  apiFetch<{ types: { type: string; label: string }[] }>(`${BASE}/field-types`, { auth: true }).then((r) => r.types);

/**
 * Adds a column to the Airtable table. Needs the schema permission, which
 * record write does not imply — without it this fails with
 * AIRTABLE_SCHEMA_WRITE_NOT_GRANTED and record sync is unaffected.
 */
export const createAirtableField = (
  sourceId: string,
  body: NewAirtableField,
): Promise<{ field: AirtableFieldSummary; fields: AirtableFieldSummary[]; writeBack: AirtableWriteBack[] }> =>
  apiFetch<{ field: AirtableFieldSummary; fields: AirtableFieldSummary[]; writeBack: AirtableWriteBack[] }>(
    `${BASE}/sources/${sourceId}/fields`,
    { method: 'POST', auth: true, body },
  );

export const isSchemaPermissionError = (e: unknown): boolean =>
  // ErrorCode is a closed union of the shared codes; Airtable's own are compared as text.
  e instanceof ApiError && (e.status === 403 || String(e.code) === 'AIRTABLE_SCHEMA_WRITE_NOT_GRANTED');

/**
 * Why a record cannot become a lead, in the owner's words.
 *
 * These records are not imported at all: a row with no name, or nobody to
 * reach, is not a lead, and making one would put something nobody can act on
 * into the lead table. Saying so beats letting them vanish into a count.
 */
export const RECORD_ISSUE_TEXT: Record<string, string> = {
  NO_NAME: 'No name',
  NO_CONTACT: 'No phone number and no email',
  PHONE_NO_COUNTRY_CODE: 'The phone number has no country code, so we cannot tell which country it belongs to',
  NO_ROW_ID: 'Airtable did not give this record an id',
  DUPLICATE_IN_SHEET: 'The same record appears twice in this table',
  DUPLICATE_IN_FILE: 'The same record appears twice in this table',
};

/** The lead fields an Airtable field can be mapped to, as the picker lists them. */
export const TARGET_LABELS: Record<string, string> = {
  full_name: 'Full name',
  first_name: 'First name',
  last_name: 'Last name',
  email: 'Email',
  phone: 'Phone',
  timezone: 'Time zone',
  location: 'Location',
  min_budget: 'Minimum budget',
  max_budget: 'Maximum budget',
  bedrooms: 'Bedrooms',
  motivation: 'Motivation',
  __custom__: 'Keep as a custom field',
};

/** The permissions a card lists, in the order it lists them. */
export const PERMISSION_LABELS: { key: keyof AirtablePermissions; label: string; why: string }[] = [
  { key: 'readSchema', label: 'Read bases & fields', why: 'List your bases, tables and field types.' },
  { key: 'readRecords', label: 'Read records', why: 'Import Airtable records as leads.' },
  { key: 'writeRecords', label: 'Write records', why: 'Create and update Airtable records from EstatePulse.' },
  { key: 'writeSchema', label: 'Create fields', why: 'Add new columns to an Airtable table.' },
  { key: 'manageWebhooks', label: 'Watch for changes', why: 'Pick up Airtable edits as they happen instead of re-reading the table.' },
];
