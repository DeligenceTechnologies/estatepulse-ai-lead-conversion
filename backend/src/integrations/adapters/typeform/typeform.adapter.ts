import { Injectable, Logger } from '@nestjs/common';
import { LeadSourceProvider } from '@prisma/client';
import { AppError } from '@/common/errors/app-error';
import type {
  AccountIdentity,
  AdapterContext,
  AdapterImport,
  AdapterSetup,
  ImportPage,
  IntegrationAdapter,
  SetupResource,
  SetupState,
} from '../adapter.interface';
import { NangoError } from '../../nango/nango.service';
import {
  MAPPABLE,
  compatible,
  flattenForm,
  suggestFieldMap,
  toImportedRecord,
  type FieldMap,
  type MappableField,
  type TypeformFormDefinition,
  type TypeformQuestion,
  type TypeformResponse,
} from './typeform.mapping';

/**
 * Typeform forms through Nango. Nango's "typeform" provider (OAuth 2) proxies
 * to https://api.typeform.com and refreshes the token (it needs the `offline`
 * scope); this process never sees it.
 *
 * Endpoints (Typeform Create & Responses APIs):
 *  - GET /me                                                    who granted access
 *  - GET /forms?page=&page_size=                                forms the account can see (max 200 per page)
 *  - GET /forms/{formId}                                        the form definition (fields, hidden fields)
 *  - GET /forms/{formId}/responses?page_size=&before=&response_type=completed   responses, newest first
 *
 * Responses are paged with `before=<token of the last response read>`, which
 * Typeform does not allow together with `sort`; the default order is newest
 * first, so the run walks back in time until a short page. Typeform allows
 * 2 requests a second per account, so pages are as large as allowed (1000).
 * Nango's proxy retries 429s and 5xx; a revoked grant is REAUTH.
 *
 * Read-only: a response is a record of what the person sent, so lead changes
 * are never written back to Typeform. Partial responses are not imported.
 */

interface TypeformSettings {
  formId: string;
  formName: string;
  fieldMap: FieldMap;
}

interface TypeformFormSummary {
  id: string;
  title?: string | null;
  last_updated_at?: string;
  settings?: { is_public?: boolean };
}

interface Cursor {
  /** Token of the oldest response already read. */
  before: string;
}

/** Typeform form ids are short base62 strings ("u6nXL7"). */
const FORM_ID = /^[A-Za-z0-9]{3,32}$/;
const QUESTION_ID = /^(hidden:)?[A-Za-z0-9_-]{1,64}$/;
const RESPONSE_PAGE_SIZE = 1000;
const FORM_PAGE_SIZE = 200;
/** Bounded: 10 pages of 200 is more forms than any Typeform account has. */
const MAX_FORM_PAGES = 10;
const FORM_TTL_MS = 5 * 60_000;

/** The saved settings, or null when the owner has not finished setup. */
function readSettings(settings: Record<string, unknown>): TypeformSettings | null {
  const { formId, formName, fieldMap } = settings as Partial<TypeformSettings>;
  if (typeof formId !== 'string' || !FORM_ID.test(formId) || !fieldMap || typeof fieldMap !== 'object' || Array.isArray(fieldMap)) return null;
  const clean: FieldMap = {};
  for (const target of MAPPABLE) {
    const id = (fieldMap as Record<string, unknown>)[target];
    if (typeof id === 'string' && QUESTION_ID.test(id)) clean[target] = id;
  }
  return { formId, formName: String(formName ?? formId), fieldMap: clean };
}

const isNotFound = (error: unknown) => error instanceof NangoError && error.kind === 'REJECTED' && error.status === 404;

@Injectable()
export class TypeformAdapter implements IntegrationAdapter {
  private readonly logger = new Logger(TypeformAdapter.name);

  readonly provider = 'typeform';
  readonly displayName = 'Typeform';
  readonly description =
    'Turn Typeform responses into leads. Pick a form, check which field holds the name, email, phone and budget, and every completed response arrives as a lead.';
  readonly features = [
    'Sign in with Typeform; connect several accounts',
    'Choose the form your leads fill in',
    'Automatic field mapping you can adjust (name, email, phone, budget, bedrooms…), including contact-info blocks and hidden fields',
    'Answers to the other fields are kept on the lead as custom fields',
    'Only completed responses are imported; partial ones are ignored',
    'Re-syncs skip responses already imported; a person already in EstatePulse is never duplicated',
  ] as const;
  readonly capabilities = ['lead_import'] as const;
  readonly fallbackCategories = ['productivity', 'surveys'] as const;
  readonly requiredScopes = ['accounts:read', 'forms:read', 'responses:read', 'offline'] as const;
  readonly leadSourceProvider = LeadSourceProvider.TYPEFORM;

  async identify(ctx: AdapterContext): Promise<AccountIdentity> {
    try {
      const me = await ctx.client.get<{ alias?: string | null; email?: string | null; language?: string | null; user_id?: string | null }>('/me');
      return {
        accountName: me.email ?? me.alias ?? null,
        accountEmail: me.email ?? null,
        externalAccountId: me.user_id ?? null,
        metadata: { alias: me.alias ?? null, language: me.language ?? null },
      };
    } catch (error) {
      // A dead grant must fail the connect; anything else (e.g. no accounts:read) only costs us the label.
      if (error instanceof NangoError && error.kind === 'REAUTH') throw error;
      this.logger.warn(`Could not read the Typeform account: ${(error as Error).message}`);
      return { accountName: null, accountEmail: null, externalAccountId: null };
    }
  }

  async validateConnection(ctx: AdapterContext): Promise<boolean> {
    try {
      await ctx.client.get('/forms', { page: 1, page_size: 1 });
      return true;
    } catch (error) {
      if (error instanceof NangoError && error.kind === 'REAUTH') return false;
      throw error;
    }
  }

  readonly setup: AdapterSetup = {
    resourceKinds: ['forms', 'questions'],

    state: (settings): SetupState => {
      const s = readSettings(settings);
      if (!s) return { complete: false, missing: 'Choose the Typeform form your leads fill in.', summary: null };
      if (!s.fieldMap.email && !s.fieldMap.phone) {
        return { complete: false, missing: 'Map the email or phone field so leads can be contacted.', summary: s.formName };
      }
      return { complete: true, missing: null, summary: s.formName };
    },

    listResources: async (ctx, kind, parentId): Promise<SetupResource[]> => {
      if (kind === 'forms') {
        const forms = await this.listForms(ctx);
        return forms
          .map((f) => ({
            id: f.id,
            name: f.title?.trim() || 'Untitled form',
            detail: {
              // Same shape as Tally's, so the setup screen reads both; Typeform has no drafts or counts here.
              status: null,
              submissions: null,
              closed: f.settings?.is_public === false,
              updatedAt: f.last_updated_at ?? null,
            },
          }))
          .sort((a, b) => String(b.detail.updatedAt ?? '').localeCompare(String(a.detail.updatedAt ?? '')));
      }
      if (kind === 'questions') {
        if (!parentId || !FORM_ID.test(parentId)) throw new AppError('VALIDATION_ERROR', 'Choose a form first.');
        const { questions } = await this.formFor(ctx, parentId, { fresh: true });
        const suggested = suggestFieldMap(questions);
        const suggestedFor = new Map(Object.entries(suggested).map(([target, id]) => [id, target]));
        return questions.map((q) => ({
          id: q.id,
          name: q.title,
          detail: {
            type: q.type,
            targets: MAPPABLE.filter((t) => compatible(q.type, t)),
            suggested: suggestedFor.get(q.id) ?? null,
          },
        }));
      }
      throw new AppError('VALIDATION_ERROR', `Typeform has no "${kind}" to list.`);
    },

    saveSettings: async (ctx, input) => {
      const formId = typeof input.formId === 'string' ? input.formId.trim() : '';
      if (!FORM_ID.test(formId)) throw new AppError('VALIDATION_ERROR', 'Choose a form.');

      // Re-read from Typeform: the form must be one this grant can see, never trusted from the browser.
      const { title, questions } = await this.formFor(ctx, formId, { fresh: true });

      const rawMap = input.fieldMap;
      const requested =
        rawMap && typeof rawMap === 'object' && !Array.isArray(rawMap) ? (rawMap as Record<string, unknown>) : suggestFieldMap(questions);
      const fieldMap: FieldMap = {};
      const used = new Map<string, string>();
      for (const [target, questionId] of Object.entries(requested)) {
        if (questionId === null || questionId === undefined || questionId === '') continue;
        if (!(MAPPABLE as readonly string[]).includes(target)) throw new AppError('VALIDATION_ERROR', `Unknown lead field "${target}".`);
        const question = typeof questionId === 'string' ? questions.find((q) => q.id === questionId) : undefined;
        if (!question) throw new AppError('VALIDATION_ERROR', `The field mapped to ${target} is not in "${title}" any more.`);
        if (!compatible(question.type, target as MappableField)) {
          throw new AppError('VALIDATION_ERROR', `"${question.title}" cannot be used as ${target}.`);
        }
        const other = used.get(question.id);
        if (other) throw new AppError('VALIDATION_ERROR', `"${question.title}" is mapped to both ${other} and ${target}. Use each field once.`);
        used.set(question.id, target);
        fieldMap[target as MappableField] = question.id;
      }
      if (!fieldMap.email && !fieldMap.phone) {
        throw new AppError('VALIDATION_ERROR', 'Map the email or phone field so leads can be contacted.');
      }

      const settings: TypeformSettings = { formId, formName: title, fieldMap };
      return { ...settings };
    },
  };

  readonly import: AdapterImport<Cursor> = {
    sourceName: (settings) => {
      const s = readSettings(settings);
      return s ? `Typeform · ${s.formName}` : 'Typeform';
    },

    fetchPage: async (ctx, cursor): Promise<ImportPage<Cursor>> => {
      const s = readSettings(ctx.settings);
      if (!s) throw new AppError('CONFLICT', 'Finish the Typeform setup (form and field mapping) before syncing.');

      let res: { items?: TypeformResponse[] };
      try {
        res = await ctx.client.get('/forms/' + encodeURIComponent(s.formId) + '/responses', {
          page_size: RESPONSE_PAGE_SIZE,
          response_type: 'completed',
          ...(cursor?.before ? { before: cursor.before } : {}),
        });
      } catch (error) {
        if (isNotFound(error)) {
          throw new AppError('CONFLICT', `The Typeform form "${s.formName}" was deleted, or this account can no longer see it. Choose another form.`);
        }
        throw error;
      }

      const { questions } = await this.formFor(ctx, s.formId);
      const items = res.items ?? [];
      const responses = items.filter(
        (r): r is TypeformResponse => Boolean(r && (r.response_id || r.token) && r.submitted_at),
      );

      // A mapped field deleted from the form leaves its lead field empty; say so once per run, do not fail it.
      if (!cursor) {
        const live = new Set(questions.map((q) => q.id));
        const gone = Object.entries(s.fieldMap).filter(([, id]) => !live.has(id!));
        if (gone.length) {
          this.logger.warn(
            `Typeform form ${s.formId} (connection ${ctx.connectionId}): mapped field(s) for ${gone.map(([t]) => t).join(', ')} no longer exist`,
          );
        }
      }

      // A full page may have more behind it; a short one is the oldest. The token must move, so a stuck page can never loop.
      const last = items[items.length - 1]?.token;
      const more = items.length >= RESPONSE_PAGE_SIZE && typeof last === 'string' && last !== cursor?.before;
      return {
        records: responses.map((r) => toImportedRecord(r, s.formId, questions, s.fieldMap)),
        next: more ? { before: last } : null,
      };
    },
  };

  /** Short-lived cache: the form is read once for a setup screen and its save, and once per sync run, not per page. */
  private readonly formCache = new Map<string, { at: number; title: string; questions: TypeformQuestion[] }>();

  private async formFor(ctx: AdapterContext, formId: string, opts: { fresh?: boolean } = {}): Promise<{ title: string; questions: TypeformQuestion[] }> {
    const key = `${ctx.connectionId}:${formId}`;
    const hit = this.formCache.get(key);
    if (!opts.fresh && hit && Date.now() - hit.at < FORM_TTL_MS) return hit;
    let form: TypeformFormDefinition;
    try {
      form = await ctx.client.get<TypeformFormDefinition>(`/forms/${encodeURIComponent(formId)}`);
    } catch (error) {
      if (isNotFound(error)) throw new AppError('CONFLICT', 'That Typeform form was deleted, or this account can no longer see it.');
      throw error;
    }
    const entry = { at: Date.now(), title: form.title?.trim() || 'Untitled form', questions: flattenForm(form) };
    this.formCache.set(key, entry);
    if (this.formCache.size > 500) this.formCache.delete(this.formCache.keys().next().value!);
    return entry;
  }

  private async listForms(ctx: AdapterContext): Promise<TypeformFormSummary[]> {
    const forms: TypeformFormSummary[] = [];
    for (let page = 1; page <= MAX_FORM_PAGES; page++) {
      const res = await ctx.client.get<{ items?: TypeformFormSummary[]; page_count?: number }>('/forms', { page, page_size: FORM_PAGE_SIZE });
      const items = (res.items ?? []).filter((f) => f && typeof f.id === 'string');
      forms.push(...items);
      if (!items.length || page >= (res.page_count ?? 1)) break;
    }
    return forms;
  }
}
