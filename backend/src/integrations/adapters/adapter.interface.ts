import type { LeadSourceProvider } from '@prisma/client';
import type { SyncField, SyncValues } from '../sync/two-way';
import type { ProviderClient } from './provider-client';

/**
 * What EstatePulse can do with a provider once it is connected. Providers
 * differ (a CRM has contacts and deals, a file store has files), so an adapter
 * lists the capabilities it really implements instead of stubbing a fixed
 * interface. The marketplace shows these; the sync runs only `lead_import`.
 */
export type IntegrationCapability =
  /** Reads records and imports them as leads (the sync). */
  | 'lead_import'
  /** CRM objects read by the import. */
  | 'contacts'
  | 'companies'
  | 'deals'
  /** Tabular data: bases/sheets and their rows. */
  | 'tables'
  /** Reads availability for the calendar module. */
  | 'calendar'
  /** Books meetings, including the AI assistant on a live call. */
  | 'booking';

/** A connection as an adapter sees it. Never holds a credential: calls go through `client`. */
export interface AdapterContext {
  connectionId: string;
  orgId: string;
  settings: Record<string, unknown>;
  client: ProviderClient;
  /** The signed-in user acting, when a person (not a webhook or the worker) caused the call. */
  actorId: string | null;
}

/** Who the connected account is, for the connection card. Display-only, never a secret. */
export interface AccountIdentity {
  accountName: string | null;
  accountEmail: string | null;
  externalAccountId: string | null;
  /** Small, safe facts worth showing (portal id, granted scopes...). */
  metadata?: Record<string, string | number | boolean | string[] | null>;
}

/** One person read from the provider, already mapped onto lead fields. */
export interface ImportedRecord {
  /** Stable per adapter, e.g. "airtable:tblXXXX" or "hubspot:contact". */
  objectType: string;
  externalId: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  location?: string | null;
  timeline?: string | null;
  motivation?: string | null;
  minBudget?: number | null;
  maxBudget?: number | null;
  bedrooms?: number | null;
  /** Everything else worth keeping on the lead, verbatim. */
  customFields?: Record<string, string>;
  /** Provider facts a later write-back needs (never shown, never a secret), e.g. `{ phoneProperty: 'mobilephone' }`. */
  meta?: Record<string, string>;
}

/** What one sync page hands back; `next` = null means the last page. */
export interface ImportPage<Cursor> {
  records: ImportedRecord[];
  next: Cursor | null;
}

/** A selectable thing an adapter's setup needs (an Airtable base, a table...). */
export interface SetupResource {
  id: string;
  name: string;
  /** Extra facts the setup screen shows, e.g. a table's fields. */
  detail?: Record<string, unknown>;
}

/** Where a connection stands with its provider-specific setup. */
export interface SetupState {
  complete: boolean;
  /** What the owner still has to do, in a sentence. Null when complete. */
  missing: string | null;
  /** Human summary of the current choice ("Leads · Buyers"), safe to show. */
  summary: string | null;
}

/**
 * Provider-specific setup after connecting (pick a base and table, map fields).
 * Optional: a provider that imports everything (HubSpot contacts) has none.
 */
export interface AdapterSetup {
  /** Kinds the setup screen can list, e.g. ['bases', 'tables']. */
  readonly resourceKinds: readonly string[];
  state(settings: Record<string, unknown>): SetupState;
  listResources(ctx: AdapterContext, kind: string, parentId: string | null): Promise<SetupResource[]>;
  /** Validates the owner's input against the provider and returns the settings to store. */
  saveSettings(ctx: AdapterContext, input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** Reads the provider page by page. The engine owns idempotency, leads and bookkeeping. */
export interface AdapterImport<Cursor = unknown> {
  /** A label for leads imported this way ("Airtable · Buyers"). */
  sourceName(settings: Record<string, unknown>): string;
  fetchPage(ctx: AdapterContext, cursor: Cursor | null): Promise<ImportPage<Cursor>>;
}

/**
 * One provider EstatePulse has built business functionality for. Adding a
 * provider = one class implementing this, registered in IntegrationsModule.
 * Nothing in the marketplace, connection or sync code changes.
 */
export interface IntegrationAdapter {
  /** Nango's provider name in its catalog (`ApiProvider.name`), e.g. "airtable". */
  readonly provider: string;
  readonly displayName: string;
  /** One or two sentences for the card and the details screen. */
  readonly description: string;
  /** Bullet points for the details screen: what it does in EstatePulse. */
  readonly features: readonly string[];
  readonly capabilities: readonly IntegrationCapability[];
  /** Shown only when Nango's catalog cannot be read; the catalog's own categories win otherwise. */
  readonly fallbackCategories: readonly string[];
  /** OAuth scopes the Nango integration must request for this adapter to work. Documentation and readiness hints. */
  readonly requiredScopes: readonly string[];
  /** Lead source provider for attribution of imported leads. */
  readonly leadSourceProvider: LeadSourceProvider | null;

  /** Reads who the connected account is. Called once on connect and on reconnect. */
  identify(ctx: AdapterContext): Promise<AccountIdentity>;
  /** A cheap authenticated call: true when the grant still works. */
  validateConnection(ctx: AdapterContext): Promise<boolean>;

  readonly setup?: AdapterSetup;
  readonly import?: AdapterImport;
  readonly lifecycle?: AdapterLifecycle;
  /** Two-way sync: writes lead changes back to the record the lead came from. */
  readonly writeBack?: AdapterWriteBack;
}

/** Which provider record a lead came from. */
export interface WriteTarget {
  objectType: string;
  externalId: string;
  meta: Record<string, string>;
}

/**
 * Two-way sync for an importing adapter. The engine decides WHAT changed
 * (per-field bases on both sides, see sync/two-way.ts); the adapter only
 * knows which fields it exchanges and how to write them.
 */
export interface AdapterWriteBack {
  /** Scopes the grant needs to write (shown when a write is refused). */
  readonly writeScopes: readonly string[];
  /** Lead fields this connection exchanges, given its settings. The import also merges these per field. */
  fields(settings: Record<string, unknown>): readonly SyncField[];
  /** Which of `fields` the provider accepts writes to right now (an Airtable formula column does not). */
  writableFields(ctx: AdapterContext): Promise<readonly SyncField[]>;
  /**
   * Writes `changes` to the record. `current` is the lead's value of every
   * synced field, for providers that store several lead fields in one column
   * (a full-name column). Throws NangoError on a provider refusal.
   */
  push(ctx: AdapterContext, target: WriteTarget, changes: SyncValues, current: SyncValues): Promise<void>;
}

/**
 * For an adapter that hands its connection to another part of EstatePulse
 * (Cal.com feeds the calendar module). Every hook is best effort: a failure is
 * logged and never undoes the connection change that triggered it.
 */
export interface AdapterLifecycle {
  /** Before Nango deletes the connection, while its credentials still work. */
  beforeDisconnect?(ctx: AdapterContext): Promise<void>;
  /** After the account was disconnected in EstatePulse. */
  disconnected?(ctx: AdapterContext): Promise<void>;
  /** The grant stopped working (revoked, expired, removed from Nango). */
  accessLost?(ctx: AdapterContext, reason: string): Promise<void>;
  /** Linked again or reconnected: the grant works (possibly with new credentials). */
  accessRestored?(ctx: AdapterContext): Promise<void>;
}
