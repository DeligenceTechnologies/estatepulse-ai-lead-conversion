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
  answerable,
  compatible,
  questionTitle,
  suggestFieldMap,
  toImportedRecord,
  type FieldMap,
  type MappableField,
  type TallyQuestion,
  type TallySubmission,
} from './tally.mapping';

/**
 * Tally forms through Nango. Nango's "tally" provider (API_KEY) proxies to
 * https://api.tally.so and adds `Authorization: Bearer <key>`; this process
 * never sees the key. A key has no scopes: it can do what its user can.
 *
 * Endpoints (Tally API):
 *  - GET /users/me                                           who the key belongs to
 *  - GET /forms?page=&limit=                                 forms the user can see (max 500 per page)
 *  - GET /forms/{formId}/questions                           the form's questions
 *  - GET /forms/{formId}/submissions?page=&limit=&filter=completed   submissions, with the questions
 *
 * Tally allows 100 requests a minute per key, so pages are as large as Tally
 * allows (500). Nango's proxy retries 429s and 5xx; a revoked key is a 401,
 * which Nango reports as REAUTH and the connection asks for a new key.
 *
 * Read-only: a form submission is a record of what the person sent, so lead
 * changes are never written back to Tally. Partial (unfinished) submissions
 * are not imported: the person never pressed submit.
 */

interface TallySettings {
  formId: string;
  formName: string;
  fieldMap: FieldMap;
}

interface TallyForm {
  id: string;
  name?: string | null;
  workspaceId?: string;
  status?: string;
  numberOfSubmissions?: number;
  isClosed?: boolean;
  updatedAt?: string;
}

interface Cursor {
  page: number;
}

/** Tally form ids are short base62 strings ("w2ZXy9"). */
const FORM_ID = /^[A-Za-z0-9]{3,32}$/;
const QUESTION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SUBMISSION_PAGE_SIZE = 500;
const FORM_PAGE_SIZE = 500;
/** Bounded: 10 pages of 500 is more forms than any Tally account has. */
const MAX_FORM_PAGES = 10;
const QUESTIONS_TTL_MS = 5 * 60_000;

/** The saved settings, or null when the owner has not finished setup. */
function readSettings(settings: Record<string, unknown>): TallySettings | null {
  const { formId, formName, fieldMap } = settings as Partial<TallySettings>;
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
export class TallyAdapter implements IntegrationAdapter {
  private readonly logger = new Logger(TallyAdapter.name);

  readonly provider = 'tally';
  readonly displayName = 'Tally';
  readonly description =
    'Turn Tally form submissions into leads. Pick a form, check which question holds the name, email, phone and budget, and every submission arrives as a lead.';
  readonly features = [
    'Connect several Tally accounts with an API key',
    'Choose the form your leads fill in',
    'Automatic question mapping you can adjust (name, email, phone, budget, bedrooms…)',
    'Answers to the other questions are kept on the lead as custom fields',
    'Only completed submissions are imported; unfinished ones are ignored',
    'Re-syncs skip submissions already imported; a person already in EstatePulse is never duplicated',
  ] as const;
  readonly capabilities = ['lead_import'] as const;
  readonly fallbackCategories = ['productivity', 'surveys'] as const;
  /** API keys have no scopes; the key's user must be able to see the form. */
  readonly requiredScopes = [] as const;
  readonly leadSourceProvider = LeadSourceProvider.TALLY;

  async identify(ctx: AdapterContext): Promise<AccountIdentity> {
    try {
      const me = await ctx.client.get<{
        id?: string;
        fullName?: string | null;
        firstName?: string | null;
        lastName?: string | null;
        email?: string | null;
        organizationId?: string | null;
        subscriptionPlan?: string | null;
      }>('/users/me');
      const name = me.fullName?.trim() || [me.firstName, me.lastName].filter(Boolean).join(' ').trim() || null;
      return {
        accountName: me.email ?? name,
        accountEmail: me.email ?? null,
        externalAccountId: me.id ?? null,
        metadata: { name, organizationId: me.organizationId ?? null, plan: me.subscriptionPlan ?? null },
      };
    } catch (error) {
      // A dead key must fail the connect; anything else only costs us the label.
      if (error instanceof NangoError && error.kind === 'REAUTH') throw error;
      this.logger.warn(`Could not read the Tally account: ${(error as Error).message}`);
      return { accountName: null, accountEmail: null, externalAccountId: null };
    }
  }

  async validateConnection(ctx: AdapterContext): Promise<boolean> {
    try {
      await ctx.client.get('/forms', { page: 1, limit: 1 });
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
      if (!s) return { complete: false, missing: 'Choose the Tally form your leads fill in.', summary: null };
      if (!s.fieldMap.email && !s.fieldMap.phone) {
        return { complete: false, missing: 'Map the email or phone question so leads can be contacted.', summary: s.formName };
      }
      return { complete: true, missing: null, summary: s.formName };
    },

    listResources: async (ctx, kind, parentId): Promise<SetupResource[]> => {
      if (kind === 'forms') {
        const forms = await this.listForms(ctx);
        return forms
          .filter((f) => f.status !== 'BLANK')
          .map((f) => ({
            id: f.id,
            name: f.name?.trim() || 'Untitled form',
            detail: {
              status: f.status ?? null,
              submissions: typeof f.numberOfSubmissions === 'number' ? f.numberOfSubmissions : null,
              closed: Boolean(f.isClosed),
              workspaceId: f.workspaceId ?? null,
              updatedAt: f.updatedAt ?? null,
            },
          }))
          .sort((a, b) => String(b.detail.updatedAt ?? '').localeCompare(String(a.detail.updatedAt ?? '')));
      }
      if (kind === 'questions') {
        if (!parentId || !FORM_ID.test(parentId)) throw new AppError('VALIDATION_ERROR', 'Choose a form first.');
        const questions = await this.questionsFor(ctx, parentId, { fresh: true });
        const suggested = suggestFieldMap(questions);
        const suggestedFor = new Map(Object.entries(suggested).map(([target, id]) => [id, target]));
        return answerable(questions).map((q) => ({
          id: q.id,
          name: questionTitle(q),
          detail: {
            type: q.type,
            targets: MAPPABLE.filter((t) => compatible(q.type, t)),
            suggested: suggestedFor.get(q.id) ?? null,
          },
        }));
      }
      throw new AppError('VALIDATION_ERROR', `Tally has no "${kind}" to list.`);
    },

    saveSettings: async (ctx, input) => {
      const formId = typeof input.formId === 'string' ? input.formId.trim() : '';
      if (!FORM_ID.test(formId)) throw new AppError('VALIDATION_ERROR', 'Choose a form.');

      // Re-read from Tally: the form must be one this key can see, never trusted from the browser.
      const form = (await this.listForms(ctx)).find((f) => f.id === formId);
      if (!form) throw new AppError('VALIDATION_ERROR', 'That form is not in this Tally account, or its user cannot see it.');
      const questions = answerable(await this.questionsFor(ctx, formId, { fresh: true }));

      const rawMap = input.fieldMap;
      const requested =
        rawMap && typeof rawMap === 'object' && !Array.isArray(rawMap) ? (rawMap as Record<string, unknown>) : suggestFieldMap(questions);
      const fieldMap: FieldMap = {};
      const used = new Map<string, string>();
      for (const [target, questionId] of Object.entries(requested)) {
        if (questionId === null || questionId === undefined || questionId === '') continue;
        if (!(MAPPABLE as readonly string[]).includes(target)) throw new AppError('VALIDATION_ERROR', `Unknown lead field "${target}".`);
        const question = typeof questionId === 'string' ? questions.find((q) => q.id === questionId) : undefined;
        if (!question) throw new AppError('VALIDATION_ERROR', `The question mapped to ${target} is not in "${form.name ?? formId}" any more.`);
        if (!compatible(question.type, target as MappableField)) {
          throw new AppError('VALIDATION_ERROR', `"${questionTitle(question)}" cannot be used as ${target}.`);
        }
        // Full name and first name may not share a question; neither may any other pair.
        const other = used.get(question.id);
        if (other) throw new AppError('VALIDATION_ERROR', `"${questionTitle(question)}" is mapped to both ${other} and ${target}. Use each question once.`);
        used.set(question.id, target);
        fieldMap[target as MappableField] = question.id;
      }
      if (!fieldMap.email && !fieldMap.phone) {
        throw new AppError('VALIDATION_ERROR', 'Map the email or phone question so leads can be contacted.');
      }

      const settings: TallySettings = { formId, formName: form.name?.trim() || 'Untitled form', fieldMap };
      return { ...settings };
    },
  };

  readonly import: AdapterImport<Cursor> = {
    sourceName: (settings) => {
      const s = readSettings(settings);
      return s ? `Tally · ${s.formName}` : 'Tally';
    },

    fetchPage: async (ctx, cursor): Promise<ImportPage<Cursor>> => {
      const s = readSettings(ctx.settings);
      if (!s) throw new AppError('CONFLICT', 'Finish the Tally setup (form and question mapping) before syncing.');
      const page = cursor?.page ?? 1;

      let res: { hasMore?: boolean; questions?: TallyQuestion[]; submissions?: TallySubmission[] };
      try {
        res = await ctx.client.get('/forms/' + encodeURIComponent(s.formId) + '/submissions', {
          page,
          limit: SUBMISSION_PAGE_SIZE,
          filter: 'completed',
        });
      } catch (error) {
        if (isNotFound(error)) {
          throw new AppError('CONFLICT', `The Tally form "${s.formName}" was deleted, or this API key can no longer see it. Choose another form.`);
        }
        throw error;
      }

      // Every page carries the form's questions; fall back to a separate read only if Tally left them out.
      const questions = Array.isArray(res.questions) && res.questions.length ? res.questions : await this.questionsFor(ctx, s.formId);
      const submissions = (res.submissions ?? []).filter(
        (sub): sub is TallySubmission => Boolean(sub && typeof sub.id === 'string' && sub.id) && sub.isCompleted !== false,
      );

      // A mapped question deleted from the form leaves its lead field empty; say so once per run, do not fail it.
      if (page === 1) {
        const live = new Set(answerable(questions).map((q) => q.id));
        const gone = Object.entries(s.fieldMap).filter(([, id]) => !live.has(id!));
        if (gone.length) {
          this.logger.warn(
            `Tally form ${s.formId} (connection ${ctx.connectionId}): mapped question(s) for ${gone.map(([t]) => t).join(', ')} no longer exist`,
          );
        }
      }

      return {
        records: submissions.map((sub) => toImportedRecord(sub, s.formId, questions, s.fieldMap)),
        // `hasMore` is authoritative; a short page also ends the run, so a missing flag can never loop forever.
        next: res.hasMore && (res.submissions?.length ?? 0) > 0 ? { page: page + 1 } : null,
      };
    },
  };

  /** Short-lived cache: the questions are read once for a setup screen and its save, not per page. */
  private readonly questionCache = new Map<string, { at: number; questions: TallyQuestion[] }>();

  private async questionsFor(ctx: AdapterContext, formId: string, opts: { fresh?: boolean } = {}): Promise<TallyQuestion[]> {
    const key = `${ctx.connectionId}:${formId}`;
    const hit = this.questionCache.get(key);
    if (!opts.fresh && hit && Date.now() - hit.at < QUESTIONS_TTL_MS) return hit.questions;
    let res: { questions?: TallyQuestion[] };
    try {
      res = await ctx.client.get(`/forms/${encodeURIComponent(formId)}/questions`);
    } catch (error) {
      if (isNotFound(error)) throw new AppError('CONFLICT', 'That Tally form was deleted, or this API key can no longer see it.');
      throw error;
    }
    const questions = (res.questions ?? [])
      .filter((q) => q && typeof q.id === 'string' && typeof q.type === 'string')
      .map((q) => ({
        id: q.id,
        type: q.type,
        title: typeof q.title === 'string' ? q.title : null,
        isDeleted: Boolean(q.isDeleted),
        fields: Array.isArray(q.fields) ? q.fields.map((f) => ({ uuid: f.uuid, type: f.type, title: typeof f.title === 'string' ? f.title : null })) : [],
      }));
    this.questionCache.set(key, { at: Date.now(), questions });
    if (this.questionCache.size > 500) this.questionCache.delete(this.questionCache.keys().next().value!);
    return questions;
  }

  private async listForms(ctx: AdapterContext): Promise<TallyForm[]> {
    const forms: TallyForm[] = [];
    for (let page = 1; page <= MAX_FORM_PAGES; page++) {
      const res = await ctx.client.get<{ items?: TallyForm[]; hasMore?: boolean }>('/forms', { page, limit: FORM_PAGE_SIZE });
      const items = (res.items ?? []).filter((f) => f && typeof f.id === 'string');
      forms.push(...items);
      if (!res.hasMore || !items.length) break;
    }
    return forms;
  }
}
