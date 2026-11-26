import { Injectable } from '@nestjs/common';
import { LeadSourceProvider } from '@prisma/client';
import { AppError } from '@/common/errors/app-error';
import type {
  AccountIdentity,
  AdapterContext,
  AdapterImport,
  AdapterSetup,
  AdapterWriteBack,
  ImportPage,
  IntegrationAdapter,
  SetupResource,
  SetupState,
} from '../adapter.interface';
import { WriteRefused, isSyncField, type SyncField, type SyncValue } from '../../sync/two-way';
import { NangoError } from '../../nango/nango.service';
import {
  MAPPABLE,
  compatible,
  suggestFieldMap,
  toImportedRecord,
  type AirtableRecord,
  type AirtableTable,
  type FieldMap,
  type MappableField,
} from './airtable.mapping';

/**
 * Airtable through Nango. Nango's "airtable" provider proxies to
 * https://api.airtable.com, so endpoints here start at /v0.
 *
 * Endpoints (Airtable Web API):
 *  - GET /v0/meta/whoami                         who the token belongs to (email needs user.email:read)
 *  - GET /v0/meta/bases?offset=                  bases the grant can see (schema.bases:read)
 *  - GET /v0/meta/bases/{baseId}/tables          tables and fields (schema.bases:read)
 *  - GET /v0/{baseId}/{tableId}?pageSize=100&offset=&returnFieldsByFieldId=true  records (data.records:read)
 *  - PATCH /v0/{baseId}/{tableId}/{recordId}     write-back of changed cells, typecast on (data.records:write)
 * Airtable allows 5 requests/second per base; Nango's proxy retries its 429s.
 */

interface AirtableSettings {
  baseId: string;
  baseName: string;
  tableId: string;
  tableName: string;
  fieldMap: FieldMap;
}

const ID = /^[A-Za-z0-9]{3,32}$/;
const RECORD_ID = /^rec[A-Za-z0-9]{3,32}$/;

/** Column types EstatePulse writes text into. Formula, lookup, rollup, date and the like are read-only here. */
const WRITABLE_TEXT = new Set(['singleLineText', 'multilineText', 'richText', 'email', 'phoneNumber', 'url', 'singleSelect']);
/** Column types that take a number. Percent and rating are excluded: a budget there would be nonsense. */
const WRITABLE_NUMBER = new Set(['number', 'currency']);
const NUMERIC_FIELDS: ReadonlySet<SyncField> = new Set(['minBudget', 'maxBudget', 'bedrooms']);

/** Whether EstatePulse may write `target` into a column of this type. */
function writable(type: string, target: MappableField): boolean {
  if (target === 'fullName' || !NUMERIC_FIELDS.has(target as SyncField)) return WRITABLE_TEXT.has(type);
  return WRITABLE_NUMBER.has(type) || WRITABLE_TEXT.has(type);
}

/** Lead fields a field map exchanges: a full-name column carries first and last name. */
function syncedFields(map: FieldMap): SyncField[] {
  const out = new Set<SyncField>();
  for (const target of Object.keys(map) as MappableField[]) {
    if (!map[target]) continue;
    if (target === 'fullName') {
      out.add('firstName');
      out.add('lastName');
    } else if (isSyncField(target)) out.add(target);
  }
  return [...out];
}
const RECORD_PAGE_SIZE = 100;

/** The saved settings, or null when the owner has not finished setup. */
function readSettings(settings: Record<string, unknown>): AirtableSettings | null {
  const { baseId, baseName, tableId, tableName, fieldMap } = settings as Partial<AirtableSettings>;
  if (typeof baseId !== 'string' || typeof tableId !== 'string' || !fieldMap || typeof fieldMap !== 'object') return null;
  return { baseId, tableId, baseName: String(baseName ?? baseId), tableName: String(tableName ?? tableId), fieldMap };
}

interface Cursor {
  offset: string | null;
}

@Injectable()
export class AirtableAdapter implements IntegrationAdapter {
  readonly provider = 'airtable';
  readonly displayName = 'Airtable';
  readonly description =
    'Sync leads with any Airtable base, both ways. Pick a table, check the field mapping; new or changed rows arrive as leads, and lead changes go back to the row.';
  readonly features = [
    'Connect several Airtable accounts and workspaces',
    'Choose the base and table leads live in',
    'Automatic field mapping you can adjust (name, email, phone, budget, bedrooms…)',
    'Unchanged rows are skipped on every re-sync; a person already in EstatePulse is never duplicated',
    'Other columns are kept on the lead as custom fields',
    'Two-way sync: changes made in EstatePulse are written back to the Airtable row',
  ] as const;
  readonly capabilities = ['lead_import', 'tables'] as const;
  readonly fallbackCategories = ['productivity'] as const;
  readonly requiredScopes = ['schema.bases:read', 'data.records:read', 'user.email:read'] as const;
  readonly leadSourceProvider = LeadSourceProvider.AIRTABLE;

  async identify(ctx: AdapterContext): Promise<AccountIdentity> {
    const me = await ctx.client.get<{ id?: string; email?: string; scopes?: string[] }>('/v0/meta/whoami');
    return {
      accountName: me.email ?? null,
      accountEmail: me.email ?? null,
      externalAccountId: me.id ?? null,
      metadata: { scopes: Array.isArray(me.scopes) ? me.scopes.filter((s) => typeof s === 'string') : [] },
    };
  }

  async validateConnection(ctx: AdapterContext): Promise<boolean> {
    try {
      await ctx.client.get('/v0/meta/whoami');
      return true;
    } catch (error) {
      if (error instanceof NangoError && error.kind === 'REAUTH') return false;
      throw error;
    }
  }

  readonly setup: AdapterSetup = {
    resourceKinds: ['bases', 'tables'],

    state: (settings): SetupState => {
      const s = readSettings(settings);
      if (!s) return { complete: false, missing: 'Choose the base and table your leads are in.', summary: null };
      if (!s.fieldMap.email && !s.fieldMap.phone) {
        return { complete: false, missing: 'Map an email or a phone column so leads can be contacted.', summary: `${s.baseName} · ${s.tableName}` };
      }
      return { complete: true, missing: null, summary: `${s.baseName} · ${s.tableName}` };
    },

    listResources: async (ctx, kind, parentId): Promise<SetupResource[]> => {
      if (kind === 'bases') return this.listBases(ctx);
      if (kind === 'tables') {
        if (!parentId || !ID.test(parentId)) throw new AppError('VALIDATION_ERROR', 'Choose a base first.');
        const tables = await this.listTables(ctx, parentId);
        return tables.map((t) => ({
          id: t.id,
          name: t.name,
          detail: {
            fields: t.fields.map((f) => ({ id: f.id, name: f.name, type: f.type })),
            suggestedFieldMap: suggestFieldMap(t),
            compatibility: Object.fromEntries(MAPPABLE.map((m) => [m, t.fields.filter((f) => compatible(f.type, m)).map((f) => f.id)])),
          },
        }));
      }
      throw new AppError('VALIDATION_ERROR', `Airtable has no "${kind}" to list.`);
    },

    saveSettings: async (ctx, input) => {
      const baseId = typeof input.baseId === 'string' ? input.baseId : '';
      const tableId = typeof input.tableId === 'string' ? input.tableId : '';
      if (!ID.test(baseId) || !ID.test(tableId)) throw new AppError('VALIDATION_ERROR', 'Choose a base and a table.');

      // Re-read from Airtable: the ids must be ones this grant can see, never trusted from the browser.
      const bases = await this.listBases(ctx);
      const base = bases.find((b) => b.id === baseId);
      if (!base) throw new AppError('VALIDATION_ERROR', 'That base is not shared with this Airtable connection.');
      const table = (await this.listTables(ctx, baseId)).find((t) => t.id === tableId);
      if (!table) throw new AppError('VALIDATION_ERROR', 'That table no longer exists in the base.');

      const requested = (input.fieldMap && typeof input.fieldMap === 'object' ? input.fieldMap : suggestFieldMap(table)) as Record<string, unknown>;
      const fieldMap: FieldMap = {};
      for (const [target, fieldId] of Object.entries(requested)) {
        if (fieldId === null || fieldId === '' || fieldId === undefined) continue;
        if (!(MAPPABLE as readonly string[]).includes(target)) throw new AppError('VALIDATION_ERROR', `Unknown lead field "${target}".`);
        const field = table.fields.find((f) => f.id === fieldId);
        if (!field) throw new AppError('VALIDATION_ERROR', `The column mapped to ${target} is not in "${table.name}".`);
        if (!compatible(field.type, target as MappableField)) {
          throw new AppError('VALIDATION_ERROR', `"${field.name}" (${field.type}) cannot be used as ${target}.`);
        }
        fieldMap[target as MappableField] = field.id;
      }
      if (!fieldMap.email && !fieldMap.phone) throw new AppError('VALIDATION_ERROR', 'Map an email or a phone column so leads can be contacted.');

      const settings: AirtableSettings = { baseId, baseName: base.name, tableId, tableName: table.name, fieldMap };
      return { ...settings };
    },
  };

  readonly import: AdapterImport<Cursor> = {
    sourceName: (settings) => {
      const s = readSettings(settings);
      return s ? `Airtable · ${s.tableName}` : 'Airtable';
    },

    fetchPage: async (ctx, cursor): Promise<ImportPage<Cursor>> => {
      const s = readSettings(ctx.settings);
      if (!s) throw new AppError('CONFLICT', 'Finish the Airtable setup (base, table and field mapping) before syncing.');
      // The table's schema is read once per run (cached briefly); a renamed column keeps its id.
      const table = await this.tableFor(ctx, s);
      const params: Record<string, string> = { pageSize: String(RECORD_PAGE_SIZE), returnFieldsByFieldId: 'true' };
      if (cursor?.offset) params.offset = cursor.offset;
      const page = await ctx.client.get<{ records?: AirtableRecord[]; offset?: string }>(
        `/v0/${encodeURIComponent(s.baseId)}/${encodeURIComponent(s.tableId)}`,
        params,
      );
      return {
        records: (page.records ?? []).map((r) => toImportedRecord(r, table, s.fieldMap)),
        next: page.offset ? { offset: page.offset } : null,
      };
    },
  };

  readonly writeBack: AdapterWriteBack = {
    writeScopes: ['data.records:write'],

    fields: (settings) => {
      const s = readSettings(settings);
      return s ? syncedFields(s.fieldMap) : [];
    },

    writableFields: async (ctx) => {
      const s = readSettings(ctx.settings);
      if (!s) return [];
      const table = await this.tableFor(ctx, s);
      const type = (fieldId: string | undefined) => table.fields.find((f) => f.id === fieldId)?.type ?? null;
      const out = new Set<SyncField>();
      for (const target of Object.keys(s.fieldMap) as MappableField[]) {
        const t = type(s.fieldMap[target]);
        if (!t || !writable(t, target)) continue;
        if (target === 'fullName') {
          // A separate first/last column wins over the full name for that part.
          if (!s.fieldMap.firstName) out.add('firstName');
          if (!s.fieldMap.lastName) out.add('lastName');
        } else if (isSyncField(target)) out.add(target);
      }
      return [...out];
    },

    push: async (ctx, target, changes, current) => {
      const s = readSettings(ctx.settings);
      if (!s) throw new WriteRefused('Finish the Airtable setup before changes can be written back.');
      if (target.objectType !== `airtable:${s.tableId}`) {
        throw new WriteRefused(`This row is in a table that is no longer synced (now "${s.tableName}"); the change stays in EstatePulse.`);
      }
      if (!RECORD_ID.test(target.externalId)) throw new WriteRefused('This Airtable row id is not valid.');
      const table = await this.tableFor(ctx, s);
      const column = (target: MappableField) => table.fields.find((f) => f.id === s.fieldMap[target]);

      const fields: Record<string, string | number | null> = {};
      const put = (mapped: MappableField, value: SyncValue) => {
        const col = column(mapped);
        if (!col || !writable(col.type, mapped)) return;
        if (value === null) fields[col.id] = null;
        else if (WRITABLE_NUMBER.has(col.type)) fields[col.id] = typeof value === 'number' ? value : Number(value);
        else fields[col.id] = String(value);
      };

      for (const [field, value] of Object.entries(changes) as [SyncField, SyncValue][]) {
        if ((field === 'firstName' || field === 'lastName') && !s.fieldMap[field] && s.fieldMap.fullName) continue;
        put(field, value);
      }
      // First or last name changed and the table keeps one name column: write the whole name.
      const nameChanged = ('firstName' in changes && !s.fieldMap.firstName) || ('lastName' in changes && !s.fieldMap.lastName);
      if (nameChanged && s.fieldMap.fullName) {
        const first = ('firstName' in changes ? changes.firstName : current.firstName) ?? null;
        const last = ('lastName' in changes ? changes.lastName : current.lastName) ?? null;
        const full = [first, last].filter((part) => part !== null && String(part).trim()).join(' ').trim();
        put('fullName', full || null);
      }
      if (!Object.keys(fields).length) return;

      await ctx.client.patch(
        `/v0/${encodeURIComponent(s.baseId)}/${encodeURIComponent(s.tableId)}/${encodeURIComponent(target.externalId)}`,
        // typecast: a new value for a single-select column is added as an option instead of rejected.
        { fields, typecast: true },
      );
    },
  };

  /** One schema read per sync run, keyed by connection: pages of the same run reuse it. */
  private readonly tableCache = new Map<string, { at: number; table: AirtableTable }>();

  private async tableFor(ctx: AdapterContext, s: AirtableSettings): Promise<AirtableTable> {
    const key = `${ctx.connectionId}:${s.tableId}`;
    const hit = this.tableCache.get(key);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.table;
    const table = (await this.listTables(ctx, s.baseId)).find((t) => t.id === s.tableId);
    if (!table) throw new AppError('CONFLICT', `The Airtable table "${s.tableName}" was deleted or is no longer shared. Choose another table.`);
    this.tableCache.set(key, { at: Date.now(), table });
    if (this.tableCache.size > 500) this.tableCache.delete(this.tableCache.keys().next().value!);
    return table;
  }

  private async listBases(ctx: AdapterContext): Promise<SetupResource[]> {
    const bases: SetupResource[] = [];
    let offset: string | undefined;
    // Bounded: 20 pages of 1000 is more bases than any account has.
    for (let i = 0; i < 20; i++) {
      const page = await ctx.client.get<{ bases?: { id: string; name: string; permissionLevel?: string }[]; offset?: string }>(
        '/v0/meta/bases',
        offset ? { offset } : undefined,
      );
      for (const b of page.bases ?? []) bases.push({ id: b.id, name: b.name, detail: { permissionLevel: b.permissionLevel ?? null } });
      offset = page.offset;
      if (!offset) break;
    }
    return bases;
  }

  private async listTables(ctx: AdapterContext, baseId: string): Promise<AirtableTable[]> {
    const res = await ctx.client.get<{ tables?: AirtableTable[] }>(`/v0/meta/bases/${encodeURIComponent(baseId)}/tables`);
    return (res.tables ?? []).map((t) => ({
      id: t.id,
      name: t.name,
      primaryFieldId: t.primaryFieldId,
      fields: (t.fields ?? []).map((f) => ({ id: f.id, name: f.name, type: f.type })),
    }));
  }
}
