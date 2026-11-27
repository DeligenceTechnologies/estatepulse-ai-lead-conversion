import { Injectable, Logger } from '@nestjs/common';
import { LeadSourceProvider } from '@prisma/client';
import { AppError } from '@/common/errors/app-error';
import type {
  AccountIdentity,
  AdapterContext,
  AdapterImport,
  AdapterSetup,
  ImportPage,
  ImportedRecord,
  IntegrationAdapter,
  SetupResource,
  SetupState,
} from '../adapter.interface';
import { NangoError } from '../../nango/nango.service';
import { MAPPABLE, readHeader, suggestFieldMap, toImportedRecord, type FieldMap, type MappableField, type SheetColumn } from './google-sheets.mapping';

/**
 * Google Sheets through Nango. Nango's "google-sheet" provider (OAuth 2)
 * proxies to https://sheets.googleapis.com and refreshes the token; this
 * process never sees it.
 *
 * Endpoints (Sheets API v4):
 *  - GET /v4/spreadsheets/{id}?fields=…               title and tabs (id, title, row count)
 *  - GET /v4/spreadsheets/{id}/values/{range}          cells, as the owner sees them (FORMATTED_VALUE)
 *  - GET https://www.googleapis.com/oauth2/v3/userinfo  who granted access (best effort)
 *
 * No Drive scope: listing a user's files needs a restricted Drive scope and a
 * Google security review. The owner pastes the spreadsheet link instead;
 * `spreadsheets.readonly` reads any sheet their Google account can open.
 *
 * Settings keep the tab's numeric `sheetId`, not its title, so renaming the
 * tab keeps the sync working. Row 1 is the header. Google allows 60 reads a
 * minute per user; a run reads 2000 rows per request. Read-only: nothing is
 * written back to the sheet (see the mapping for why rows are keyed by email/phone).
 */

interface SheetsSettings {
  spreadsheetId: string;
  spreadsheetName: string;
  sheetId: number;
  sheetTitle: string;
  fieldMap: FieldMap;
}

interface TabProperties {
  sheetId?: number;
  title?: string;
  index?: number;
  sheetType?: string;
  hidden?: boolean;
  gridProperties?: { rowCount?: number; columnCount?: number };
}

interface SpreadsheetMeta {
  title: string;
  tabs: { sheetId: number; title: string; rowCount: number; hidden: boolean }[];
}

interface Cursor {
  /** 1-based sheet row the next page starts at. */
  row: number;
}

const SPREADSHEET_ID = /^[A-Za-z0-9_-]{20,100}$/;
const COLUMN_KEY_MAX = 120;
const ROW_PAGE_SIZE = 2000;
const META_TTL_MS = 5 * 60_000;
const USERINFO_BASE = 'https://www.googleapis.com';

/** A pasted link or a bare id -> the spreadsheet id, or null. */
export function spreadsheetIdFrom(input: string): string | null {
  const trimmed = input.trim();
  const fromUrl = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(trimmed)?.[1];
  const id = fromUrl ?? trimmed;
  return SPREADSHEET_ID.test(id) ? id : null;
}

/** A tab title in A1 notation: always quoted, a quote inside doubled. */
const a1Tab = (title: string) => `'${title.replace(/'/g, "''")}'`;

function readSettings(settings: Record<string, unknown>): SheetsSettings | null {
  const { spreadsheetId, spreadsheetName, sheetId, sheetTitle, fieldMap } = settings as Partial<SheetsSettings>;
  if (typeof spreadsheetId !== 'string' || !SPREADSHEET_ID.test(spreadsheetId)) return null;
  if (typeof sheetId !== 'number' || !Number.isInteger(sheetId) || sheetId < 0) return null;
  if (!fieldMap || typeof fieldMap !== 'object' || Array.isArray(fieldMap)) return null;
  const clean: FieldMap = {};
  for (const target of MAPPABLE) {
    const key = (fieldMap as Record<string, unknown>)[target];
    if (typeof key === 'string' && key.length > 0 && key.length <= COLUMN_KEY_MAX) clean[target] = key;
  }
  return {
    spreadsheetId,
    sheetId,
    spreadsheetName: String(spreadsheetName ?? spreadsheetId),
    sheetTitle: String(sheetTitle ?? sheetId),
    fieldMap: clean,
  };
}

const status = (error: unknown) => (error instanceof NangoError && error.kind === 'REJECTED' ? error.status : null);

@Injectable()
export class GoogleSheetsAdapter implements IntegrationAdapter {
  private readonly logger = new Logger(GoogleSheetsAdapter.name);

  readonly provider = 'google-sheet';
  readonly displayName = 'Google Sheets';
  readonly description =
    'Import leads from any Google Sheet. Paste the sheet link, pick the tab, check which column holds the name, email, phone and budget, and every row arrives as a lead.';
  readonly features = [
    'Sign in with Google; connect several Google accounts',
    'Works with any spreadsheet the account can open: paste its link',
    'Automatic column mapping from the header row, which you can adjust',
    'Other columns are kept on the lead as custom fields',
    'Rows are matched by email or phone, so sorting or inserting rows never mixes leads up',
    'Re-syncs skip unchanged rows; a person already in EstatePulse is never duplicated',
  ] as const;
  readonly capabilities = ['lead_import', 'tables'] as const;
  readonly fallbackCategories = ['productivity'] as const;
  readonly requiredScopes = ['https://www.googleapis.com/auth/spreadsheets.readonly', 'openid', 'email'] as const;
  readonly leadSourceProvider = LeadSourceProvider.GOOGLE_SHEETS;

  async identify(ctx: AdapterContext): Promise<AccountIdentity> {
    try {
      const me = await ctx.client.get<{ sub?: string; email?: string; name?: string }>('/oauth2/v3/userinfo', undefined, {
        baseUrlOverride: USERINFO_BASE,
      });
      return {
        accountName: me.email ?? me.name ?? null,
        accountEmail: me.email ?? null,
        externalAccountId: me.sub ?? null,
        metadata: { name: me.name ?? null },
      };
    } catch (error) {
      // A dead grant must fail the connect; a missing email scope only costs us the label.
      if (error instanceof NangoError && error.kind === 'REAUTH') throw error;
      this.logger.warn(`Could not read the Google account: ${(error as Error).message}`);
      return { accountName: null, accountEmail: null, externalAccountId: null };
    }
  }

  async validateConnection(ctx: AdapterContext): Promise<boolean> {
    const s = readSettings(ctx.settings);
    try {
      if (s) await this.metaFor(ctx, s.spreadsheetId, { fresh: true });
      else await ctx.client.get('/oauth2/v3/userinfo', undefined, { baseUrlOverride: USERINFO_BASE });
      return true;
    } catch (error) {
      if (error instanceof NangoError && error.kind === 'REAUTH') return false;
      throw error;
    }
  }

  readonly setup: AdapterSetup = {
    // tabs: parentId = spreadsheet id. columns: parentId = "<spreadsheetId>.<sheetId>".
    resourceKinds: ['tabs', 'columns'],

    state: (settings): SetupState => {
      const s = readSettings(settings);
      if (!s) return { complete: false, missing: 'Paste the link of the Google Sheet your leads are in and choose the tab.', summary: null };
      const summary = `${s.spreadsheetName} · ${s.sheetTitle}`;
      if (!s.fieldMap.email && !s.fieldMap.phone) return { complete: false, missing: 'Map the email or phone column so leads can be contacted.', summary };
      return { complete: true, missing: null, summary };
    },

    listResources: async (ctx, kind, parentId): Promise<SetupResource[]> => {
      if (kind === 'tabs') {
        const spreadsheetId = parentId ? spreadsheetIdFrom(parentId) : null;
        if (!spreadsheetId) throw new AppError('VALIDATION_ERROR', 'Paste the link of a Google Sheet.');
        const meta = await this.metaFor(ctx, spreadsheetId, { fresh: true });
        return meta.tabs.map((t) => ({
          id: String(t.sheetId),
          name: t.title,
          detail: { spreadsheetName: meta.title, rows: t.rowCount, hidden: t.hidden },
        }));
      }
      if (kind === 'columns') {
        const [rawId, rawSheet] = (parentId ?? '').split('.');
        const spreadsheetId = rawId ? spreadsheetIdFrom(rawId) : null;
        const sheetId = Number(rawSheet);
        if (!spreadsheetId || !Number.isInteger(sheetId) || sheetId < 0) throw new AppError('VALIDATION_ERROR', 'Choose a tab first.');
        const { columns } = await this.headerFor(ctx, spreadsheetId, sheetId, { fresh: true });
        const suggested = suggestFieldMap(columns);
        const suggestedFor = new Map(Object.entries(suggested).map(([target, key]) => [key, target]));
        return columns.map((c) => ({
          id: c.key,
          name: c.key,
          // Same shape as Tally's questions, so the mapping grid reads both. A sheet has no column types: every column fits every field.
          detail: { type: 'column', targets: [...MAPPABLE], suggested: suggestedFor.get(c.key) ?? null },
        }));
      }
      throw new AppError('VALIDATION_ERROR', `Google Sheets has no "${kind}" to list.`);
    },

    saveSettings: async (ctx, input) => {
      const spreadsheetId = typeof input.spreadsheetId === 'string' ? spreadsheetIdFrom(input.spreadsheetId) : null;
      const sheetId = typeof input.sheetId === 'number' ? input.sheetId : Number(input.sheetId);
      if (!spreadsheetId) throw new AppError('VALIDATION_ERROR', 'Paste the link of a Google Sheet.');
      if (!Number.isInteger(sheetId) || sheetId < 0) throw new AppError('VALIDATION_ERROR', 'Choose a tab.');

      // Re-read from Google: the sheet must be one this account can open, never trusted from the browser.
      const { meta, tab, columns } = await this.headerFor(ctx, spreadsheetId, sheetId, { fresh: true });
      if (!columns.length) throw new AppError('VALIDATION_ERROR', `Row 1 of "${tab.title}" is empty. Put the column names (Name, Email, Phone…) in row 1.`);

      const rawMap = input.fieldMap;
      const requested = rawMap && typeof rawMap === 'object' && !Array.isArray(rawMap) ? (rawMap as Record<string, unknown>) : suggestFieldMap(columns);
      const fieldMap: FieldMap = {};
      const used = new Map<string, string>();
      for (const [target, key] of Object.entries(requested)) {
        if (key === null || key === undefined || key === '') continue;
        if (!(MAPPABLE as readonly string[]).includes(target)) throw new AppError('VALIDATION_ERROR', `Unknown lead field "${target}".`);
        const column = typeof key === 'string' ? columns.find((c) => c.key === key) : undefined;
        if (!column) throw new AppError('VALIDATION_ERROR', `The column mapped to ${target} is not in row 1 of "${tab.title}" any more.`);
        const other = used.get(column.key);
        if (other) throw new AppError('VALIDATION_ERROR', `"${column.key}" is mapped to both ${other} and ${target}. Use each column once.`);
        used.set(column.key, target);
        fieldMap[target as MappableField] = column.key;
      }
      if (!fieldMap.email && !fieldMap.phone) throw new AppError('VALIDATION_ERROR', 'Map the email or phone column so leads can be contacted.');

      const settings: SheetsSettings = { spreadsheetId, spreadsheetName: meta.title, sheetId, sheetTitle: tab.title, fieldMap };
      return { ...settings };
    },
  };

  readonly import: AdapterImport<Cursor> = {
    sourceName: (settings) => {
      const s = readSettings(settings);
      return s ? `Google Sheets · ${s.sheetTitle}` : 'Google Sheets';
    },

    fetchPage: async (ctx, cursor): Promise<ImportPage<Cursor>> => {
      const s = readSettings(ctx.settings);
      if (!s) throw new AppError('CONFLICT', 'Finish the Google Sheets setup (sheet, tab and column mapping) before syncing.');

      // Header and tab title are read on the first page of a run (a renamed tab is found by its id) and reused after.
      const { tab, columns } = await this.headerFor(ctx, s.spreadsheetId, s.sheetId, { fresh: !cursor });
      if (!cursor) {
        const live = new Set(columns.map((c) => c.key));
        const gone = Object.entries(s.fieldMap).filter(([, key]) => !live.has(key!));
        if (gone.length) {
          this.logger.warn(
            `Sheet ${s.spreadsheetId}/${s.sheetId} (connection ${ctx.connectionId}): mapped column(s) for ${gone.map(([t]) => t).join(', ')} not in the header any more`,
          );
        }
        if (!live.has(s.fieldMap.email ?? '') && !live.has(s.fieldMap.phone ?? '')) {
          throw new AppError('CONFLICT', `The email and phone columns of "${tab.title}" were renamed or removed. Check the column mapping.`);
        }
      }

      const start = cursor?.row ?? 2;
      const end = start + ROW_PAGE_SIZE - 1;
      const res = await this.values(ctx, s.spreadsheetId, `${a1Tab(tab.title)}!${start}:${end}`);
      const rows = res.values ?? [];

      const objectType = `google-sheets:${s.spreadsheetId}:${s.sheetId}`;
      const records: ImportedRecord[] = [];
      const seen = new Set<string>();
      rows.forEach((row, i) => {
        const record = Array.isArray(row) ? toImportedRecord(row, start + i, objectType, columns, s.fieldMap) : null;
        // The same person twice on one page: the first row wins; a later page's copy just updates it.
        if (!record || seen.has(record.externalId)) return;
        seen.add(record.externalId);
        records.push(record);
      });

      // Google drops trailing blank rows, so a short page is not the end when blank rows sit mid-sheet: the tab's row count is.
      return { records, next: end < tab.rowCount ? { row: end + 1 } : null };
    },
  };

  private readonly metaCache = new Map<string, { at: number; meta: SpreadsheetMeta }>();
  private readonly headerCache = new Map<string, { at: number; columns: SheetColumn[] }>();

  private async metaFor(ctx: AdapterContext, spreadsheetId: string, opts: { fresh?: boolean } = {}): Promise<SpreadsheetMeta> {
    const key = `${ctx.connectionId}:${spreadsheetId}`;
    const hit = this.metaCache.get(key);
    if (!opts.fresh && hit && Date.now() - hit.at < META_TTL_MS) return hit.meta;
    let res: { properties?: { title?: string }; sheets?: { properties?: TabProperties }[] };
    try {
      res = await ctx.client.get(`/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`, {
        fields: 'properties.title,sheets.properties(sheetId,title,index,sheetType,hidden,gridProperties(rowCount,columnCount))',
      });
    } catch (error) {
      throw this.explain(error);
    }
    const meta: SpreadsheetMeta = {
      title: res.properties?.title?.trim() || 'Untitled spreadsheet',
      tabs: (res.sheets ?? [])
        .map((sh) => sh.properties)
        // Chart sheets and other non-grid tabs have no cells to read.
        .filter((p): p is TabProperties => Boolean(p && typeof p.sheetId === 'number' && typeof p.title === 'string' && (p.sheetType ?? 'GRID') === 'GRID'))
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((p) => ({ sheetId: p.sheetId!, title: p.title!, rowCount: p.gridProperties?.rowCount ?? 1000, hidden: Boolean(p.hidden) })),
    };
    this.metaCache.set(key, { at: Date.now(), meta });
    if (this.metaCache.size > 500) this.metaCache.delete(this.metaCache.keys().next().value!);
    return meta;
  }

  private async headerFor(
    ctx: AdapterContext,
    spreadsheetId: string,
    sheetId: number,
    opts: { fresh?: boolean } = {},
  ): Promise<{ meta: SpreadsheetMeta; tab: SpreadsheetMeta['tabs'][number]; columns: SheetColumn[] }> {
    const meta = await this.metaFor(ctx, spreadsheetId, opts);
    const tab = meta.tabs.find((t) => t.sheetId === sheetId);
    if (!tab) throw new AppError('CONFLICT', `That tab is no longer in "${meta.title}". Choose another tab.`);
    const key = `${ctx.connectionId}:${spreadsheetId}:${sheetId}`;
    const hit = this.headerCache.get(key);
    if (!opts.fresh && hit && Date.now() - hit.at < META_TTL_MS) return { meta, tab, columns: hit.columns };
    const res = await this.values(ctx, spreadsheetId, `${a1Tab(tab.title)}!1:1`);
    const columns = readHeader(res.values?.[0]);
    this.headerCache.set(key, { at: Date.now(), columns });
    if (this.headerCache.size > 500) this.headerCache.delete(this.headerCache.keys().next().value!);
    return { meta, tab, columns };
  }

  private async values(ctx: AdapterContext, spreadsheetId: string, range: string): Promise<{ values?: unknown[][] }> {
    try {
      return await ctx.client.get(`/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`, {
        // What the owner sees: a phone typed as text keeps its "+", a budget keeps its formatting.
        valueRenderOption: 'FORMATTED_VALUE',
        majorDimension: 'ROWS',
      });
    } catch (error) {
      throw this.explain(error);
    }
  }

  /** Google's 403/404 on a sheet as something the owner can act on. */
  private explain(error: unknown): unknown {
    const code = status(error);
    if (code === 404) return new AppError('CONFLICT', 'That Google Sheet was not found. Check the link, or it was deleted.');
    if (code === 403) {
      return new AppError('CONFLICT', 'This Google account cannot open that sheet. Share the sheet with it, or connect the account that owns it.');
    }
    return error;
  }
}
