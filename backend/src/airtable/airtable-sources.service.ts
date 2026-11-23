import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConnectionMethod,
  ConsentStatus,
  FieldStatus,
  IngestStatus,
  IntegrationProvider,
  IntegrationStatus,
  LeadSourceProvider,
  MappingStatus,
  Prisma,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AuditService } from '@/audit/audit.service';
import { AppError, httpError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import type { IntegrationEnv } from '@/common/utils/interface';
import { outreachRequest } from '@/outreach/batches';
import { summaryOf } from '@/outreach/schedule';
import { RunStats, SheetImportService, contactFlags } from '@/google-sheets/sheet-import.service';
import {
  CUSTOM_TARGET,
  FULL_NAME_TARGET,
  MAPPING_TARGETS,
  expandMapping,
  type BuiltRow,
  type ColumnMapping,
  type MappingTarget,
  type StoredMapping,
} from '@/google-sheets/sheet-rows';
import { AirtableClient, RECORD_PAGE_SIZE } from './airtable.client';
import { AirtableConnectionsService, type SessionIdentity } from './airtable-connections.service';
import {
  AIRTABLE_IMPORT_REVIEW_REASON,
  buildAirtableRow,
  compatible,
  incompatibleReason,
  isReadOnly,
  kindOf,
  rowContext,
} from './airtable-records';
import { CREATABLE_TYPES, TYPE_LABELS, isCreatable, newFieldBody, sameFieldName, type CreatableType } from './airtable-fields';
import { AirtableSyncService, PENDING_PREFIX } from './airtable-sync.service';
import { readSyncConfig, writesOut, type AirtableSyncConfig, type SyncDirection } from './sync-config';
import { writeBackCatalogue, type WriteBackChoice } from './write-back';
import type { CreateAirtableFieldDto, CreateAirtableSourceDto, ImportAirtableDto, SaveAirtableMappingDto, SetAirtableSyncDto } from './dto/airtable.dto';
import type { AirtableField, AirtableRecord } from './types';

/**
 * One Airtable table per lead source: pick the base and table, map its fields,
 * import its records.
 *
 * Nothing here invents a lead pipeline. A record becomes a BuiltRow — the very
 * shape a sheet row and a CRM contact become — and SheetImportService writes
 * it, so Airtable inherits the duplicate checks, the do-not-contact rules,
 * Import Review and the automation safety rules already in place.
 *
 * Identity is the Airtable RECORD ID throughout, and fields are addressed by
 * FIELD ID: renaming a table or a column in Airtable must not orphan a mapping
 * or import everything a second time.
 */

/** How the base and table are packed into lead_sources.external_form_id, as Google Sheets packs a spreadsheet and a tab. */
const AIRTABLE_SOURCE = { provider: LeadSourceProvider.AIRTABLE, connectionMethod: ConnectionMethod.SYNC } as const;

/** Records shown before importing. Enough to judge a mapping, small enough to stay quick. */
const PREVIEW_RECORDS = 50;
/**
 * Records imported inside the owner's own request.
 *
 * Enough that an ordinary table finishes in one go and the counts on screen are
 * the whole story; small enough that a large one cannot hold a request open
 * past whatever patience a proxy has. Anything left over is picked up by the
 * worker moments later, which is the same path that keeps the table in step
 * afterwards anyway.
 */
const MAX_IMPORT_RECORDS = 1_000;
/** Pages per import, as a second guard against an unbounded loop on a bad cursor. */
const MAX_PAGES = Math.ceil(MAX_IMPORT_RECORDS / RECORD_PAGE_SIZE) + 1;

const SOURCE_SELECT = {
  id: true,
  name: true,
  externalFormId: true,
  externalFormName: true,
  integrationId: true,
  ingestStatus: true,
  mappingStatus: true,
  mappingVersion: true,
  defaultConsentStatus: true,
  syncNextAt: true,
  syncLockedAt: true,
  remoteSyncedAt: true,
  lastSuccessAt: true,
  lastFailureAt: true,
  remoteErrorCode: true,
  remoteErrorMessage: true,
  createdAt: true,
  // Which way this table syncs, for the card to say so on the row itself. The
  // setting is otherwise only visible after opening the table, which left no
  // way to tell an import-only table from a two-way one at a glance.
  syncConfig: true,
} satisfies Prisma.LeadSourceSelect;
type SourceRow = Prisma.LeadSourceGetPayload<{ select: typeof SOURCE_SELECT }>;

export interface AirtableSourceDTO {
  id: string;
  name: string;
  baseId: string;
  tableId: string;
  connectionId: string | null;
  status: string | null;
  mappingStatus: string | null;
  lastImportedAt: Date | null;
  lastFailureAt: Date | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  pendingReview: number;
  importedLeads: number;
  /** Which way this table syncs, so the card can show it without opening the table. */
  direction: SyncDirection;
  createdAt: Date;
}

/** base and table, as lead_sources.external_form_id packs them. */
export function parseExternal(s: { externalFormId: string | null }): { baseId: string; tableId: string } {
  const [baseId = '', tableId = ''] = (s.externalFormId ?? '').split(':');
  return { baseId, tableId };
}

@Injectable()
export class AirtableSourcesService {
  private readonly logger = new Logger('AirtableSources');

  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: AirtableConnectionsService,
    private readonly client: AirtableClient,
    private readonly importer: SheetImportService,
    private readonly sync: AirtableSyncService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<IntegrationEnv, true>,
  ) {}

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  /** Every base this grant can see. Airtable pages at 1000; all pages are followed. */
  async bases(orgId: string, connectionId: string) {
    await this.connections.mustFind(orgId, connectionId);
    return this.connections.withAccessToken(orgId, connectionId, async (token) => {
      const out: { id: string; name: string; permissionLevel: string | null }[] = [];
      let offset: string | null = null;
      do {
        const page = await this.client.listBases(token, offset);
        out.push(...page.bases.map((b) => ({ id: b.id, name: b.name, permissionLevel: b.permissionLevel ?? null })));
        offset = page.offset;
      } while (offset && out.length < 5_000);
      return { bases: out };
    }).catch((e) => {
      throw this.connections.toHttp(e);
    });
  }

  /** A base's tables and their fields, straight from Airtable. */
  async tables(orgId: string, connectionId: string, baseId: string) {
    await this.connections.mustFind(orgId, connectionId);
    const tables = await this.connections
      .withAccessToken(orgId, connectionId, (token) => this.client.baseSchema(token, baseId))
      .catch((e) => {
        throw this.connections.toHttp(e);
      });
    return {
      tables: tables.map((t) => ({
        id: t.id,
        name: t.name,
        fieldCount: (t.fields ?? []).length,
        fields: (t.fields ?? []).map(describeField),
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Sources
  // -------------------------------------------------------------------------

  async list(orgId: string): Promise<AirtableSourceDTO[]> {
    const [sources, pending, leads] = await Promise.all([
      this.prisma.leadSource.findMany({ where: { orgId, ...AIRTABLE_SOURCE, archivedAt: null }, select: SOURCE_SELECT, orderBy: { createdAt: 'desc' } }),
      this.prisma.sheetImportRow.groupBy({ by: ['leadSourceId'], where: { orgId, reviewState: 'pending' }, _count: { _all: true } }),
      this.prisma.lead.groupBy({ by: ['leadSourceId'], where: { orgId }, _count: { _all: true } }),
    ]);
    const review = new Map(pending.map((p) => [p.leadSourceId, p._count._all]));
    const imported = new Map(leads.map((l) => [l.leadSourceId, l._count._all]));
    return sources.map((s) => toDTO(s, review.get(s.id) ?? 0, imported.get(s.id) ?? 0));
  }

  /** Pick a base and a table. Reusing an existing source keeps its leads and its mapping. */
  async create(who: SessionIdentity, body: CreateAirtableSourceDto): Promise<AirtableSourceDTO> {
    const orgId = who.organizationId;
    await this.connections.mustFind(orgId, body.connectionId);

    // The table must exist in the base, and we need its real name for the label.
    const table = await this.connections
      .withAccessToken(orgId, body.connectionId, async (token) => {
        const tables = await this.client.baseSchema(token, body.baseId);
        return tables.find((t) => t.id === body.tableId);
      })
      .catch((e) => {
        throw this.connections.toHttp(e);
      });
    if (!table) throw httpError(404, 'AIRTABLE_TABLE_NOT_FOUND', 'That table is not in this Airtable base.');

    const bases = await this.bases(orgId, body.connectionId);
    const baseName = bases.bases.find((b) => b.id === body.baseId)?.name ?? body.baseId;
    const title = `${baseName} › ${table.name}`;
    const externalId = `${body.baseId}:${body.tableId}`;

    const existing = await this.prisma.leadSource.findMany({
      where: { orgId, ...AIRTABLE_SOURCE, externalFormId: externalId },
      select: { ...SOURCE_SELECT, archivedAt: true },
      orderBy: { createdAt: 'desc' },
    });
    const live = existing.find((s) => !s.archivedAt);
    if (live) {
      if (live.integrationId !== body.connectionId) {
        await this.prisma.leadSource.updateMany({ where: { id: live.id, orgId }, data: { integrationId: body.connectionId } });
      }
      return this.dto(orgId, await this.mustFind(orgId, live.id));
    }

    const archived = existing[0];
    if (archived) {
      await this.prisma.leadSource.updateMany({
        where: { id: archived.id, orgId },
        data: {
          archivedAt: null,
          integrationId: body.connectionId,
          name: title.slice(0, 100),
          externalFormName: title.slice(0, 255),
          ingestStatus: archived.mappingStatus === MappingStatus.CONFIGURED ? IngestStatus.PAUSED : IngestStatus.NEEDS_MAPPING,
          syncNextAt: null,
        },
      });
      await this.record(who, 'airtable_source.restored', archived.id, { baseId: body.baseId, tableId: body.tableId });
      return this.dto(orgId, await this.mustFind(orgId, archived.id));
    }

    let id: string;
    try {
      ({ id } = await this.prisma.leadSource.create({
        data: {
          orgId,
          name: title.slice(0, 100),
          code: `airtable-${randomUUID().slice(-12)}`,
          ...AIRTABLE_SOURCE,
          integrationId: body.connectionId,
          externalFormId: externalId,
          externalFormName: title.slice(0, 255),
          // Never from Airtable: no consent basis is asserted for imported records.
          defaultConsentStatus: ConsentStatus.pending,
          ingestStatus: IngestStatus.NEEDS_MAPPING,
          mappingStatus: MappingStatus.UNCONFIGURED,
        },
        select: { id: true },
      }));
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // Two tabs picking the same table at once: both land on the one row.
        const winner = await this.prisma.leadSource.findFirst({ where: { orgId, ...AIRTABLE_SOURCE, externalFormId: externalId, archivedAt: null }, select: SOURCE_SELECT });
        if (winner) return this.dto(orgId, winner);
        // lead_sources_airtable_table_live is scoped to the organization, so a
        // table some other organization syncs is not a conflict and never
        // reaches here. What is left is this organization's own row moving
        // under us between the create and the re-read.
        throw httpError(409, 'AIRTABLE_SOURCE_CONFLICT', 'That Airtable table could not be connected just now. Try again.');
      }
      throw error;
    }
    await this.record(who, 'airtable_source.created', id, { baseId: body.baseId, tableId: body.tableId });
    return this.dto(orgId, await this.mustFind(orgId, id));
  }

  /**
   * What importing would do right now, without writing a lead: the table's
   * fields with their Airtable types, the saved mapping (or nothing — a mapping
   * is never guessed into place), and a verdict per record.
   */
  async preview(orgId: string, sourceId: string) {
    const source = await this.mustFind(orgId, sourceId);
    const { baseId, tableId } = parseExternal(source);
    const { fields, records } = await this.read(orgId, source, { limit: PREVIEW_RECORDS });
    await this.refreshFields(orgId, sourceId, fields);

    const saved = await this.savedMapping(orgId, sourceId);
    const columns = saved ? toColumns(saved) : [];
    const problems = this.validate(columns, fields);
    const ctx = rowContext(fields, saved ?? []);

    const seen = new Set<string>();
    const verdicts = records.map((record, i) => {
      const built = buildAirtableRow(record, i + 1, ctx);
      const duplicate = Boolean(built.key && seen.has(built.key));
      if (built.key) seen.add(built.key);
      return { record, built, issue: built.issue ?? (duplicate ? ('DUPLICATE_IN_SHEET' as const) : null) };
    });
    const flags = await contactFlags(
      this.prisma,
      orgId,
      verdicts.filter((v) => !v.issue && v.built.lead).map((v) => v.built),
    );

    return {
      source: toDTO(source, 0, 0),
      table: { baseId, tableId, name: source.externalFormName },
      fields: fields.map((f) => ({
        ...describeField(f),
        /** Which EstatePulse fields this one may fill, so the UI never offers an impossible pair. */
        allowedTargets: (MAPPING_TARGETS as readonly string[]).filter((t) => compatible(f.type, t as MappingTarget)),
      })),
      mapping: columns,
      problems,
      records: verdicts.map(({ record, built, issue }) => ({
        recordId: record.id,
        issue,
        lead: built.lead ?? null,
        reviewReasons: [...(flags.reasons.get(built.rowNumber) ?? []), ...built.reviewReasons],
      })),
    };
  }

  /**
   * Save an explicit field mapping. Nothing is mapped that the owner did not
   * map: there is no heuristic fallback here, and a field the mapping does not
   * name is never written to a lead.
   */
  async saveMapping(who: SessionIdentity, sourceId: string, body: SaveAirtableMappingDto): Promise<AirtableSourceDTO> {
    const orgId = who.organizationId;
    const source = await this.mustFind(orgId, sourceId);
    const { fields } = await this.read(orgId, source, { limit: 0 });
    await this.refreshFields(orgId, sourceId, fields);

    const columns = body.columns as ColumnMapping[];
    const problems = this.validate(columns, fields);
    if (problems.length) throw new AppError('VALIDATION_ERROR', 'The mapping does not fit this Airtable table', problems);

    const stored = expandMapping(columns);
    await this.prisma.$transaction(async (tx) => {
      await tx.leadSourceFieldMapping.deleteMany({ where: { orgId, leadSourceId: sourceId } });
      await tx.leadSourceFieldMapping.createMany({
        data: stored.map((m) => ({
          orgId,
          leadSourceId: sourceId,
          sourceFieldKey: m.source_field_key,
          targetField: m.target_field,
          transform: m.transform as unknown as Prisma.InputJsonValue,
          isActive: true,
          origin: 'USER' as const,
        })),
      });
      await tx.leadSource.updateMany({
        where: { id: sourceId, orgId },
        data: {
          mappingStatus: MappingStatus.CONFIGURED,
          mappingVersion: { increment: 1 },
          // The record id is the identity, always; it is not a column the owner picks.
          syncRowKeyField: null,
          ingestStatus: source.ingestStatus === IngestStatus.NEEDS_MAPPING ? IngestStatus.PAUSED : undefined,
        },
      });
    });
    await this.record(who, 'airtable_source.mapping_saved', sourceId, { columns: columns.length });
    return this.dto(orgId, await this.mustFind(orgId, sourceId));
  }

  /**
   * Import the table's records.
   *
   * Imported leads wait in Import Review. Only the records the owner ticked are
   * approved, and only through the same approval path a sheet import uses —
   * nothing is approved on its own.
   */
  async startImport(who: SessionIdentity, sourceId: string, body: ImportAirtableDto) {
    const orgId = who.organizationId;
    const source = await this.mustFind(orgId, sourceId);
    if (source.mappingStatus !== MappingStatus.CONFIGURED) {
      throw httpError(409, 'MAPPING_REQUIRED', 'Save the field mapping before importing.');
    }
    await this.requireLiveConnection(orgId, source);

    const ticked = new Set(body.approveRecordIds ?? []);
    const by = { userId: who.userId };
    const scheduling = this.config.get('OUTREACH_SCHEDULING_ENABLED', { infer: true });
    // Checked before anything is written: a schedule already past refuses the whole import.
    const outreach = ticked.size > 0 ? await outreachRequest(this.prisma, scheduling, orgId, by, body.outreach) : undefined;

    // One import at a time. Without this a second click — or a browser retrying
    // a request it thinks timed out — runs the whole thing again alongside the
    // first, and the worker could pick the table up underneath both.
    if (!(await this.sync.hold(orgId, sourceId))) {
      throw httpError(409, 'AIRTABLE_IMPORT_RUNNING', 'This Airtable table is already being imported. Wait for that to finish.');
    }

    const stats = new RunStats(0);
    let result: { read: number; skipped: number; more: boolean };
    try {
      result = await this.importAll(orgId, source, stats, ticked.size ? { rule: (b: BuiltRow) => Boolean(b.externalId && ticked.has(b.externalId)), by, outreach } : null);
    } finally {
      await this.sync.releaseHold(orgId, sourceId);
    }

    await this.prisma.leadSource.updateMany({
      where: { id: sourceId, orgId },
      data: {
        ingestStatus: IngestStatus.ACTIVE,
        lastSuccessAt: new Date(),
        remoteSyncedAt: new Date(),
        remoteErrorCode: null,
        remoteErrorMessage: null,
        syncFailures: 0,
        isActive: true,
        // Always, not only when records are left over. Until this is set the
        // worker has no reason to look at the table again, so an import-only
        // source would take its first load and then never notice another thing
        // added in Airtable.
        syncNextAt: new Date(),
      },
    });
    this.sync.nudge();
    await this.record(who, 'airtable_source.imported', sourceId, {
      read: result.read,
      inserted: stats.inserted,
      updated: stats.updated,
      ticked: ticked.size,
      more: result.more,
    });

    return {
      source: await this.dto(orgId, await this.mustFind(orgId, sourceId)),
      read: result.read,
      imported: stats.inserted,
      updated: stats.updated,
      unchanged: stats.unchanged,
      skipped: result.skipped,
      /** The table was bigger than one run; the worker is bringing in the rest. */
      moreComing: result.more,
      approval: {
        approved: stats.autoApproved,
        released: stats.autoReleased,
        held: stats.autoHeld,
        ...(outreach?.batchId ? { outreach: summaryOf(outreach) } : {}),
      },
    };
  }

  /**
   * Stores which reports go to which columns, and queues every record to be
   * written again when that set changed.
   *
   * The push picks its work with "has this lead changed since we last wrote
   * it", which cannot see a change to the columns themselves — so switching a
   * report on would create the Airtable column and then never fill it.
   * Clearing the fingerprint is what makes those rows due again.
   */
  private async applyWriteBack(orgId: string, sourceId: string, current: AirtableSyncConfig, writeBack: WriteBackChoice[]): Promise<void> {
    if (sameWriteBack(current.writeBack, writeBack)) return;
    await this.prisma.leadSource.updateMany({
      where: { id: sourceId, orgId },
      data: { syncConfig: { ...current, writeBack } as unknown as Prisma.InputJsonValue, syncNextAt: new Date() },
    });
    const { count } = await this.prisma.sheetImportRow.updateMany({
      where: { orgId, leadSourceId: sourceId },
      data: { pushedHash: null, pushAvailableAt: new Date(), pushAttempts: 0 },
    });
    this.logger.log(`Airtable source ${sourceId}: reporting changed, ${count} record(s) queued to be written again`);
    this.sync.nudge();
  }

  /** Which way this table syncs. */
  async setSyncConfig(who: SessionIdentity, sourceId: string, body: SetAirtableSyncDto): Promise<AirtableSourceDTO> {
    const orgId = who.organizationId;
    const source = await this.mustFind(orgId, sourceId);
    const current = readSyncConfig((await this.prisma.leadSource.findFirst({ where: { id: sourceId, orgId }, select: { syncConfig: true } }))?.syncConfig);
    const next = readSyncConfig({
      direction: body.direction,
      ...(body.exportScope ? { exportScope: body.exportScope } : {}),
      // Absent leaves the chosen columns alone, so changing a direction does not
      // quietly drop what the owner asked to have reported.
      writeBack: body.writeBack ?? current.writeBack,
    } as unknown as Prisma.JsonValue);

    if (writesOut(next)) {
      // Writing records is its own permission; say so now rather than failing every push later.
      const permissions = await this.connections.permissions(orgId, source.integrationId ?? '');
      if (!permissions.writeRecords) {
        throw httpError(
          403,
          'AIRTABLE_SCOPE_NOT_GRANTED',
          'This Airtable connection may not write records. Reconnect Airtable and approve the record-write permission to sync this way.',
        );
      }
    }

    await this.prisma.leadSource.updateMany({
      where: { id: sourceId, orgId },
      data: { syncConfig: next as unknown as Prisma.InputJsonValue, syncNextAt: new Date() },
    });
    await this.applyWriteBack(orgId, sourceId, { ...next, writeBack: current.writeBack }, next.writeBack);
    await this.record(who, 'airtable_source.sync_configured', sourceId, {
      direction: next.direction,
      exportScope: next.exportScope,
      writeBackFields: next.writeBack.length,
    });
    this.sync.nudge();
    return this.dto(orgId, await this.mustFind(orgId, sourceId));
  }

  /**
   * Adds a column to the Airtable table.
   *
   * Refused outright without `schema.bases:write`: record sync keeps working
   * without it, so this is a missing permission, not a broken connection.
   * Nothing existing is ever modified or deleted — this only creates — and a
   * column with that name already there is reported rather than duplicated.
   */
  async createField(who: SessionIdentity, sourceId: string, body: CreateAirtableFieldDto) {
    const orgId = who.organizationId;
    const source = await this.mustFind(orgId, sourceId);
    const { baseId, tableId } = parseExternal(source);

    const permissions = await this.connections.permissions(orgId, source.integrationId ?? '');
    if (!permissions.writeSchema) {
      throw httpError(
        403,
        'AIRTABLE_SCHEMA_WRITE_NOT_GRANTED',
        'This Airtable connection may not change the table’s structure. Records still sync; to add columns, reconnect Airtable and approve the schema permission.',
      );
    }
    if (!isCreatable(body.type)) {
      throw httpError(400, 'AIRTABLE_FIELD_TYPE_UNSUPPORTED', `EstatePulse cannot create a ${body.type} field in Airtable.`);
    }

    const { fields } = await this.read(orgId, source, { limit: 0 });
    const clash = fields.find((f) => sameFieldName(f.name, body.name));
    if (clash) {
      throw httpError(409, 'AIRTABLE_FIELD_EXISTS', `Airtable already has a field called “${clash.name}”. Map that one instead of creating another.`, {
        field: { id: clash.id, name: clash.name, type: clash.type },
      });
    }

    const made = await this.connections
      .withAccessToken(orgId, source.integrationId ?? '', (token) =>
        this.client.createField(token, baseId, tableId, newFieldBody({ ...body, type: body.type as CreatableType })),
      )
      .catch((e) => {
        throw this.connections.toHttp(e);
      });

    // Every schema change is recorded: what was made, where, and by whom.
    await this.record(who, 'airtable_source.field_created', sourceId, { baseId, tableId, fieldId: made.id, name: made.name, type: made.type });

    // The table as it now stands, without asking Airtable for it again: the
    // schema was just read for the clash check above, and the one thing that
    // changed is the field Airtable handed back. A second read would cost
    // another round trip and another pacing gap for an answer already in hand.
    const refreshed = [...fields, made];
    await this.refreshFields(orgId, sourceId, refreshed);
    // Making the column and then being told to point a report at it are the
    // same intention; doing both here saves the caller a second round trip and
    // leaves no window where the column exists but nothing fills it.
    const config = readSyncConfig((await this.prisma.leadSource.findFirst({ where: { id: sourceId, orgId }, select: { syncConfig: true } }))?.syncConfig);
    if (body.sendAs) {
      const next = [...config.writeBack.filter((w) => w.key !== body.sendAs && w.fieldId !== made.id), { key: body.sendAs, fieldId: made.id }];
      await this.applyWriteBack(orgId, sourceId, config, next);
      config.writeBack = next;
    }

    return {
      field: { ...describeField(made), allowedTargets: (MAPPING_TARGETS as readonly string[]).filter((t) => compatible(made.type, t as MappingTarget)) },
      fields: refreshed.map((f) => ({
        ...describeField(f),
        allowedTargets: (MAPPING_TARGETS as readonly string[]).filter((t) => compatible(f.type, t as MappingTarget)),
      })),
      writeBack: config.writeBack,
    };
  }

  /**
   * Everything EstatePulse can report back about a lead it has worked, for the
   * owner to choose from. The catalogue is fixed — each entry needs a reader and
   * a column type — but which of them travel is theirs to decide.
   */
  writeBackFields() {
    return { fields: writeBackCatalogue() };
  }

  /** This table's columns, without reading a single record. */
  async tableFields(orgId: string, sourceId: string) {
    const source = await this.mustFind(orgId, sourceId);
    const { fields } = await this.read(orgId, source, { limit: 0 });
    await this.refreshFields(orgId, sourceId, fields);
    return { fields: fields.map(describeField) };
  }

  /** The field types an owner may create, for the picker. */
  fieldTypes() {
    return { types: CREATABLE_TYPES.map((t) => ({ type: t, label: TYPE_LABELS[t] })) };
  }

  /** Run a sync now rather than waiting for the next scheduled one. */
  async syncNow(who: SessionIdentity, sourceId: string) {
    const orgId = who.organizationId;
    const source = await this.mustFind(orgId, sourceId);
    await this.requireLiveConnection(orgId, source);
    await this.prisma.leadSource.updateMany({ where: { id: sourceId, orgId }, data: { syncNextAt: new Date(), isActive: true } });
    await this.record(who, 'airtable_source.sync_requested', sourceId, {});
    this.sync.nudge();
    return { queued: true as const };
  }

  /**
   * Puts failed pushes back in the queue. Nothing is discarded when a push
   * fails — it is parked with its reason, and this is how it is tried again.
   */
  async retryFailed(who: SessionIdentity, sourceId: string) {
    const orgId = who.organizationId;
    await this.mustFind(orgId, sourceId);
    const { count } = await this.prisma.sheetImportRow.updateMany({
      where: {
        orgId,
        leadSourceId: sourceId,
        pushErrorCode: { not: null },
        // A create nobody got an answer to is left alone. Clearing its warning
        // would hide the one thing an owner needs to know, and retrying it
        // would be the duplicate the claim exists to prevent.
        rowKey: { not: { startsWith: PENDING_PREFIX } },
      },
      data: { pushAttempts: 0, pushAvailableAt: new Date(), pushError: null, pushErrorCode: null },
    });
    await this.record(who, 'airtable_source.retry_requested', sourceId, { rows: count });
    this.sync.nudge();
    return { retrying: count };
  }

  /** Everything the sync dashboard shows. Never a token, never a cell value. */
  async status(orgId: string, sourceId: string) {
    const source = await this.mustFind(orgId, sourceId);
    const full = await this.prisma.leadSource.findFirst({
      where: { id: sourceId, orgId },
      select: { syncConfig: true, externalWebhookId: true, remoteState: true, syncLockedAt: true, syncFailures: true, lastEventAt: true },
    });
    const config = readSyncConfig(full?.syncConfig);
    const [importedLeads, pendingReview, changesToReview, exported, failed, permissions] = await Promise.all([
      this.prisma.lead.count({ where: { orgId, leadSourceId: sourceId } }),
      this.prisma.sheetImportRow.count({ where: { orgId, leadSourceId: sourceId, reviewState: 'pending' } }),
      this.prisma.sheetImportRow.count({ where: { orgId, leadSourceId: sourceId, changedAfterReviewAt: { not: null } } }),
      this.prisma.sheetImportRow.count({ where: { orgId, leadSourceId: sourceId, pushedAt: { not: null } } }),
      this.prisma.sheetImportRow.findMany({
        where: { orgId, leadSourceId: sourceId, pushErrorCode: { not: null } },
        select: { id: true, rowKey: true, pushErrorCode: true, pushError: true, pushAttempts: true, pushAvailableAt: true },
        take: 20,
      }),
      source.integrationId ? this.connections.permissions(orgId, source.integrationId).catch(() => null) : Promise.resolve(null),
    ]);

    return {
      source: toDTO(source, pendingReview, importedLeads),
      direction: config.direction,
      exportScope: config.exportScope,
      writeBack: config.writeBack,
      permissions,
      /** Watching for changes, rather than re-reading the whole table. */
      watching: Boolean(full?.externalWebhookId),
      remoteState: full?.remoteState ?? null,
      syncing: Boolean(full?.syncLockedAt),
      lastSuccessfulSyncAt: source.lastSuccessAt,
      lastFailureAt: source.lastFailureAt,
      lastWebhookAt: full?.lastEventAt ?? null,
      nextSyncAt: source.syncNextAt,
      consecutiveFailures: full?.syncFailures ?? 0,
      lastError: source.remoteErrorCode ? { code: source.remoteErrorCode, message: source.remoteErrorMessage } : null,
      counts: { importedLeads, pendingReview, changesToReview, exported, failed: failed.length },
      failures: failed.map((f) => ({
        rowId: f.id,
        code: f.pushErrorCode,
        message: f.pushError,
        attempts: f.pushAttempts,
        nextAttemptAt: f.pushAvailableAt,
      })),
    };
  }

  /**
   * Takes Airtable's notification target back out of the base.
   *
   * An OAuth-made webhook expires after seven days by itself, but until then it
   * is a live callback into a base we have been told to leave alone. Best
   * effort: a webhook we cannot remove is not a reason to refuse the owner's
   * request, so the local record of it goes either way.
   */
  private async dropWebhook(orgId: string, sourceId: string): Promise<void> {
    const row = await this.prisma.leadSource.findFirst({
      where: { id: sourceId, orgId },
      select: { integrationId: true, externalFormId: true, externalWebhookId: true },
    });
    const webhookId = row?.externalWebhookId;
    if (!webhookId) return;
    const [baseId] = (row.externalFormId ?? '').split(':');
    if (baseId && row.integrationId) {
      await this.connections
        .withAccessToken(orgId, row.integrationId, (token) => this.client.deleteWebhook(token, baseId, webhookId))
        .catch((e: unknown) => this.logger.warn(`Airtable source ${sourceId}: could not remove webhook ${webhookId} (${(e as Error).message})`));
    }
    await this.prisma.leadSource.updateMany({
      where: { id: sourceId, orgId },
      data: { externalWebhookId: null, signingSecretEnc: null, syncRemoteVersion: null, remoteState: null },
    });
  }

  /**
   * Every webhook this connection installed, removed while the grant still
   * works. After a disconnect the tokens are gone and Airtable can no longer be
   * asked to stop.
   */
  async releaseWebhooks(orgId: string, connectionId: string): Promise<void> {
    const sources = await this.prisma.leadSource.findMany({
      where: { orgId, ...AIRTABLE_SOURCE, integrationId: connectionId, externalWebhookId: { not: null } },
      select: { id: true },
    });
    for (const s of sources) await this.dropWebhook(orgId, s.id);
  }

  /** Stop syncing this table. Imported leads and their review rows are kept. */
  async remove(who: SessionIdentity, sourceId: string): Promise<{ removed: true; pendingReview: number }> {
    const orgId = who.organizationId;
    await this.mustFind(orgId, sourceId);
    await this.dropWebhook(orgId, sourceId);
    await this.prisma.leadSource.updateMany({
      where: { id: sourceId, orgId },
      data: { archivedAt: new Date(), ingestStatus: IngestStatus.PAUSED, syncNextAt: null, isActive: false },
    });
    const pendingReview = await this.prisma.sheetImportRow.count({ where: { orgId, leadSourceId: sourceId, reviewState: 'pending' } });
    await this.record(who, 'airtable_source.removed', sourceId, { pendingReview });
    return { removed: true, pendingReview };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Reads the table's schema and, unless `limit` is 0, a page or more of its
   * records.
   *
   * Every field is asked for unless the caller narrows it with `fieldIds`.
   * Importing deliberately does not narrow: a mapping can gain a column at any
   * time, and a row built from a partial record would fingerprint differently
   * from the same row read in full.
   */
  private async read(
    orgId: string,
    source: SourceRow,
    opts: { limit: number; fieldIds?: string[] },
  ): Promise<{ fields: AirtableField[]; records: AirtableRecord[]; more: boolean }> {
    const { baseId, tableId } = parseExternal(source);
    if (!baseId || !tableId) throw httpError(409, 'AIRTABLE_SOURCE_INVALID', 'This Airtable source is missing its base or table.');

    return this.connections
      .withAccessToken(orgId, source.integrationId ?? '', async (token) => {
        const tables = await this.client.baseSchema(token, baseId);
        const table = tables.find((t) => t.id === tableId);
        if (!table) throw httpError(404, 'AIRTABLE_TABLE_MISSING', 'The connected Airtable table no longer exists.');
        const fields = table.fields ?? [];

        const records: AirtableRecord[] = [];
        let offset: string | null = null;
        if (opts.limit > 0) {
          for (let page = 0; page < MAX_PAGES; page++) {
            const got: { records: AirtableRecord[]; offset: string | null } = await this.client.listRecords(token, baseId, tableId, {
              offset,
              pageSize: Math.min(RECORD_PAGE_SIZE, opts.limit - records.length),
              fieldIds: opts.fieldIds,
            });
            records.push(...got.records);
            offset = got.offset;
            if (!offset || records.length >= opts.limit) break;
          }
        }
        // An offset still in hand means the table did not fit in this run.
        return { fields, records, more: Boolean(offset) };
      })
      .catch((e) => {
        throw this.connections.toHttp(e);
      });
  }

  /** Reads every record and writes it through the import engine, a page at a time. */
  private async importAll(orgId: string, source: SourceRow, stats: RunStats, approve: Parameters<SheetImportService['importRows']>[6]) {
    const saved = await this.savedMapping(orgId, source.id);
    const { fields, records, more } = await this.read(orgId, source, { limit: MAX_IMPORT_RECORDS });
    await this.refreshFields(orgId, source.id, fields);
    const ctx = rowContext(fields, saved ?? []);

    const rows: BuiltRow[] = [];
    let skipped = 0;
    records.forEach((record, i) => {
      const built = buildAirtableRow(record, i + 1, ctx);
      if (built.blank) return;
      if (built.issue) {
        // A record with no name, or nobody to reach, is not a lead — making one
        // would put a row nobody can act on into the lead table. It is counted
        // WITH ITS REASON rather than merely counted, the way a sheet row is, so
        // the run can say which records it could not use and why.
        skipped += 1;
        stats.skip(i + 1, built.issue);
        return;
      }
      rows.push(built);
    });
    stats.rowsRead = records.length;

    if (rows.length) {
      await this.importer.importRows(orgId, source.id, source.defaultConsentStatus, rows, stats, AIRTABLE_IMPORT_REVIEW_REASON, approve, {
        scopeToRows: true,
      });
    }
    this.logger.log(`Airtable source ${source.id}: read ${records.length}, wrote ${rows.length}, skipped ${skipped}`);
    return { read: records.length, skipped, more };
  }

  /**
   * Keeps lead_source_fields in step with the table, keyed by Airtable FIELD ID
   * so a rename is a label change rather than a new field and a broken mapping.
   */
  private async refreshFields(orgId: string, sourceId: string, fields: AirtableField[]): Promise<void> {
    const now = new Date();
    const known = await this.prisma.leadSourceField.findMany({
      where: { orgId, leadSourceId: sourceId },
      select: { id: true, fieldKey: true, label: true, fieldType: true },
    });
    const byKey = new Map(known.map((k) => [k.fieldKey, k]));

    const fresh = fields.filter((f) => !byKey.has(f.id));
    // Renames and type changes are rare; seeing a field again is not. Touching
    // every field one statement at a time made the common case cost a query per
    // column, so the common case is now a single statement.
    const moved = fields.filter((f) => {
      const k = byKey.get(f.id);
      return k && (k.label !== f.name || k.fieldType !== f.type.slice(0, 50));
    });

    if (fresh.length) {
      await this.prisma.leadSourceField.createMany({
        data: fresh.map((f) => ({
          orgId,
          leadSourceId: sourceId,
          fieldKey: f.id,
          label: f.name,
          fieldType: f.type.slice(0, 50),
          options: (f.options ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          status: FieldStatus.ACTIVE,
          missingStreak: 0,
          lastSeenAt: now,
        })),
      });
    }
    for (const f of moved) {
      await this.prisma.leadSourceField.update({
        where: { id: byKey.get(f.id)!.id },
        data: { label: f.name, fieldType: f.type.slice(0, 50), options: (f.options ?? Prisma.JsonNull) as Prisma.InputJsonValue },
      });
    }
    const seen = fields.filter((f) => byKey.has(f.id)).map((f) => byKey.get(f.id)!.id);
    if (seen.length) {
      await this.prisma.leadSourceField.updateMany({
        where: { id: { in: seen } },
        data: { status: FieldStatus.ACTIVE, missingStreak: 0, lastSeenAt: now },
      });
    }

    // A field deleted in Airtable is marked, never removed: a mapping that names it must stay visible.
    const live = new Set(fields.map((f) => f.id));
    const gone = known.filter((k) => !live.has(k.fieldKey)).map((k) => k.id);
    if (gone.length) await this.prisma.leadSourceField.updateMany({ where: { id: { in: gone } }, data: { status: FieldStatus.MISSING } });
  }

  /** Mapping rules that are Airtable's own, on top of the shared ones. */
  private validate(columns: ColumnMapping[], fields: AirtableField[]): { path: string; message: string }[] {
    const problems: { path: string; message: string }[] = [];
    const byId = new Map(fields.map((f) => [f.id, f]));
    const claimed = new Map<string, number>();
    const pairs = new Set<string>();

    columns.forEach((c, i) => {
      const field = byId.get(c.fieldKey);
      if (!field) {
        problems.push({ path: `columns.${i}.fieldKey`, message: `Field "${c.fieldKey}" is no longer in this Airtable table.` });
        return;
      }
      if (!(MAPPING_TARGETS as readonly string[]).includes(c.target)) {
        problems.push({ path: `columns.${i}.target`, message: `"${c.target}" is not a field an Airtable column can fill.` });
        return;
      }
      const pair = `${c.fieldKey}\u0000${c.target}`;
      if (pairs.has(pair)) problems.push({ path: `columns.${i}`, message: 'The same Airtable field is mapped to the same lead field twice.' });
      pairs.add(pair);

      if (!compatible(field.type, c.target)) {
        problems.push({ path: `columns.${i}.target`, message: incompatibleReason(field, c.target) });
        return;
      }
      if (c.target === CUSTOM_TARGET) return;

      const targets = c.target === FULL_NAME_TARGET ? ['first_name', 'last_name'] : [c.target];
      for (const t of targets) {
        if (claimed.has(t)) problems.push({ path: `columns.${i}.target`, message: `That lead field is already filled from another Airtable field.` });
        claimed.set(t, i);
      }
    });

    if (!claimed.has('first_name')) problems.push({ path: 'columns', message: 'Map a field to the lead’s name (first name or full name).' });
    if (!claimed.has('phone') && !claimed.has('email')) {
      problems.push({ path: 'columns', message: 'Map at least one way to reach the person: phone or email.' });
    }
    // A column Airtable itself types as a phone number is the table's own author
    // saying the numbers are here. Leaving it unmapped is a slip, not a choice,
    // and the cost is total: EstatePulse qualifies a lead by calling and texting
    // it, so every lead imported without a number is held on arrival with
    // NO_DIALABLE_PHONE and never reaches outreach.
    //
    // Only possible because Airtable publishes column types. A sheet column has
    // none, which is why the shared rule can ask for no more than "phone or
    // email" and this one can ask for the phone.
    const phoneColumn = fields.find((f) => f.type === 'phoneNumber');
    if (phoneColumn && !claimed.has('phone')) {
      problems.push({
        path: 'columns',
        message: `Map "${phoneColumn.name}" to Phone. EstatePulse reaches leads by calling and texting, so without a number every one of these would be imported and then held.`,
      });
    }
    return problems;
  }

  private async savedMapping(orgId: string, sourceId: string): Promise<StoredMapping[] | null> {
    const rows = await this.prisma.leadSourceFieldMapping.findMany({
      where: { orgId, leadSourceId: sourceId, isActive: true },
      select: { sourceFieldKey: true, targetField: true, transform: true },
    });
    if (!rows.length) return null;
    return rows.map((r) => ({ source_field_key: r.sourceFieldKey, target_field: r.targetField, transform: r.transform as StoredMapping['transform'] }));
  }

  private async requireLiveConnection(orgId: string, source: SourceRow): Promise<void> {
    const credential = source.integrationId
      ? await this.prisma.integration.findFirst({
          where: { id: source.integrationId, orgId, provider: IntegrationProvider.airtable, revokedAt: null },
          select: { status: true },
        })
      : null;
    if (!credential) throw httpError(409, 'AIRTABLE_REAUTH_REQUIRED', 'This table’s Airtable connection was removed. Connect Airtable again.');
    if (credential.status !== IntegrationStatus.active) throw httpError(409, 'AIRTABLE_REAUTH_REQUIRED', 'Reconnect Airtable before importing.');
  }

  async mustFind(orgId: string, sourceId: string): Promise<SourceRow> {
    const row = sourceId
      ? await this.prisma.leadSource.findFirst({ where: { id: sourceId, orgId, ...AIRTABLE_SOURCE, archivedAt: null }, select: SOURCE_SELECT })
      : null;
    if (!row) throw httpError(404, 'AIRTABLE_SOURCE_NOT_FOUND', 'That Airtable table is not connected.');
    return row;
  }

  private async dto(orgId: string, source: SourceRow): Promise<AirtableSourceDTO> {
    const [pendingReview, importedLeads] = await Promise.all([
      this.prisma.sheetImportRow.count({ where: { orgId, leadSourceId: source.id, reviewState: 'pending' } }),
      this.prisma.lead.count({ where: { orgId, leadSourceId: source.id } }),
    ]);
    return toDTO(source, pendingReview, importedLeads);
  }

  private record(who: SessionIdentity, action: string, sourceId: string, payload: Prisma.InputJsonObject) {
    return this.audit.record({
      orgId: who.organizationId,
      actorType: 'user',
      actorId: who.userId,
      action,
      entityType: 'lead_source',
      entityId: sourceId,
      payload,
    });
  }
}

/** Same reports into the same columns, whatever order they were chosen in. */
function sameWriteBack(a: { key: string; fieldId: string }[], b: { key: string; fieldId: string }[]): boolean {
  const at = (w: { key: string; fieldId: string }[]) =>
    w
      .map((x) => `${x.key}:${x.fieldId}`)
      .sort()
      .join('|');
  return at(a) === at(b);
}

function describeField(f: AirtableField) {
  return {
    id: f.id,
    name: f.name,
    type: f.type,
    /** Airtable computes it: it can be read but never written, so phase 3 never sends it. */
    readOnly: isReadOnly(f.type),
    /**
     * The shape the column holds — text, number, date, boolean, list. Airtable
     * has forty-odd types and the difference between singleLineText and
     * richText does not matter to a picker; the difference between a number and
     * a date does.
     */
    kind: kindOf(f.type),
    choices: readChoices(f),
  };
}

/** A single/multiple select's options, for the UI to show what a cell may contain. */
function readChoices(f: AirtableField): string[] | null {
  const choices = (f.options as { choices?: { name?: unknown }[] } | undefined)?.choices;
  if (!Array.isArray(choices)) return null;
  return choices.map((c) => (typeof c.name === 'string' ? c.name : '')).filter(Boolean);
}

function toDTO(s: SourceRow, pendingReview: number, importedLeads: number): AirtableSourceDTO {
  const { baseId, tableId } = parseExternal(s);
  return {
    id: s.id,
    name: s.name,
    baseId,
    tableId,
    connectionId: s.integrationId,
    status: s.ingestStatus,
    mappingStatus: s.mappingStatus,
    lastImportedAt: s.remoteSyncedAt,
    lastFailureAt: s.lastFailureAt,
    lastErrorCode: s.remoteErrorCode,
    lastErrorMessage: s.remoteErrorMessage,
    pendingReview,
    importedLeads,
    direction: readSyncConfig(s.syncConfig).direction,
    createdAt: s.createdAt,
  };
}

/** Stored mapping rows back to the column list the UI edits. */
function toColumns(stored: StoredMapping[]): ColumnMapping[] {
  const splitKeys = new Set(stored.filter((m) => m.target_field === 'first_name' && m.transform?.kind === 'name_split').map((m) => m.source_field_key));
  const out: ColumnMapping[] = [];
  const seen = new Set<string>();
  for (const m of stored) {
    if (splitKeys.has(m.source_field_key)) {
      if (seen.has(m.source_field_key)) continue;
      seen.add(m.source_field_key);
      out.push({ fieldKey: m.source_field_key, target: FULL_NAME_TARGET });
      continue;
    }
    out.push({ fieldKey: m.source_field_key, target: m.target_field as MappingTarget });
  }
  return out;
}
