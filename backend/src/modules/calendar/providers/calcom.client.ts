import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppError } from '../../../common/errors';
import { SecretBox, calendarConnectionAad } from '../../../common/crypto';
import type { ConnectionRef } from '../calendly.client';
import type { CalComConnectionMetadata } from './calcom.types';
import type {
  CalComBooking,
  CalComList,
  CalComTeam,
  CalComTeamEventType,
  CalComTeamMembership,
  CalComUser,
} from './calcom.types';

/**
 * Everything that talks to Cal.com, and the only place its API key is
 * decrypted.
 *
 * Bare `fetch` rather than an SDK, matching CalendlyClientService and
 * telnyx/voice.service.ts.
 *
 * Simpler than the Calendly client in one decisive way: a Cal.com API key does
 * not expire and is not rotated, so there is no refresh, no in-flight-refresh
 * map, and no class of failure where a concurrent write parks a working
 * connection. What replaces it is a key that is valid until the customer
 * revokes it in Cal.com — at which point every request 401s and stays 401ing,
 * which is why that is treated as terminal rather than retried.
 */
@Injectable()
export class CalComClientService implements OnModuleInit {
  private readonly logger = new Logger(CalComClientService.name);
  private readonly box: SecretBox;

  constructor(private readonly config: ConfigService) {
    this.box = new SecretBox(
      this.config.getOrThrow<string>('ENCRYPTION_KEYS'),
      this.config.getOrThrow<string>('ENCRYPTION_ACTIVE_KEY_ID'),
    );
  }

  onModuleInit(): void {
    this.logger.log(`Cal.com: API base ${this.apiBase}, api version ${this.apiVersion}`);
  }

  /**
   * Cal.com needs no client registration at all — the office pastes a key it
   * generated itself — so unlike Calendly there is no deployment-level
   * configuration that can be missing, and this is always true. It exists so
   * the two providers answer the same question the same way.
   */
  isConfigured(): boolean {
    return true;
  }

  /**
   * Where this Cal.com's public booking pages live.
   *
   * Separate from the API base on purpose. cal.com serves its API from
   * api.cal.com and its booking pages from cal.com, and a self-hosted install
   * can put them anywhere — so one cannot be derived from the other without
   * eventually producing links that go nowhere.
   */
  get bookingBaseUrl(): string {
    return (
      this.config.get<string>('CALCOM_BOOKING_BASE_URL')?.replace(/\/+$/, '') ?? 'https://cal.com'
    );
  }

  private get apiBase(): string {
    return this.config.get<string>('CALCOM_API_BASE_URL')?.replace(/\/+$/, '') ?? 'https://api.cal.com/v2';
  }

  /**
   * The `cal-api-version` header.
   *
   * Cal.com versions its endpoints by DATE and says of the team event-types
   * route: "Must be set to 2026-06-12. If not set to this value, the endpoint
   * will default to an older version." An older version answers with a
   * different body, so omitting this does not fail — it silently returns a
   * shape we would misread, which is the worst of the available outcomes.
   */
  private get apiVersion(): string {
    return this.config.get<string>('CALCOM_API_VERSION') ?? '2026-06-12';
  }

  private get timeoutMs(): number {
    return this.config.get<number>('PROVIDER_HTTP_TIMEOUT_MS') ?? 10_000;
  }

  // -------------------------------------------------------------------------
  // Credentials
  // -------------------------------------------------------------------------

  decrypt(conn: ConnectionRef): string {
    if (!conn.credentials_secret_ref) {
      throw new AppError('VALIDATION_ERROR', 'No Cal.com API key stored for this connection');
    }
    const plain = this.box.decrypt(
      conn.credentials_secret_ref,
      calendarConnectionAad(conn.organization_id, conn.id),
    );
    return (JSON.parse(plain) as { api_key: string }).api_key;
  }

  encrypt(organizationId: string, connectionId: string, apiKey: string): string {
    return this.box.encrypt(
      JSON.stringify({ api_key: apiKey }),
      calendarConnectionAad(organizationId, connectionId),
    );
  }

  // -------------------------------------------------------------------------
  // Requests
  // -------------------------------------------------------------------------

  /**
   * A GET with a raw key — used while connecting, before a row exists.
   *
   * `cal-api-version` is sent on EVERY request, not only the routes that
   * require it. An endpoint that ignores the header loses nothing; an endpoint
   * that starts honouring it later would otherwise change shape under us on
   * Cal.com's schedule rather than ours.
   */
  async getWithKey<T>(apiKey: string, path: string): Promise<T> {
    const res = await fetch(`${this.apiBase}${path}`, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        'cal-api-version': this.apiVersion,
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      const text = await res.text();
      if (res.status === 401 || res.status === 403) {
        throw new AppError(
          'FORBIDDEN',
          `Cal.com rejected this API key (${res.status}). Check that it is a live key ` +
            'copied in full, and that it has not been revoked.',
        );
      }
      throw new AppError(
        'UPSTREAM_ERROR',
        `Cal.com ${path} failed (${res.status}): ${text.slice(0, 300)}`,
      );
    }
    return (await res.json()) as T;
  }

  private async get<T>(conn: ConnectionRef, path: string): Promise<T> {
    return this.getWithKey<T>(this.decrypt(conn), path);
  }

  /** The team this connection reads. Without it nothing here can run. */
  private teamId(conn: ConnectionRef): number {
    const meta = (conn.metadata ?? {}) as CalComConnectionMetadata;
    if (typeof meta.calTeamId !== 'number') {
      throw new AppError(
        'VALIDATION_ERROR',
        'This Cal.com connection is missing its team. Reconnect it.',
      );
    }
    return meta.calTeamId;
  }

  // -------------------------------------------------------------------------
  // API
  // -------------------------------------------------------------------------

  /** `GET /me` with a raw key — identity, and proof the key works. */
  async meWithKey(apiKey: string): Promise<CalComUser> {
    const body = await this.getWithKey<{ data: CalComUser }>(apiKey, '/me');
    return body.data;
  }

  /** The teams this key can see. */
  async teamsWithKey(apiKey: string): Promise<CalComTeam[]> {
    const body = await this.getWithKey<{ data: CalComTeam[] }>(apiKey, '/teams');
    return body.data ?? [];
  }

  /**
   * One page of the team's bookings.
   *
   * `status` is deliberately NOT filtered, for the same reason it is not on the
   * Calendly side: asking for everything returns cancelled bookings alongside
   * live ones, which is how a cancellation is noticed at all. Filtering to
   * `upcoming` would make a cancelled meeting simply vanish from the results
   * and look, to a reconciler, exactly like one that had never existed.
   *
   * Paginated by offset rather than cursor — Cal.com's `skip`/`take` — which is
   * why the provider hands the offset back as its page token.
   */
  async listTeamBookings(
    conn: ConnectionRef,
    params: { minStart: Date; maxStart: Date; skip: number; take: number },
  ): Promise<CalComList<CalComBooking>> {
    const q = new URLSearchParams({
      afterStart: params.minStart.toISOString(),
      beforeEnd: params.maxStart.toISOString(),
      sortStart: 'asc',
      take: String(params.take),
      skip: String(params.skip),
    });
    return this.get<CalComList<CalComBooking>>(
      conn,
      `/teams/${this.teamId(conn)}/bookings?${q.toString()}`,
    );
  }

  /** The team roster. */
  async listTeamMemberships(
    conn: ConnectionRef,
    params: { skip: number; take: number },
  ): Promise<CalComList<CalComTeamMembership>> {
    const q = new URLSearchParams({ take: String(params.take), skip: String(params.skip) });
    return this.get<CalComList<CalComTeamMembership>>(
      conn,
      `/teams/${this.teamId(conn)}/memberships?${q.toString()}`,
    );
  }

  /**
   * The team's event types.
   *
   * One request, and no per-member fan-out: unlike Calendly — whose
   * organization scope omits shared event types, forcing a call per user —
   * Cal.com returns the team's round-robin and collective pages from the team
   * endpoint directly.
   */
  async listTeamEventTypes(conn: ConnectionRef): Promise<CalComTeamEventType[]> {
    const body = await this.get<{ data: CalComTeamEventType[] }>(
      conn,
      `/teams/${this.teamId(conn)}/event-types`,
    );
    return body.data ?? [];
  }
}
