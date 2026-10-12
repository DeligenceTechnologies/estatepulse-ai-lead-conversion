import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppError } from '../../common/errors';
import { SecretBox, calendarConnectionAad } from '../../common/crypto';
import { TENANT_PRISMA, type GuardedPrisma } from '../../prisma/prisma.service';
import type {
  CalendarConnectionMetadata,
  CalendarTokens,
  CalendlyAvailableTime,
  CalendlyCreatedInvitee,
  CalendlyCreateInviteeBody,
  CalendlyEnvelope,
  CalendlyEventType,
  CalendlyInvitee,
  CalendlyList,
  CalendlyOrganizationMembership,
  CalendlyScheduledEvent,
  CalendlyTokenResponse,
  CalendlyUser,
} from './types';

/**
 * Thrown when Calendly has permanently rejected our refresh token. The caller
 * must park the connection and ask the agent to reconnect — never retry, and
 * never on a timer.
 */
export class CalendarReauthRequired extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalendarReauthRequired';
  }
}

// The connection row shape moved to providers/types.ts when Cal.com arrived —
// both providers read the same row. Re-exported here so the many existing
// importers of `ConnectionRef` from this file keep working.
import type { ConnectionRef } from './providers/types';
export type { ConnectionRef };

/**
 * Everything that talks to Calendly, and the only place a token is decrypted.
 *
 * Bare `fetch` rather than an SDK, matching telnyx/voice.service.ts: this is
 * four endpoints, and a dependency that owns our auth refresh is a dependency
 * that owns our outage.
 */
@Injectable()
export class CalendlyClientService implements OnModuleInit {
  private readonly logger = new Logger(CalendlyClientService.name);
  private readonly box: SecretBox;

  /**
   * One in-flight refresh per connection.
   *
   * Calendly rotates refresh tokens: a successful POST /oauth/token REVOKES the
   * token it was given. Two concurrent refreshes therefore do not merely waste
   * a round trip — the second presents an already-dead token, gets
   * invalid_grant, and we would mark a perfectly good connection as broken.
   * Worse, whichever write lands last wins, so the surviving row can hold the
   * revoked token and the connection dies two hours later looking like a
   * Calendly outage.
   *
   * This map is per-process. With a second API instance the race returns; the
   * fix then is a row lock, and the same caveat applies as to events.bus.ts.
   */
  private readonly refreshing = new Map<string, Promise<CalendarTokens>>();

  constructor(
    private readonly config: ConfigService,
    @Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma,
  ) {
    this.box = new SecretBox(
      this.config.getOrThrow<string>('ENCRYPTION_KEYS'),
      this.config.getOrThrow<string>('ENCRYPTION_ACTIVE_KEY_ID'),
    );
  }

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  /**
   * Print the redirect URI at boot.
   *
   * A mismatch between this and the URI registered in the Calendly console is
   * the single most common way the connect flow fails, and Calendly reports it
   * on its own error page rather than to us — so nothing would appear in these
   * logs to explain it. Printing the exact string to copy makes that a
   * five-second check instead of a debugging session.
   */
  onModuleInit(): void {
    if (!this.isConfigured()) {
      this.logger.log('Calendly: not configured (set CALENDLY_CLIENT_ID and CALENDLY_CLIENT_SECRET)');
      return;
    }
    this.logger.log(`Calendly: redirect URI must be registered as ${this.redirectUri}`);
    // Printed for the same reason as the redirect URI, and it is the second
    // most common way this integration fails: Calendly rejects the authorize
    // request outright when the app is not approved for one of these, and that
    // refusal happens on Calendly's page, so nothing about it would otherwise
    // appear here. The app's approved list is in the Calendly developer
    // console; CALENDLY_SCOPES narrows this to match it.
    this.logger.log(`Calendly: requesting scopes ${this.scopes}`);
  }

  /** False when this deployment has no Calendly OAuth app registered. */
  isConfigured(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  private get clientId(): string | undefined {
    return this.config.get<string>('CALENDLY_CLIENT_ID') || undefined;
  }

  private get clientSecret(): string | undefined {
    return this.config.get<string>('CALENDLY_CLIENT_SECRET') || undefined;
  }

  private get apiBase(): string {
    return this.config.getOrThrow<string>('CALENDLY_API_BASE_URL').replace(/\/+$/, '');
  }

  private get authBase(): string {
    return this.config.getOrThrow<string>('CALENDLY_AUTH_BASE_URL').replace(/\/+$/, '');
  }

  /**
   * The scopes the consent screen asks for.
   *
   * CONFIGURABLE, because the valid set is a property of the registered
   * Calendly APP, not of this code. Calendly grants an OAuth app a fixed list
   * in its developer console and rejects the whole authorize request — before
   * the user sees a consent screen, with "The requested scope is invalid,
   * unknown, or malformed" on Calendly's own error page — if the `scope`
   * parameter names anything outside it. There is nothing in the response to
   * say which one offended, and nothing reaches our logs at all, so an app
   * approved for a narrower set has no way to work without this override.
   *
   * Deliberately READ-ONLY throughout. Inviting agents into the Calendly
   * organization would need organizations:write, and that is done in Calendly's
   * own UI — asking an owner to grant write access to their team's membership
   * for a button we do not offer would be rude.
   *
   * What each one buys, so a narrowed list is a known trade rather than a
   * mystery:
   *
   *   users:read            the connecting account's identity. Required.
   *   scheduled_events:read every member's bookings. Required — this IS the sync.
   *   organizations:read    the member roster. Without it no agent can be
   *                         linked to a Calendly user, so no booking can be
   *                         attributed and nothing is ever stored.
   *   event_types:read      the bookable pages, and the only way to see that a
   *                         round-robin page exists. Optional: losing it costs
   *                         the "Bookable pages" list and nothing else.
   *   webhooks:read/write   unused today. A free Calendly plan 403s a webhook
   *                         subscription, so we poll; holding the scopes means
   *                         a later plan upgrade needs no re-consent.
   *
   * In-call booking additionally needs `availability:read` (open slots) and
   * `scheduled_events:write` (POST /invitees — the only write this app makes).
   * They are NOT in the default list: an app not yet approved for them in the
   * Calendly developer console would have every connect rejected outright.
   * Once the app has them, set CALENDLY_BOOKING_SCOPES=1 and reconnect.
   */
  private get scopes(): string {
    const override = this.config.get<string>('CALENDLY_SCOPES')?.trim();
    if (override) return override.split(/\s+/).join(' ');

    return [
      'users:read',
      'organizations:read',
      'event_types:read',
      'scheduled_events:read',
      'webhooks:read',
      'webhooks:write',
      ...(this.config.get<string>('CALENDLY_BOOKING_SCOPES') === '1'
        ? ['availability:read', 'scheduled_events:write']
        : []),
    ].join(' ');
  }

  /**
   * Where Calendly sends the browser back. Must match what is registered in the
   * Calendly console CHARACTER FOR CHARACTER, and points at the API rather than
   * the SPA because the code-for-token exchange needs the client secret.
   *
   * `CALENDLY_REDIRECT_URI` is the whole URI, not a base, so what goes in the
   * env file is exactly what gets pasted into Calendly — there is no path for
   * the two to drift.
   *
   * It exists because deriving this from PUBLIC_API_BASE_URL alone couples two
   * unrelated things. That variable is also the public base for Tally's webhook
   * ingest, which refuses localhost and demands HTTPS, so in development it
   * tends to be a tunnel — and a cloudflared quick tunnel gets a new random
   * hostname on every restart, which would silently invalidate the registered
   * redirect URI each time. A Calendly SANDBOX app accepts plain
   * `http://localhost:4000/...`, so overriding just this one value lets OAuth
   * and webhook ingest both work without fighting over one setting.
   */
  get redirectUri(): string {
    const override = this.config.get<string>('CALENDLY_REDIRECT_URI');
    if (override) return override.replace(/\/+$/, '');

    const base = this.config.getOrThrow<string>('PUBLIC_API_BASE_URL').replace(/\/+$/, '');
    return `${base}/api/calendly/oauth/callback`;
  }

  private requireConfigured(): { id: string; secret: string } {
    if (!this.clientId || !this.clientSecret) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Calendly is not configured on this server. Set CALENDLY_CLIENT_ID and CALENDLY_CLIENT_SECRET.',
      );
    }
    return { id: this.clientId, secret: this.clientSecret };
  }

  // -------------------------------------------------------------------------
  // OAuth
  // -------------------------------------------------------------------------

  authorizeUrl(state: string): string {
    const { id } = this.requireConfigured();
    const params = new URLSearchParams({
      client_id: id,
      response_type: 'code',
      redirect_uri: this.redirectUri,
      scope: this.scopes,
      state,
    });
    return `${this.authBase}/oauth/authorize?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<CalendlyTokenResponse> {
    return this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
    });
  }

  private async tokenRequest(fields: Record<string, string>): Promise<CalendlyTokenResponse> {
    const { id, secret } = this.requireConfigured();
    const body = new URLSearchParams({ client_id: id, client_secret: secret, ...fields });

    const res = await fetch(`${this.authBase}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const text = await res.text();
    if (!res.ok) {
      // invalid_grant on a refresh means the token is spent or revoked. It will
      // never work again, so this must not be retried on a timer.
      if (/invalid_grant/i.test(text)) {
        throw new CalendarReauthRequired('Calendly rejected the stored credentials');
      }
      throw new AppError(
        'UPSTREAM_ERROR',
        `Calendly token request failed (${res.status}): ${text.slice(0, 300)}`,
      );
    }
    return JSON.parse(text) as CalendlyTokenResponse;
  }

  /** Best-effort. A connection is disconnected locally whether or not this works. */
  async revoke(accessToken: string): Promise<void> {
    try {
      const { id, secret } = this.requireConfigured();
      await fetch(`${this.authBase}/oauth/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: id,
          client_secret: secret,
          token: accessToken,
        }).toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      this.logger.warn(`Calendly token revoke failed (ignored): ${String(err)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Token lifecycle
  // -------------------------------------------------------------------------

  decrypt(conn: ConnectionRef): CalendarTokens {
    if (!conn.credentials_secret_ref) {
      throw new CalendarReauthRequired('No Calendly credentials stored for this connection');
    }
    const plain = this.box.decrypt(
      conn.credentials_secret_ref,
      calendarConnectionAad(conn.organization_id, conn.id),
    );
    return JSON.parse(plain) as CalendarTokens;
  }

  encrypt(organizationId: string, connectionId: string, tokens: CalendarTokens): string {
    return this.box.encrypt(
      JSON.stringify(tokens),
      calendarConnectionAad(organizationId, connectionId),
    );
  }

  /**
   * A usable access token, refreshing first when it is about to expire.
   *
   * Refreshing PROACTIVELY (rather than reacting to a 401) is what keeps the
   * common path off the rotation race entirely: under normal operation only the
   * two-minute window before expiry ever calls the token endpoint.
   */
  private async accessToken(conn: ConnectionRef): Promise<string> {
    const meta = (conn.metadata ?? {}) as CalendarConnectionMetadata;
    const expiresAt = meta.tokenExpiresAt ? Date.parse(meta.tokenExpiresAt) : 0;

    if (expiresAt && expiresAt - Date.now() > 120_000) {
      return this.decrypt(conn).access_token;
    }
    return (await this.refresh(conn)).access_token;
  }

  private async refresh(conn: ConnectionRef): Promise<CalendarTokens> {
    const inFlight = this.refreshing.get(conn.id);
    if (inFlight) return inFlight;

    const run = (async (): Promise<CalendarTokens> => {
      const current = this.decrypt(conn);
      const res = await this.tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: current.refresh_token,
      });

      const next: CalendarTokens = {
        access_token: res.access_token,
        // Calendly returns a NEW refresh token and kills the old one. Storing
        // the old value here is the single most likely way to break this
        // integration, so it is taken from the response, never carried over.
        refresh_token: res.refresh_token ?? current.refresh_token,
      };

      // Persist before returning: if the process dies between the exchange and
      // the write, the token we just burned is the only one on disk.
      await this.prisma.calendar_connections.update({
        where: { id: conn.id },
        data: {
          credentials_secret_ref: this.encrypt(conn.organization_id, conn.id, next),
          metadata: {
            ...((conn.metadata ?? {}) as CalendarConnectionMetadata),
            tokenExpiresAt: new Date(Date.now() + res.expires_in * 1000).toISOString(),
            lastError: undefined,
          } as object,
          updated_at: new Date(),
        },
      });

      // Keep the caller's copy usable for the rest of this pass.
      conn.credentials_secret_ref = this.encrypt(conn.organization_id, conn.id, next);
      return next;
    })();

    this.refreshing.set(conn.id, run);
    try {
      return await run;
    } finally {
      this.refreshing.delete(conn.id);
    }
  }

  // -------------------------------------------------------------------------
  // API
  // -------------------------------------------------------------------------

  /** `GET /users/me` with a raw token — used during connect, before a row exists. */
  async meWithToken(accessToken: string): Promise<CalendlyUser> {
    const res = await fetch(`${this.apiBase}/users/me`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new AppError('UPSTREAM_ERROR', `Calendly /users/me failed (${res.status})`);
    }
    const body = (await res.json()) as CalendlyEnvelope<CalendlyUser>;
    return body.resource;
  }

  /**
   * The authorizing account's membership of its own Calendly organization,
   * fetched during connect with a raw token.
   *
   * Calendly answers `/scheduled_events?organization=` only for an owner or
   * admin. A 'user' token gets a 403 — but not until the first sweep, hours
   * later, by which point the owner has long since seen "Connected" and moved
   * on. Checking the role here turns that into a message at the moment of
   * connecting, while they still have the other Calendly login to hand.
   */
  async membershipWithToken(
    accessToken: string,
    userUri: string,
  ): Promise<CalendlyOrganizationMembership | null> {
    const q = new URLSearchParams({ user: userUri, count: '1' });
    const res = await fetch(`${this.apiBase}/organization_memberships?${q.toString()}`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text();
      throw (
        this.scopeError('/organization_memberships', res.status, text) ??
        new AppError(
          'UPSTREAM_ERROR',
          `Calendly /organization_memberships failed (${res.status}): ${text.slice(0, 300)}`,
        )
      );
    }
    const body = (await res.json()) as CalendlyList<CalendlyOrganizationMembership>;
    return body.collection[0] ?? null;
  }

  /**
   * Turn Calendly's 403 into something the owner can act on.
   *
   * Calendly answers an under-scoped token with an InsufficientScopeError body
   * carrying `required_scopes`. Reported raw it becomes "Calendly
   * /organization_memberships failed (403)", which reads like an outage and
   * sends someone looking at the wrong thing — the token is fine, the APP is
   * missing a permission, and only naming the scope makes that obvious.
   *
   * Returns null when the 403 is NOT about scopes (a free plan refusing
   * webhooks, say), so the caller reports that one as it stands.
   */
  private scopeError(path: string, status: number, text: string): AppError | null {
    if (status !== 403) return null;

    let required: string[] = [];
    try {
      const body = JSON.parse(text) as { required_scopes?: unknown };
      if (Array.isArray(body.required_scopes)) required = body.required_scopes.map(String);
    } catch {
      /* not JSON, or not shaped like an InsufficientScopeError */
    }
    if (!required.length) return null;

    return new AppError(
      'FORBIDDEN',
      `Your Calendly app is not approved for ${required.join(', ')}, which ${path} requires. ` +
        'Add the scope to the app in the Calendly developer console and reconnect.',
    );
  }

  private async authedGet<T>(conn: ConnectionRef, path: string): Promise<T> {
    const token = await this.accessToken(conn);
    const url = path.startsWith('http') ? path : `${this.apiBase}${path}`;

    let res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    // One retry, and only one: a 401 here means the token expired sooner than
    // its stated lifetime. A second failure is not a timing problem.
    if (res.status === 401) {
      const fresh = await this.refresh(conn);
      res = await fetch(url, {
        headers: { authorization: `Bearer ${fresh.access_token}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    }

    if (!res.ok) {
      const text = await res.text();
      throw (
        this.scopeError(path, res.status, text) ??
        new AppError(
          'UPSTREAM_ERROR',
          `Calendly ${path} failed (${res.status}): ${text.slice(0, 300)}`,
        )
      );
    }
    return (await res.json()) as T;
  }

  /**
   * One page of scheduled events for the WHOLE Calendly organization.
   *
   * `organization` rather than `user` is the single change that makes one
   * office connection replace a token per agent: Calendly documents this
   * parameter as "requires admin/owner privilege" and returns every member's
   * bookings, each naming its host in `event_memberships`. It is also the only
   * way a round-robin booking is ever seen — the rotation picks a host we have
   * no token for, and a per-user query would simply never return it.
   *
   * `status` is deliberately NOT filtered: leaving it off returns canceled
   * events alongside active ones, which is how a cancellation is detected
   * without a second request per known event.
   */
  async listScheduledEvents(
    conn: ConnectionRef,
    params: {
      organizationUri: string;
      minStart: Date;
      maxStart: Date;
      pageToken?: string | null;
    },
  ): Promise<CalendlyList<CalendlyScheduledEvent>> {
    const q = new URLSearchParams({
      organization: params.organizationUri,
      min_start_time: params.minStart.toISOString(),
      max_start_time: params.maxStart.toISOString(),
      count: '100',
      sort: 'start_time:asc',
    });
    if (params.pageToken) q.set('page_token', params.pageToken);
    return this.authedGet<CalendlyList<CalendlyScheduledEvent>>(
      conn,
      `/scheduled_events?${q.toString()}`,
    );
  }

  /** One page of the Calendly organization's members. */
  async listOrganizationMemberships(
    conn: ConnectionRef,
    params: { organizationUri: string; pageToken?: string | null },
  ): Promise<CalendlyList<CalendlyOrganizationMembership>> {
    const q = new URLSearchParams({ organization: params.organizationUri, count: '100' });
    if (params.pageToken) q.set('page_token', params.pageToken);
    return this.authedGet<CalendlyList<CalendlyOrganizationMembership>>(
      conn,
      `/organization_memberships?${q.toString()}`,
    );
  }

  /**
   * One page of event types, scoped to either the organization or one member.
   *
   * BOTH scopes are needed, and this is not an oversight. Calendly's own
   * developer support states that the organization scope returns individual
   * event types only — "You will have to make the request per user to pull all
   * the round robin event types". So the organization call finds the shared
   * team pages, the per-user calls find the round-robin ones the team actually
   * books through, and CalendlyEventTypesService merges them by URI.
   */
  async listEventTypes(
    conn: ConnectionRef,
    params: { organizationUri?: string; userUri?: string; pageToken?: string | null },
  ): Promise<CalendlyList<CalendlyEventType>> {
    const q = new URLSearchParams({ count: '100', active: 'true' });
    if (params.organizationUri) q.set('organization', params.organizationUri);
    if (params.userUri) q.set('user', params.userUri);
    if (params.pageToken) q.set('page_token', params.pageToken);
    return this.authedGet<CalendlyList<CalendlyEventType>>(conn, `/event_types?${q.toString()}`);
  }

  async listInvitees(
    conn: ConnectionRef,
    eventUri: string,
  ): Promise<CalendlyList<CalendlyInvitee>> {
    return this.authedGet<CalendlyList<CalendlyInvitee>>(conn, `${eventUri}/invitees?count=100`);
  }

  /**
   * Open start times of one event type between two instants (at most 31 days
   * apart, both in the future). For a round-robin event type these are the
   * pool's combined openings; Calendly picks the host when it is booked.
   */
  async listAvailableTimes(
    conn: ConnectionRef,
    params: { eventTypeUri: string; start: Date; end: Date },
  ): Promise<CalendlyList<CalendlyAvailableTime>> {
    const q = new URLSearchParams({
      event_type: params.eventTypeUri,
      start_time: params.start.toISOString(),
      end_time: params.end.toISOString(),
    });
    return this.authedGet<CalendlyList<CalendlyAvailableTime>>(
      conn,
      `/event_type_available_times?${q.toString()}`,
    );
  }

  /**
   * Book a meeting (Calendly Scheduling API). Calendly sends its usual
   * confirmations and, for a round-robin event type, chooses the host.
   *
   * A slot taken since it was offered comes back as a 4xx, surfaced as
   * CONFLICT so the caller can offer other times; anything else is an upstream
   * error.
   */
  async createInvitee(
    conn: ConnectionRef,
    body: CalendlyCreateInviteeBody,
  ): Promise<CalendlyCreatedInvitee> {
    const res = await this.authedSend(conn, 'POST', '/invitees', body);
    if (!res.ok) {
      const text = await res.text();
      const scope = this.scopeError('/invitees', res.status, text);
      if (scope) throw scope;
      if (res.status === 400 || res.status === 409 || res.status === 422) {
        throw new AppError('CONFLICT', `Calendly could not book that time: ${text.slice(0, 300)}`);
      }
      throw new AppError('UPSTREAM_ERROR', `Calendly /invitees failed (${res.status}): ${text.slice(0, 300)}`);
    }
    return ((await res.json()) as CalendlyEnvelope<CalendlyCreatedInvitee>).resource;
  }

  /** One event type, for its configured `locations`. */
  async getEventType(conn: ConnectionRef, eventTypeUri: string): Promise<CalendlyEventType> {
    return (await this.authedGet<CalendlyEnvelope<CalendlyEventType>>(conn, eventTypeUri)).resource;
  }

  /** One scheduled event, for the host Calendly assigned (`event_memberships`). */
  async getScheduledEvent(conn: ConnectionRef, eventUri: string): Promise<CalendlyScheduledEvent> {
    return (await this.authedGet<CalendlyEnvelope<CalendlyScheduledEvent>>(conn, eventUri)).resource;
  }

  /** A JSON write, with the same one-shot refresh on 401 as authedGet. */
  private async authedSend(conn: ConnectionRef, method: 'POST', path: string, body: unknown): Promise<Response> {
    const url = path.startsWith('http') ? path : `${this.apiBase}${path}`;
    const send = (token: string) =>
      fetch(url, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

    let res = await send(await this.accessToken(conn));
    if (res.status === 401) res = await send((await this.refresh(conn)).access_token);
    return res;
  }

  private get timeoutMs(): number {
    return this.config.get<number>('PROVIDER_HTTP_TIMEOUT_MS') ?? 10_000;
  }
}
