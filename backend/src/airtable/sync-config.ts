import type { Prisma } from '@prisma/client';
import { readWriteBack, type WriteBackChoice } from './write-back';

/**
 * How one Airtable table syncs: which way records flow.
 *
 * An edit on either side reaches the other. There is no rule to pick, because
 * there is only one behaviour: a lead changed here is written to Airtable, and
 * a record changed in Airtable is applied to the lead. Offering an owner three
 * ways to settle a collision asked them to answer a question they had not
 * asked, to describe something that almost never happens.
 *
 * Kept as JSON on lead_sources.sync_config rather than as columns, so adding a
 * setting is not a migration — and so no new varchar vocabulary needs a CHECK
 * constraint to keep it honest.
 */

export const DIRECTIONS = ['import', 'export', 'two_way'] as const;
export type SyncDirection = (typeof DIRECTIONS)[number];

export const EXPORT_SCOPES = ['this_table', 'all_leads'] as const;
export type ExportScope = (typeof EXPORT_SCOPES)[number];

export interface AirtableSyncConfig {
  /**
   * import:  Airtable is the source of truth; EstatePulse never writes to it.
   * export:  EstatePulse writes its leads to Airtable; Airtable edits are not read back.
   * two_way: both. An edit on either side reaches the other.
   */
  direction: SyncDirection;
  /**
   * Which leads EstatePulse writes out, for a direction that writes at all.
   *
   * this_table (the default): only the leads this table itself produced, which
   * is what two-way sync means. all_leads publishes the organization's entire
   * lead list into the base, so it is never assumed — an owner chooses it.
   */
  exportScope: ExportScope;
  /**
   * What EstatePulse sends back about a lead it has worked, and the Airtable
   * column each one lands in. Empty by default: nothing is written about a lead
   * that the owner did not ask for.
   *
   * One-way by design. A score or a call outcome is something EstatePulse works
   * out, so these columns are written and never read — see write-back.ts.
   */
  writeBack: WriteBackChoice[];
}

export const DEFAULT_SYNC_CONFIG: AirtableSyncConfig = { direction: 'import', exportScope: 'this_table', writeBack: [] };

export function readSyncConfig(value: Prisma.JsonValue | null | undefined): AirtableSyncConfig {
  const raw = (value ?? {}) as Partial<AirtableSyncConfig>;
  return {
    direction: DIRECTIONS.includes(raw.direction as SyncDirection) ? (raw.direction as SyncDirection) : DEFAULT_SYNC_CONFIG.direction,
    exportScope: EXPORT_SCOPES.includes(raw.exportScope as ExportScope) ? (raw.exportScope as ExportScope) : DEFAULT_SYNC_CONFIG.exportScope,
    writeBack: readWriteBack(raw.writeBack),
  };
}

/** Does this direction read Airtable into EstatePulse? */
export const readsIn = (c: AirtableSyncConfig): boolean => c.direction === 'import' || c.direction === 'two_way';
/** Does this direction write EstatePulse out to Airtable? */
export const writesOut = (c: AirtableSyncConfig): boolean => c.direction === 'export' || c.direction === 'two_way';

/** What each choice means, in the owner's words. The UI shows this rather than inventing its own wording. */
export const DIRECTION_HELP: Record<SyncDirection, string> = {
  import: 'Airtable records create and update EstatePulse leads. EstatePulse never writes to your Airtable table.',
  export: 'EstatePulse leads create and update Airtable records. Edits made in Airtable are not read back.',
  two_way: 'Changes flow both ways. A lead edited in EstatePulse is written to Airtable, and a record edited in Airtable is applied to the lead.',
};

export const SCOPE_HELP: Record<ExportScope, string> = {
  this_table: 'Only leads that came from this Airtable table. Nothing new is added to your base.',
  all_leads:
    'Every lead in EstatePulse, including ones that came from other sources. New records will be created in this Airtable table for all of them.',
};
