import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AirtableApiError,
  DEFAULT_SCOPES,
  REQUIRED_SCOPES,
  type AirtableAccount,
  type AirtableBase,
  type AirtableField,
  type AirtableRecord,
  type AirtableTable,
  type AirtableWebhookPayload,
} from './types';

/**
 * Everything that talks to Airtable's API, with an access token Nango issued
 * (the "airtable" integration owns the OAuth flow and the rotating refresh
 * token). Bare `fetch`, like google.client.ts and hubspot.client.ts, so the
 * pacing, retries and error classification below stay ours.
 *
 * Endpoints and limits verified against the Web API documentation on
 * 2026-11-13:
 *  - whoami     GET  https://api.airtable.com/v0/meta/whoami
 *  - rate limit 5 requests/second/base, 429 then "wait 30 seconds"
 *
 * Airtable documents NO token revocation endpoint, so disconnect deletes the
 * Nango connection and the grant lapses (60 days unused). The owner can also
 * remove the integration from their Airtable account settings.
 */

/** In-request retries for a transient failure; anything longer is the sync's backoff. */
const MAX_ATTEMPTS = 3;
/** A wait longer than this is handed back to the caller instead of slept through. */
const MAX_INLINE_WAIT_MS = 10_000;
/** What Airtable's rate-limit page tells integrations to wait after a 429. */
export const RATE_LIMIT_BACKOFF_MS = 30_000;
/** Airtable's documented maximum, and its default, for one page of records. */
export const RECORD_PAGE_SIZE = 100;
/**
 * Records per create/update request. Airtable's documented limit for a write is
 * 10; exceeding it fails the whole request, so every write is chunked to it.
 */
export const WRITE_BATCH = 10;
/** Ids per formula when re-reading named records, kept well inside the 16,000-character URL limit. */
const RECORD_READ_BATCH = 50;
/**
 * A record id, as Airtable issues them. The filter formula below is built by
 * string concatenation, so the shape is CHECKED rather than assumed: anything
 * else is dropped and reported as missing instead of reaching the formula.
 */
const RECORD_ID = /^rec[A-Za-z0-9]{1,30}$/;
/** Airtable's documented maximum for one page of webhook payloads. */
const PAYLOAD_LIMIT = 50;

@Injectable()
export class AirtableClient {
  constructor(private readonly config: ConfigService) {}

  /** Where the REST and metadata APIs live. */
  get api(): string {
    return (this.config.get<string>('AIRTABLE_API_BASE_URL') ?? 'https://api.airtable.com').replace(/\/+$/, '');
  }

  /** Base delay for in-request retries. Configurable only so tests do not sleep. */
  private get retryBaseMs(): number {
    return Number(this.config.get('AIRTABLE_RETRY_BASE_MS') ?? 1000);
  }

  /** Airtable's documented ceiling is 5 requests a second per base; 0 turns pacing off. */
  private get minRequestGapMs(): number {
    return Number(this.config.get('AIRTABLE_MIN_REQUEST_GAP_MS') ?? 200);
  }

  /**
   * Space-separated: what the "airtable" integration in Nango requests. Configuration,
   * so a deployment can request LESS — narrowing it to drop
   * `schema.bases:write` is the supported way to run without column creation.
   * Every scope asked for here must also be enabled on the Airtable
   * integration itself, or the consent screen refuses with invalid_scope.
   */
  get scopes(): string {
    return (this.config.get<string>('AIRTABLE_SCOPES') ?? DEFAULT_SCOPES).trim().replace(/\s+/g, ' ');
  }

  /** The scopes this deployment asks for, as a list. */
  get requestedScopes(): string[] {
    return this.scopes.split(' ').filter(Boolean);
  }

  /** Every scope the integration cannot work without is actually being asked for. */
  missingRequiredRequests(): string[] {
    const asked = new Set(this.requestedScopes);
    return REQUIRED_SCOPES.filter((s) => !asked.has(s));
  }

  /**
   * Who the token belongs to, and what it may actually do. `scopes` is returned
   * only for an OAuth access token, which is the only kind we issue — it is the
   * authority on what was granted, so Phase 4 can refuse a column creation
   * without ever attempting it.
   */
  async identify(accessToken: string): Promise<AirtableAccount> {
    const body = await this.json<{ id?: string; email?: string; scopes?: string[] }>(`${this.api}/v0/meta/whoami`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!body.id) throw new AirtableApiError('REAUTH', 'Airtable did not say which account the token belongs to', 401);
    return {
      userId: body.id,
      email: typeof body.email === 'string' ? body.email.slice(0, 255) : null,
      scopes: Array.isArray(body.scopes) ? body.scopes.filter((s): s is string => typeof s === 'string') : [],
    };
  }

  // -------------------------------------------------------------------------
  // Metadata: bases, tables, fields
  // -------------------------------------------------------------------------

  /**
   * Every base the grant can see, a page at a time (Airtable returns up to
   * 1000 and an `offset` when there are more). Needs schema.bases:read.
   *
   * The user chooses which bases the integration may touch at consent time and
   * can change that later, so this is re-read rather than remembered.
   */
  async listBases(accessToken: string, offset: string | null): Promise<{ bases: AirtableBase[]; offset: string | null }> {
    const q = offset ? `?offset=${encodeURIComponent(offset)}` : '';
    const body = await this.authed<{ bases?: AirtableBase[]; offset?: string }>(accessToken, `${this.api}/v0/meta/bases${q}`);
    return { bases: body.bases ?? [], offset: body.offset ?? null };
  }

  /** A base's tables, with each table's fields and their types. Needs schema.bases:read. */
  async baseSchema(accessToken: string, baseId: string): Promise<AirtableTable[]> {
    const body = await this.authed<{ tables?: AirtableTable[] }>(accessToken, `${this.api}/v0/meta/bases/${encodeURIComponent(baseId)}/tables`);
    return body.tables ?? [];
  }

  // -------------------------------------------------------------------------
  // Records
  // -------------------------------------------------------------------------

  /**
   * One page of records, keyed BY FIELD ID rather than by name: field names are
   * not unique and an owner may rename one at any time, while the id is stable
   * for the life of the field. `pageSize` is capped at Airtable's maximum of
   * 100.
   */
  async listRecords(
    accessToken: string,
    baseId: string,
    tableId: string,
    opts: { offset?: string | null; pageSize?: number; fieldIds?: string[]; filterByFormula?: string } = {},
  ): Promise<{ records: AirtableRecord[]; offset: string | null }> {
    const q = new URLSearchParams({ returnFieldsByFieldId: 'true', pageSize: String(Math.min(opts.pageSize ?? RECORD_PAGE_SIZE, RECORD_PAGE_SIZE)) });
    if (opts.offset) q.set('offset', opts.offset);
    if (opts.filterByFormula) q.set('filterByFormula', opts.filterByFormula);
    // `fields` repeats rather than joining: a field id is opaque and must not be split on.
    for (const id of opts.fieldIds ?? []) q.append('fields[]', id);
    const url = `${this.api}/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}?${q.toString()}`;
    const body = await this.authed<{ records?: AirtableRecord[]; offset?: string }>(accessToken, url);
    return { records: body.records ?? [], offset: body.offset ?? null };
  }

  /** These records as they are now. Ids Airtable does not return were deleted. */
  async readRecords(accessToken: string, baseId: string, tableId: string, ids: string[]): Promise<{ found: AirtableRecord[]; missing: string[] }> {
    const found: AirtableRecord[] = [];
    for (let i = 0; i < ids.length; i += RECORD_READ_BATCH) {
      const chunk = ids.slice(i, i + RECORD_READ_BATCH).filter((id) => RECORD_ID.test(id));
      if (!chunk.length) continue;
      // RECORD_ID() is Airtable's own function for a record's id.
      const formula = `OR(${chunk.map((id) => `RECORD_ID()='${id}'`).join(',')})`;
      let offset: string | null = null;
      do {
        const page = await this.listRecords(accessToken, baseId, tableId, { offset, filterByFormula: formula });
        found.push(...page.records);
        offset = page.offset;
      } while (offset);
    }
    const seen = new Set(found.map((r) => r.id));
    return { found, missing: ids.filter((id) => !seen.has(id)) };
  }

  /**
   * Creates records, at most WRITE_BATCH at a time — Airtable's documented
   * limit for one write. `fields` is keyed by field id.
   *
   * `typecast` is on, which is what makes a select field writable at all: a
   * single or multiple select rejects any value that is not already one of its
   * options, and with typecast Airtable adds the option instead of failing the
   * batch. Fields where typecast would invent a whole record — a linked record,
   * a collaborator — are never sent (see NOT_WRITABLE_TYPES).
   */
  async createRecords(accessToken: string, baseId: string, tableId: string, records: { fields: Record<string, unknown> }[]): Promise<AirtableRecord[]> {
    const out: AirtableRecord[] = [];
    for (let i = 0; i < records.length; i += WRITE_BATCH) {
      const body = await this.authed<{ records?: AirtableRecord[] }>(accessToken, `${this.api}/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}`, {
        method: 'POST',
        body: JSON.stringify({ records: records.slice(i, i + WRITE_BATCH), returnFieldsByFieldId: true, typecast: true }),
      });
      out.push(...(body.records ?? []));
    }
    return out;
  }

  /**
   * Updates records with PATCH, never PUT: PATCH changes only the fields named
   * in the request and leaves every other cell exactly as it was, which is what
   * keeps an Airtable column EstatePulse does not know about safe. PUT would
   * clear them.
   */
  async updateRecords(accessToken: string, baseId: string, tableId: string, records: { id: string; fields: Record<string, unknown> }[]): Promise<AirtableRecord[]> {
    const out: AirtableRecord[] = [];
    for (let i = 0; i < records.length; i += WRITE_BATCH) {
      const body = await this.authed<{ records?: AirtableRecord[] }>(accessToken, `${this.api}/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ records: records.slice(i, i + WRITE_BATCH), returnFieldsByFieldId: true, typecast: true }),
      });
      out.push(...(body.records ?? []));
    }
    return out;
  }

  /**
   * Adds a column to a table. Needs `schema.bases:write` — which
   * `data.records:write` does NOT imply — and base-creator rights on the
   * Airtable side.
   *
   * Only ever creates. Nothing here updates or deletes an existing field.
   */
  async createField(
    accessToken: string,
    baseId: string,
    tableId: string,
    body: { name: string; type: string; options?: Record<string, unknown> },
  ): Promise<AirtableField> {
    const made = await this.authed<AirtableField>(
      accessToken,
      `${this.api}/v0/meta/bases/${encodeURIComponent(baseId)}/tables/${encodeURIComponent(tableId)}/fields`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    if (!made?.id) throw new AirtableApiError('BAD_REQUEST', 'Airtable did not return the new field', 502);
    return made;
  }

  // -------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------

  /**
   * Watches one table for record changes. Needs webhook:manage (and
   * data.records:read for the cell values).
   *
   * Airtable's notification is a PING with no data in it, so the cursor-driven
   * payload feed below is where the changes actually come from. A webhook made
   * with an OAuth token expires after 7 days unless it is refreshed, which the
   * sync does on every run.
   *
   * `notificationUrl` must be publicly reachable; without one the webhook still
   * records payloads and the periodic reconcile collects them.
   */
  async createWebhook(
    accessToken: string,
    baseId: string,
    tableId: string,
    notificationUrl: string | null,
  ): Promise<{ id: string; macSecretBase64: string; expirationTime: string | null }> {
    const body = await this.authed<{ id?: string; macSecretBase64?: string; expirationTime?: string }>(
      accessToken,
      `${this.api}/v0/bases/${encodeURIComponent(baseId)}/webhooks`,
      {
        method: 'POST',
        body: JSON.stringify({
          ...(notificationUrl ? { notificationUrl } : {}),
          specification: {
            options: {
              filters: {
                dataTypes: ['tableData'],
                recordChangeScope: tableId,
                changeTypes: ['add', 'update', 'remove'],
              },
            },
          },
        }),
      },
    );
    if (!body.id || !body.macSecretBase64) throw new AirtableApiError('BAD_REQUEST', 'Airtable did not return a usable webhook', 502);
    // macSecretBase64 is returned once and never again: it must be stored now.
    return { id: body.id, macSecretBase64: body.macSecretBase64, expirationTime: body.expirationTime ?? null };
  }

  /** Extends a webhook's life by another 7 days. */
  async refreshWebhook(accessToken: string, baseId: string, webhookId: string): Promise<void> {
    await this.authed(accessToken, `${this.api}/v0/bases/${encodeURIComponent(baseId)}/webhooks/${encodeURIComponent(webhookId)}/refresh`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  async deleteWebhook(accessToken: string, baseId: string, webhookId: string): Promise<void> {
    await this.authed(accessToken, `${this.api}/v0/bases/${encodeURIComponent(baseId)}/webhooks/${encodeURIComponent(webhookId)}`, { method: 'DELETE' });
  }

  /**
   * The changes since `cursor`. Airtable keeps payloads for a week and returns
   * at most 50 at a time; `mightHaveMore` says to come straight back for more.
   * Calling this also extends the webhook's life by 7 days.
   */
  async webhookPayloads(
    accessToken: string,
    baseId: string,
    webhookId: string,
    cursor: number | null,
  ): Promise<{ cursor: number; mightHaveMore: boolean; payloads: AirtableWebhookPayload[] }> {
    const q = new URLSearchParams({ limit: String(PAYLOAD_LIMIT) });
    if (cursor !== null) q.set('cursor', String(cursor));
    const body = await this.authed<{ cursor?: number; mightHaveMore?: boolean; payloads?: AirtableWebhookPayload[] }>(
      accessToken,
      `${this.api}/v0/bases/${encodeURIComponent(baseId)}/webhooks/${encodeURIComponent(webhookId)}/payloads?${q.toString()}`,
    );
    return { cursor: body.cursor ?? cursor ?? 1, mightHaveMore: Boolean(body.mightHaveMore), payloads: body.payloads ?? [] };
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  /**
   * A call on behalf of a connection. The access token goes in the header and
   * nowhere else.
   */
  async authed<T>(accessToken: string, url: string, init: RequestInit = {}): Promise<T> {
    return this.json<T>(url, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${accessToken}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
  }

  private async json<T>(url: string, init: RequestInit): Promise<T> {
    const res = await this.send(url, init);
    if (!res.ok) throw await this.apiError(res);
    // An empty body is a valid 200 — Airtable answers a webhook DELETE that way.
    // JSON.parse is not, and an unparsed SyntaxError would escape as something
    // no caller knows how to read.
    return (await res.json().catch(() => ({}))) as T;
  }

  /**
   * One request, retried in place for a short transient failure: a dropped
   * connection, a timeout, a 429 inside the inline budget, a 502/503/504.
   * Bounded (three attempts) with exponential backoff and jitter. Airtable's
   * documented recovery from a 429 is a 30-second wait, which is longer than
   * any request should hold open, so it is handed back for the caller to back
   * off on instead.
   */
  private async send(url: string, init: RequestInit): Promise<Response> {
    const timeout = Number(this.config.get('PROVIDER_HTTP_TIMEOUT_MS') ?? 10_000);
    // A POST creates something — a record, a column, a webhook, a token grant —
    // and Airtable offers no idempotency key. Repeating one whose answer went
    // missing would create a SECOND one, so a POST is sent exactly once and the
    // caller is left to deal with not knowing. Everything else here is safe to
    // repeat: a GET changes nothing, and a PATCH or DELETE of the same thing
    // lands on the same result however often it arrives.
    const repeatable = (init.method ?? 'GET').toUpperCase() !== 'POST';
    for (let attempt = 1; ; attempt++) {
      await pace(this.minRequestGapMs);
      let res: Response;
      try {
        res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
      } catch {
        // The URL stays out of the message: it carries base, table and record ids.
        if (repeatable && attempt < MAX_ATTEMPTS) {
          await sleep(backoff(this.retryBaseMs, attempt));
          continue;
        }
        throw new AirtableApiError('UNAVAILABLE', 'Airtable did not respond', 0);
      }

      const transient = res.status === 429 || [502, 503, 504].includes(res.status);
      if (!repeatable || !transient || attempt >= MAX_ATTEMPTS) return res;
      const wait = retryAfter(res) ?? (res.status === 429 ? RATE_LIMIT_BACKOFF_MS : backoff(this.retryBaseMs, attempt));
      if (wait > MAX_INLINE_WAIT_MS) return res;
      await sleep(wait);
    }
  }

  private async apiError(res: Response): Promise<AirtableApiError> {
    const body = (await res.json().catch(() => ({}))) as { error?: { type?: string; message?: string } | string };
    const err = typeof body.error === 'string' ? { type: body.error, message: undefined } : (body.error ?? {});
    const message = `${err.type ? `${err.type}: ` : ''}${err.message ?? `Airtable returned HTTP ${res.status}`}`.slice(0, 300);
    if (res.status === 429) return new AirtableApiError('RATE_LIMITED', message, 429, retryAfter(res) ?? RATE_LIMIT_BACKOFF_MS);
    if (res.status === 401) return new AirtableApiError('UNAUTHORIZED', message, 401);
    if (res.status === 403) {
      // A permission the grant never had. It will not fix itself, but it also
      // does not mean the connection is dead: record sync can outlive a missing
      // schema.bases:write.
      const scope = err.type === 'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND' || /scope|permission/i.test(message);
      return new AirtableApiError(scope ? 'SCOPE_MISSING' : 'FORBIDDEN', message, 403);
    }
    if (res.status === 404) return new AirtableApiError('NOT_FOUND', message, 404);
    if (res.status === 409) return new AirtableApiError('CONFLICT', message, 409);
    if (res.status >= 500) return new AirtableApiError('UNAVAILABLE', message, res.status, retryAfter(res));
    return new AirtableApiError('BAD_REQUEST', message, res.status);
  }
}

/**
 * Airtable allows 5 requests a second per base and answers the sixth with 429.
 * Reacting to that after the fact costs a 30-second wait, so requests are spaced
 * out on the way instead.
 *
 * One pacer for the whole process: stricter than the documented limit when
 * several bases are in play, never looser. A worker holds one table at a time,
 * so in practice it is the same thing.
 *
 * ponytail: process-wide spacing, per-base if one process ever drives several
 * bases at once.
 */
let paceChain: Promise<void> = Promise.resolve();
let lastRequestAt = 0;
function pace(gapMs: number): Promise<void> {
  if (gapMs <= 0) return Promise.resolve();
  paceChain = paceChain.then(async () => {
    const wait = lastRequestAt + gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
  });
  return paceChain;
}

/** Retry-After in seconds or as an HTTP date; null when absent or unreadable. */
function retryAfter(res: Response): number | null {
  const v = res.headers.get('retry-after');
  if (!v) return null;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/** base * 2^(attempt-1), ±20%. */
function backoff(base: number, attempt: number): number {
  return Math.round(base * 2 ** (attempt - 1) * (0.8 + Math.random() * 0.4));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
