import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { BOLDTRAIL_PROVIDER, CRM_PROVIDER_LABELS, type CrmContact } from '../crm-records';
import { CrmApiError, type ApiTokenCrmAdapter, type CrmChangedPage, type CrmContactPage, type CrmContactUpdate, type CrmTokenAccount } from '../types';
import { boldTrailTimeMs, isLiveBoldTrailContact, toCrmContact, type BoldTrailContact } from './boldtrail-contacts';

/**
 * Everything that talks to BoldTrail (Inside Real Estate's kvCORE Public API
 * V2) over HTTP.
 *
 * Auth is a per-account API token the owner generates in BoldTrail (Lead
 * Engine > Lead Dropbox > My API Tokens, "Contacts" or "All"), sent as
 * `Authorization: Bearer <token>`. Tokens are JWTs that live one year, and
 * there is no refresh and no revoke endpoint: when one expires or is deleted,
 * the owner pastes a new one.
 *
 * What the V2 API does not give us, and how this client copes:
 *  - No webhooks. New and changed contacts are found by reconciliation polling.
 *  - No documented "modified since" filter or sort. changedContactsSince reads
 *    every page and filters on updated_at itself. That costs one request per
 *    500 contacts each reconcile interval (CRM_RECONCILE_INTERVAL_MS). Past
 *    MAX_SCAN_PAGES it gives up and the sync queues a resumable full re-read.
 *  - Page-number paging (Laravel paginator: current_page, last_page,
 *    next_page_url, data). The cursor is the next page number. Contacts
 *    created during a full read can shift pages; they are caught by the next
 *    reconcile, and a contact seen twice is harmless.
 *
 * Bare `fetch`, as for HubSpot. The token never appears in a URL, a log line
 * or an error message.
 */

/** Rows per page for a full read. Each page is written before the next is read. */
const PAGE_SIZE = 100;
/** The V2 maximum. Used for the changed-contacts scan, which only filters. */
const SCAN_PAGE_SIZE = 500;
/** 200 x 500 = 100,000 contacts. Beyond that, the sync falls back to a full re-read. */
const MAX_SCAN_PAGES = 200;
/** Between scan pages, to stay well inside the account's rate limit. */
const SCAN_SPACING_MS = 200;
/** Parallel single-contact reads in readContacts. */
const READ_CONCURRENCY = 5;

/** In-request retries for a transient failure; anything longer is the sync's backoff. */
const MAX_ATTEMPTS = 3;
/** A wait BoldTrail asks for that is longer than this is handed back to the caller instead. */
const MAX_INLINE_WAIT_MS = 10_000;

type Paginated<T> = {
  data?: T[];
  current_page?: number;
  last_page?: number;
  next_page_url?: string | null;
};

@Injectable()
export class BoldTrailClient implements ApiTokenCrmAdapter {
  readonly auth = 'api_token' as const;
  readonly provider = BOLDTRAIL_PROVIDER;
  readonly label = CRM_PROVIDER_LABELS[BOLDTRAIL_PROVIDER];

  constructor(private readonly config: ConfigService) {}

  private get api(): string {
    return (this.config.get<string>('BOLDTRAIL_API_BASE_URL') ?? 'https://api.kvcore.com/v2/public').replace(/\/+$/, '');
  }

  /** Base delay for in-request retries. Configurable only so tests do not sleep. */
  private get retryBaseMs(): number {
    return Number(this.config.get('BOLDTRAIL_RETRY_BASE_MS') ?? 1000);
  }

  /** Nothing to configure on the server: every organization brings its own token. */
  isConfigured(): boolean {
    return true;
  }

  /**
   * One authenticated read proves the token is live and has the Contacts
   * scope. The account comes from the token's own claims (V2 tokens are JWTs
   * naming their user and account). It is read, not trusted: BoldTrail has
   * just accepted the token, and the claims only label the connection.
   */
  async verifyToken(token: string): Promise<CrmTokenAccount> {
    const claims = jwtClaims(token);
    const expiresAt = typeof claims.exp === 'number' ? new Date(claims.exp * 1000) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new CrmApiError('REAUTH', 'This BoldTrail API token has expired', 401);
    }
    await this.page(token, 1, 1);

    const accountId = firstClaim(claims, ['account_id', 'accountId', 'acc', 'aid', 'brokerage_id', 'office_id']);
    const userId = firstClaim(claims, ['user_id', 'userId', 'uid', 'sub']);
    // No account claim at all: key the account on the token itself, so the same
    // token can never be connected to two organizations.
    const externalAccountId = accountId ?? (userId ? `user-${userId}` : `token-${createHash('sha256').update(token).digest('hex').slice(0, 24)}`);
    const email = firstClaim(claims, ['email', 'user_email']);
    const name = firstClaim(claims, ['account_name', 'name', 'company', 'subdomain']);
    const scopes = Array.isArray(claims.scopes)
      ? claims.scopes.map(String)
      : typeof claims.scope === 'string'
        ? claims.scope.split(/[\s,]+/).filter(Boolean)
        : [];
    return {
      externalAccountId: externalAccountId.slice(0, 255),
      accountName: name ? name.slice(0, 255) : null,
      userEmail: email ? email.slice(0, 255) : null,
      scopes,
      expiresAt,
    };
  }

  async listContacts(token: string, cursor: string | null): Promise<CrmContactPage> {
    const page = cursor ? Number(cursor) : 1;
    if (!Number.isInteger(page) || page < 1) throw new CrmApiError('BAD_REQUEST', 'Invalid BoldTrail page cursor', 0);
    const body = await this.page(token, page, PAGE_SIZE);
    return {
      contacts: (body.data ?? []).filter(isLiveBoldTrailContact).map(toCrmContact),
      nextCursor: hasNext(body, page) ? String(page + 1) : null,
    };
  }

  /** One GET per contact (V2 has no batch read), a few at a time. A 404, a deleted or archived contact is missing. */
  async readContacts(token: string, ids: string[]): Promise<{ found: CrmContact[]; missing: string[] }> {
    const unique = [...new Set(ids)];
    const found: CrmContact[] = [];
    const missing: string[] = [];
    for (let i = 0; i < unique.length; i += READ_CONCURRENCY) {
      const chunk = unique.slice(i, i + READ_CONCURRENCY);
      const results = await Promise.all(chunk.map((id) => this.contact(token, id)));
      results.forEach((c, j) => (c && isLiveBoldTrailContact(c) ? found.push(toCrmContact(c)) : missing.push(chunk[j])));
    }
    return { found, missing };
  }

  /**
   * Every live contact updated at or after `sinceMs`, oldest first, in one
   * page. It reads the whole account, because V2 cannot filter or sort by
   * update time. Returning a single page means the sync's watermark only moves
   * once the whole account has been seen. `capped` = too large to scan; the
   * sync then queues a full re-read, which is resumable page by page.
   */
  async changedContactsSince(token: string, sinceMs: number, cursor: string | null): Promise<CrmChangedPage> {
    void cursor;
    const changed: (CrmContact & { modifiedAt: number })[] = [];
    for (let page = 1; ; page++) {
      if (page > MAX_SCAN_PAGES) return { contacts: [], nextCursor: null, capped: true };
      const body = await this.page(token, page, SCAN_PAGE_SIZE);
      for (const c of body.data ?? []) {
        if (!isLiveBoldTrailContact(c)) continue;
        const modifiedAt = boldTrailTimeMs(c.updated_at) || boldTrailTimeMs(c.created_at);
        // Unreadable dates count as changed: re-reading is safe, skipping is not.
        if (modifiedAt === 0 || modifiedAt >= sinceMs) changed.push({ ...toCrmContact(c), modifiedAt });
      }
      if (!hasNext(body, page)) break;
      await sleep(SCAN_SPACING_MS);
    }
    changed.sort((a, b) => a.modifiedAt - b.modifiedAt);
    return { contacts: changed, nextCursor: null, capped: false };
  }

  /**
   * Write-back is off for BoldTrail: crmRowIsEditable only offers editing for
   * HubSpot rows, so this is never reached from the product. It refuses
   * plainly rather than guessing at an unverified write endpoint.
   */
  async updateContact(_token: string, _externalId: string, _fields: CrmContactUpdate): Promise<CrmContact> {
    throw new CrmApiError('BAD_REQUEST', 'Editing BoldTrail contacts from EstatePulse is not supported yet', 0);
  }

  // -------------------------------------------------------------------------

  private page(token: string, page: number, limit: number): Promise<Paginated<BoldTrailContact>> {
    const q = new URLSearchParams({ page: String(page), limit: String(limit) });
    return this.json<Paginated<BoldTrailContact>>(`${this.api}/contacts?${q.toString()}`, token);
  }

  /**
   * The contact, or null when BoldTrail no longer has it. Only reached for
   * queued re-reads (ingest_events), which BoldTrail never produces today: it
   * sends no webhooks and its rows are not editable from Import Review.
   */
  private async contact(token: string, id: string): Promise<BoldTrailContact | null> {
    try {
      const body = await this.json<BoldTrailContact | { data?: BoldTrailContact }>(`${this.api}/contact/${encodeURIComponent(id)}`, token);
      const c = 'data' in body && body.data && typeof body.data === 'object' ? body.data : (body as BoldTrailContact);
      return c && text(c.id) ? c : null;
    } catch (e) {
      if (e instanceof CrmApiError && e.kind === 'NOT_FOUND') return null;
      throw e;
    }
  }

  private async json<T>(url: string, token: string): Promise<T> {
    const res = await this.send(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!res.ok) throw await this.apiError(res);
    try {
      return (await res.json()) as T;
    } catch {
      throw new CrmApiError('UNAVAILABLE', 'BoldTrail returned an unreadable response', res.status);
    }
  }

  /**
   * One request, retried in place for a short transient failure (a dropped
   * connection, a timeout, a 429, a 502/503/504), at most three attempts with
   * exponential backoff and jitter, honouring Retry-After. A longer wait is
   * handed back as a CrmApiError carrying it, for the sync to back off.
   */
  private async send(url: string, init: RequestInit): Promise<Response> {
    const timeout = Number(this.config.get('PROVIDER_HTTP_TIMEOUT_MS') ?? 10_000);
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
      } catch {
        // The URL stays out of the message: it carries record ids.
        if (attempt < MAX_ATTEMPTS) {
          await sleep(backoff(this.retryBaseMs, attempt));
          continue;
        }
        throw new CrmApiError('UNAVAILABLE', 'BoldTrail did not respond', 0);
      }
      const transient = res.status === 429 || [502, 503, 504].includes(res.status);
      if (!transient || attempt >= MAX_ATTEMPTS) return res;
      const wait = retryAfter(res) ?? backoff(this.retryBaseMs, attempt);
      if (wait > MAX_INLINE_WAIT_MS) return res;
      await sleep(wait);
    }
  }

  private async apiError(res: Response): Promise<CrmApiError> {
    const body = (await res.json().catch(() => ({}))) as { message?: unknown; error?: unknown };
    const said = typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : null;
    const message = (said ?? `BoldTrail returned HTTP ${res.status}`).slice(0, 300);
    if (res.status === 401) return new CrmApiError('UNAUTHORIZED', message, 401);
    if (res.status === 403) return new CrmApiError('FORBIDDEN', message, 403);
    if (res.status === 404) return new CrmApiError('NOT_FOUND', message, 404);
    if (res.status === 409) return new CrmApiError('CONFLICT', message, 409);
    if (res.status === 429) return new CrmApiError('RATE_LIMITED', message, 429, retryAfter(res));
    if (res.status >= 500) return new CrmApiError('UNAVAILABLE', message, res.status, retryAfter(res));
    return new CrmApiError('BAD_REQUEST', message, res.status);
  }
}

const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t ? t : null;
};

/** Another page exists: by next_page_url, or by last_page when that is all BoldTrail sent. */
function hasNext(body: Paginated<unknown>, page: number): boolean {
  if (body.next_page_url !== undefined) return Boolean(body.next_page_url);
  if (typeof body.last_page === 'number') return page < body.last_page;
  return false;
}

/** The token's JWT payload, unverified (it only labels the connection). {} for a token that is not a JWT. */
function jwtClaims(token: string): Record<string, unknown> {
  const part = token.split('.')[1];
  if (!part) return {};
  try {
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function firstClaim(claims: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = claims[k];
    if ((typeof v === 'string' || typeof v === 'number') && String(v).trim()) return String(v).trim();
  }
  return null;
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
