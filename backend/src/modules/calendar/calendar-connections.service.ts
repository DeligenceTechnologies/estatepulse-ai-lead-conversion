import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { sha256Hex } from '../../common/crypto';
import { AppError } from '../../common/errors';
import { newId } from '../../common/ids';
import { TENANT_PRISMA, type GuardedPrisma } from '../../prisma/prisma.service';
import { CalendarReauthRequired, CalendlyClientService, type ConnectionRef } from './calendly.client';
import { CalComClientService } from './providers/calcom.client';
import type { CalComConnectionMetadata } from './providers/calcom.types';
import type {
  CalendarConnectionDTO,
  CalendarConnectionMetadata,
  CalendarStatusDTO,
  CalComTeamOptionDTO,
  OrganizationCalendarStatusDTO,
} from './types';

const PROVIDER = 'calendly';
const CAL_PROVIDER = 'cal';

/** How long an OAuth attempt may sit half-finished before it is swept. */
const STATE_TTL_MS = 15 * 60 * 1000;

/** Calendly roles permitted to read `?organization=`-scoped collections. */
const ADMIN_ROLES = new Set(['owner', 'admin']);

/**
 * Owns the ORGANIZATION's `calendar_connections` row.
 *
 * One office, one scheduling account, one row — `agent_id IS NULL`, enforced by
 * calendar_connections_org_one_active. Agents do not connect anything: they are
 * invited into the office's Calendly organization or Cal.com team and manage
 * availability there, and we read every member's bookings through the one
 * credential.
 *
 * Note the index has no `provider` in its key. Calendly and Cal.com are
 * ALTERNATIVES: connecting one retires the other, because two live providers
 * would sweep the same office twice and a lead who booked on both would become
 * two appointments.
 *
 * The two connect flows are genuinely different and are not forced into a
 * shared shape. Calendly is OAuth — a browser round trip through a consent
 * screen, a rotating refresh token, and a half-finished row waiting for the
 * callback. Cal.com is an API key the owner pastes, which is verified once and
 * then simply stored.
 *
 * Rows that DO carry an agent_id are the retired per-agent connections from
 * before 20260922000002. Nothing here reads them; they survive only because
 * appointments.calendar_connection_id references them.
 *
 * Status vocabulary is dictated by calendar_connections_status_check, which
 * permits only active | inactive | error. There is no 'pending', so an
 * in-flight OAuth attempt is an 'inactive' row carrying `metadata.stateHash`
 * and no credentials — that combination IS the pending marker, and clearing
 * stateHash is what completes it.
 */
@Injectable()
export class CalendarConnectionsService {
  private readonly logger = new Logger(CalendarConnectionsService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly calendly: CalendlyClientService,
    private readonly calcom: CalComClientService,
    @Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma,
  ) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * The office's scheduling connection, if it has one.
   *
   * Deliberately NOT filtered by provider. There is one office calendar and it
   * is whichever provider is connected — filtering here would make "is anything
   * connected?" a question you could only answer by asking twice, and would let
   * a stale Calendly row hide a live Cal.com one.
   *
   * `agent_id: null` is the whole predicate that separates an office connection
   * from the retired per-agent rows, so it is never optional here.
   */
  async activeOrgRow(organizationId: string) {
    return this.prisma.calendar_connections.findFirst({
      where: { organization_id: organizationId, agent_id: null },
      // 'active' first, then the most recent of whatever else is there, so a
      // parked 'error' row surfaces instead of an older disconnect.
      orderBy: [{ status: 'asc' }, { updated_at: 'desc' }],
    });
  }

  /** The connection a sweep can actually use: active, with credentials on file. */
  async syncableOrgRow(organizationId: string) {
    const row = await this.activeOrgRow(organizationId);
    if (!row || row.status !== 'active' || !row.credentials_secret_ref) return null;
    return row;
  }

  /** The owner's view of the office calendar, whichever provider it is. */
  async status(organizationId: string): Promise<OrganizationCalendarStatusDTO> {
    const row = await this.activeOrgRow(organizationId);
    const visible = row && !this.isPending(row) ? row : null;
    const meta = (visible?.metadata ?? {}) as CalComConnectionMetadata;

    return {
      provider: visible?.provider ?? null,
      providers: this.providerStatuses(),
      syncEnabled: this.config.get<string>('CALENDAR_SYNC') === '1',
      connection: visible ? this.toDto(visible) : null,
      // Calendly identifies an organization only by URI, so there is no name to
      // show; Cal.com gives the team a real one.
      workspaceName: visible?.provider === CAL_PROVIDER ? (meta.calTeamName ?? null) : null,
      workspaceRole:
        visible?.provider === CAL_PROVIDER
          ? (meta.calTeamRole ?? null)
          : (meta.calendlyOrgRole ?? null),
      membersSyncedAt: meta.membersSyncedAt ?? null,
    };
  }

  /**
   * What this deployment can offer.
   *
   * The asymmetry is real and worth surfacing rather than smoothing over:
   * Calendly needs an OAuth app registered on the SERVER, so an operator who
   * has not set one up cannot offer it to anybody. Cal.com needs nothing of the
   * sort — the office pastes a key it generated itself — so it is always
   * available, which is exactly why it is the cheaper way to start.
   */
  private providerStatuses() {
    const calendlyOk = this.calendly.isConfigured();
    return [
      {
        id: PROVIDER,
        label: 'Calendly',
        canConnect: calendlyOk,
        reason: calendlyOk
          ? null
          : 'Calendly is not configured on this server. Ask your administrator to set CALENDLY_CLIENT_ID and CALENDLY_CLIENT_SECRET.',
      },
      {
        id: CAL_PROVIDER,
        label: 'Cal.com',
        canConnect: this.calcom.isConfigured(),
        reason: null,
      },
    ];
  }

  /**
   * An agent's view: is the office connected, and am I on its Calendly?
   *
   * Nothing here is actionable by the agent — there is no token of theirs to
   * connect or revoke — so it answers only those two questions and says
   * nothing about the office's credentials.
   */
  async agentStatus(organizationId: string, agentId: string): Promise<CalendarStatusDTO> {
    const [row, profile] = await Promise.all([
      this.activeOrgRow(organizationId),
      this.prisma.agent_profiles.findFirst({
        where: { id: agentId, organization_id: organizationId },
        select: { calendly_user_uri: true, cal_user_id: true, calendly_url: true },
      }),
    ]);

    const live = row && row.status === 'active' && Boolean(row.credentials_secret_ref);
    // The link that counts is the one for the CONNECTED provider. An office
    // that switched from Calendly still has calendly_user_uri on every agent,
    // and reporting that as "linked" would tell an agent their Cal.com bookings
    // will be attributed when they will not.
    const hostId =
      row?.provider === CAL_PROVIDER ? profile?.cal_user_id : profile?.calendly_user_uri;

    return {
      organizationConnected: Boolean(live),
      provider: live ? row.provider : null,
      syncEnabled: this.config.get<string>('CALENDAR_SYNC') === '1',
      schedulingUserId: live && hostId != null ? String(hostId) : null,
      schedulingUrl: profile?.calendly_url ?? null,
      lastSyncedAt: live ? (row.last_synced_at?.toISOString() ?? null) : null,
    };
  }

  /** An 'inactive' row that is really a half-finished OAuth attempt. */
  private isPending(row: { status: string; metadata: unknown }): boolean {
    const meta = (row.metadata ?? {}) as CalendarConnectionMetadata;
    return row.status === 'inactive' && Boolean(meta.stateHash);
  }

  /**
   * The row as the SPA may see it.
   *
   * `metadata` still holds the connecting account's name, timezone,
   * scheduling URL and connectedAt. They are kept as provenance — "who
   * authorized this, and when" is the first question when a connection
   * misbehaves — but deliberately NOT returned: see CalendarConnectionDTO.
   */
  toDto(row: {
    status: string;
    credentials_secret_ref: string | null;
    last_synced_at: Date | null;
    metadata: unknown;
  }): CalendarConnectionDTO {
    const meta = (row.metadata ?? {}) as CalendarConnectionMetadata;
    return {
      status: row.status as CalendarConnectionDTO['status'],
      connected: row.status === 'active' && Boolean(row.credentials_secret_ref),
      email: meta.email ?? null,
      lastSyncedAt: row.last_synced_at?.toISOString() ?? null,
      lastError: meta.lastError ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // OAuth
  // -------------------------------------------------------------------------

  /**
   * Begin an authorization. Returns the URL the browser must visit.
   *
   * The row is created up front so the callback — which arrives with no session
   * — has something to resolve. Its id is generated here rather than by the
   * database because the token AAD binds to it (see common/ids.ts).
   */
  async startOAuth(organizationId: string): Promise<{ authorizeUrl: string }> {
    if (!this.calendly.isConfigured()) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Calendly is not configured on this server. Set CALENDLY_CLIENT_ID and CALENDLY_CLIENT_SECRET.',
      );
    }

    const connectionId = newId();
    // The nonce is the secret, NOT the connection id: ids are time-ordered
    // UUIDv7 and therefore guessable by design.
    const nonce = randomBytes(32).toString('base64url');

    await this.prisma.calendar_connections.create({
      data: {
        id: connectionId,
        organization_id: organizationId,
        // NULL is what makes this the office's connection rather than one
        // agent's. See calendar_connections_org_active_unique.
        agent_id: null,
        provider: PROVIDER,
        status: 'inactive',
        credentials_secret_ref: null,
        metadata: {
          stateHash: sha256Hex(nonce),
          startedAt: new Date().toISOString(),
        } as object,
      },
    });

    return { authorizeUrl: this.calendly.authorizeUrl(`${connectionId}.${nonce}`) };
  }

  /**
   * Finish an authorization.
   *
   * Runs unauthenticated — Calendly redirects a browser here with no session —
   * so the signed state is the only thing standing between a stranger and a
   * write. The organization is DISCOVERED from the row, never accepted from the
   * request; `id` is in GLOBAL_UNIQUE_KEYS, so the tenancy guard is satisfied
   * without a session to scope by.
   */
  async completeOAuth(state: string, code: string): Promise<void> {
    const [connectionId, nonce] = state.split('.');
    if (!connectionId || !nonce) {
      throw new AppError('VALIDATION_ERROR', 'Malformed OAuth state');
    }

    const row = await this.prisma.calendar_connections.findUnique({ where: { id: connectionId } });
    if (!row || row.provider !== PROVIDER) {
      throw new AppError('NOT_FOUND', 'Unknown or expired authorization attempt');
    }

    const meta = (row.metadata ?? {}) as CalendarConnectionMetadata;
    if (!meta.stateHash || !this.nonceMatches(nonce, meta.stateHash)) {
      throw new AppError('FORBIDDEN', 'Authorization state did not match');
    }
    if (!meta.startedAt || Date.now() - Date.parse(meta.startedAt) > STATE_TTL_MS) {
      await this.prisma.calendar_connections.delete({ where: { id: connectionId } });
      throw new AppError('VALIDATION_ERROR', 'Authorization attempt expired — please try again');
    }

    const tokens = await this.calendly.exchangeCode(code);
    const me = await this.calendly.meWithToken(tokens.access_token);

    // Everything office-level reads `?organization=`, so a token that cannot
    // is useless to us. Calendly answers those collections for an owner or an
    // admin and 403s a plain 'user' — and it 403s on the first SWEEP, not
    // here, which would leave a connection that reads "Connected" and silently
    // syncs nothing. Refusing now costs one request and gives the person a
    // message while they still have the other Calendly login open.
    const membership = await this.calendly.membershipWithToken(tokens.access_token, me.uri);
    const role = membership?.role?.toLowerCase() ?? null;
    if (!membership || !role || !ADMIN_ROLES.has(role)) {
      // The half-finished row is removed so the next attempt starts clean; the
      // token is revoked because we are about to forget it and it would
      // otherwise sit live on the customer's Calendly account for two hours.
      await this.calendly.revoke(tokens.access_token);
      await this.prisma.calendar_connections.delete({ where: { id: connectionId } });
      throw new AppError(
        'FORBIDDEN',
        `${me.email} is a ${role ?? 'non-member'} of its Calendly organization. ` +
          'Connect with a Calendly owner or admin account — only those can read the ' +
          "whole team's bookings.",
      );
    }

    // Retire any previous office connection BEFORE activating the new one:
    // calendar_connections_org_active_unique permits exactly one active row per
    // (organization, provider) where agent_id IS NULL, so the order is
    // load-bearing.
    await this.deactivateOthers(row.organization_id, connectionId);

    await this.prisma.calendar_connections.update({
      where: { id: connectionId },
      data: {
        status: 'active',
        external_account_id: me.uri.split('/').pop()?.slice(0, 255) ?? null,
        credentials_secret_ref: this.calendly.encrypt(row.organization_id, connectionId, {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
        }),
        metadata: {
          email: me.email,
          name: me.name,
          timezone: me.timezone,
          schedulingUrl: me.scheduling_url,
          calendlyUserUri: me.uri,
          // Taken from the MEMBERSHIP, not from `me.current_organization`.
          // They agree today, but the membership is the record that actually
          // grants the role we just checked, so reading the org from anywhere
          // else would let the two drift apart unnoticed.
          calendlyOrgUri: membership.organization,
          calendlyOrgRole: role,
          scope: tokens.scope,
          tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
          connectedAt: new Date().toISOString(),
          // stateHash and startedAt are dropped: the attempt is complete, and
          // leaving them would make this look pending forever.
        } as object,
        updated_at: new Date(),
      },
    });

    this.logger.log(
      `office calendar connected for organization ${row.organization_id} ` +
        `(${me.email}, ${role} of ${membership.organization})`,
    );
  }

  private nonceMatches(nonce: string, expectedHash: string): boolean {
    const got = Buffer.from(sha256Hex(nonce));
    const want = Buffer.from(expectedHash);
    // timingSafeEqual throws on a length mismatch, which must not become a 500.
    return got.length === want.length && timingSafeEqual(got, want);
  }

  /**
   * Retire every other live office connection, whichever provider it belongs
   * to.
   *
   * No `provider` predicate, and that is the point: connecting Cal.com is how
   * an office switches AWAY from Calendly. calendar_connections_org_one_active
   * would reject the new row otherwise, so this runs first — and the credential
   * is cleared on the way out rather than left decrypting-able on a row nobody
   * will look at again.
   */
  private async deactivateOthers(organizationId: string, keepId: string) {
    await this.prisma.calendar_connections.updateMany({
      where: {
        organization_id: organizationId,
        agent_id: null,
        status: 'active',
        NOT: { id: keepId },
      },
      data: { status: 'inactive', credentials_secret_ref: null, updated_at: new Date() },
    });
  }

  // -------------------------------------------------------------------------
  // Cal.com — an API key, not a consent screen
  // -------------------------------------------------------------------------

  /**
   * Check a pasted key and report the teams it can see.
   *
   * A separate step from connecting because the office has a choice to make:
   * one Cal.com user may belong to several teams, and which one this office
   * books through is not something we can infer. Nothing is written here, so a
   * mistyped key costs a round trip and no state.
   *
   * ORGANIZATIONS are listed but marked, not hidden. A Cal.com organization is
   * a separate paid tier served by different endpoints, and an owner shown an
   * empty list would reasonably conclude their key was wrong rather than that
   * their workspace is the wrong kind.
   */
  async verifyCalKey(apiKey: string): Promise<{ email: string; teams: CalComTeamOptionDTO[] }> {
    const key = apiKey.trim();
    if (!key) throw new AppError('VALIDATION_ERROR', 'Paste your Cal.com API key');

    const me = await this.calcom.meWithKey(key);
    const teams = await this.calcom.teamsWithKey(key);

    return {
      email: me.email,
      teams: teams.map((t) => ({
        id: t.id,
        name: t.name,
        slug: t.slug ?? null,
        isOrganization: Boolean(t.isOrganization),
      })),
    };
  }

  /**
   * Store a verified key against one team.
   *
   * The key is re-verified here rather than trusted from the earlier call: the
   * two requests are independent, and a key that has been revoked in between
   * must not become a connection that looks healthy until the first sweep.
   *
   * The team is re-fetched for the same reason, and because its SLUG is what
   * every bookable link is built from — a connection without it can list event
   * types but cannot say where any of them are booked.
   */
  async connectCalCom(
    organizationId: string,
    input: { apiKey: string; teamId: number },
  ): Promise<void> {
    const key = input.apiKey.trim();
    const me = await this.calcom.meWithKey(key);
    const teams = await this.calcom.teamsWithKey(key);
    const team = teams.find((t) => t.id === input.teamId);

    if (!team) {
      throw new AppError(
        'VALIDATION_ERROR',
        'That Cal.com team is not one this API key can see. Pick another, or use a key from an account on that team.',
      );
    }
    if (team.isOrganization) {
      throw new AppError(
        'VALIDATION_ERROR',
        `"${team.name}" is a Cal.com organization, not a team. Pick one of its teams instead — organization-wide booking needs Cal.com's organizations plan.`,
      );
    }

    const connectionId = newId();
    // Retire whatever was live BEFORE inserting: calendar_connections_org_one_active
    // permits exactly one active office row across providers, so this is what
    // makes "connect Cal.com" mean "switch from Calendly".
    await this.deactivateOthers(organizationId, connectionId);

    const metadata: CalComConnectionMetadata = {
      email: me.email,
      name: me.name,
      timezone: me.timeZone,
      calUserId: me.id,
      calTeamId: team.id,
      calTeamName: team.name,
      calTeamSlug: team.slug ?? undefined,
      connectedAt: new Date().toISOString(),
    };

    await this.prisma.calendar_connections.create({
      data: {
        id: connectionId,
        organization_id: organizationId,
        // NULL: the office's connection, not an agent's.
        agent_id: null,
        provider: CAL_PROVIDER,
        status: 'active',
        external_account_id: String(me.id).slice(0, 255),
        credentials_secret_ref: this.calcom.encrypt(organizationId, connectionId, key),
        metadata: metadata as object,
      },
    });

    this.logger.log(
      `office calendar connected for organization ${organizationId} ` +
        `(cal.com ${me.email}, team ${team.id} "${team.name}")`,
    );
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * Disconnect the office calendar.
   *
   * The appointments already synced are KEPT — they are history, and a lead's
   * booked meeting does not stop having happened because the office unlinked
   * its calendar. So is every agent's host link: the agents are still on the
   * customer's Calendly organization or Cal.com team, and clearing the links
   * would mean a reconnect starts by failing to place hosts it had already
   * placed.
   */
  async disconnect(organizationId: string): Promise<void> {
    const row = await this.activeOrgRow(organizationId);
    if (!row) return;

    // Calendly issued us a token, so we hand it back. Cal.com's key belongs to
    // the customer and was generated by them — revoking it would reach past our
    // own integration into an account credential they may use elsewhere, so we
    // simply forget it and leave the revoking to them.
    if (row.provider === PROVIDER && row.credentials_secret_ref) {
      try {
        const tokens = this.calendly.decrypt(row as ConnectionRef);
        await this.calendly.revoke(tokens.access_token);
      } catch (err) {
        // A credential we can no longer decrypt is exactly the case where the
        // user most needs the disconnect to succeed.
        this.logger.warn(`revoke skipped for ${row.id}: ${String(err)}`);
      }
    }

    await this.prisma.calendar_connections.update({
      where: { id: row.id },
      data: {
        status: 'inactive',
        credentials_secret_ref: null,
        metadata: {} as object,
        updated_at: new Date(),
      },
    });
  }

  /** Park a connection that Calendly will no longer accept our credentials for. */
  async markReauthRequired(connectionId: string, err: unknown): Promise<void> {
    const row = await this.prisma.calendar_connections.findUnique({ where: { id: connectionId } });
    if (!row) return;

    await this.prisma.calendar_connections.update({
      where: { id: connectionId },
      data: {
        status: 'error',
        credentials_secret_ref: null,
        metadata: {
          ...((row.metadata ?? {}) as CalendarConnectionMetadata),
          lastError:
            err instanceof CalendarReauthRequired
              ? 'Calendly access was revoked or expired. Reconnect to resume syncing.'
              : String(err).slice(0, 300),
        } as object,
        updated_at: new Date(),
      },
    });
  }

  /** Record a transient failure without tearing the connection down. */
  async recordSyncError(connectionId: string, message: string): Promise<void> {
    const row = await this.prisma.calendar_connections.findUnique({ where: { id: connectionId } });
    if (!row) return;

    const meta = (row.metadata ?? {}) as CalendarConnectionMetadata;
    await this.prisma.calendar_connections.update({
      where: { id: connectionId },
      data: {
        metadata: {
          ...meta,
          lastError: message.slice(0, 300),
          consecutiveFailures: (meta.consecutiveFailures ?? 0) + 1,
        } as object,
        updated_at: new Date(),
      },
    });
  }

  async recordSyncSuccess(connectionId: string): Promise<void> {
    const row = await this.prisma.calendar_connections.findUnique({ where: { id: connectionId } });
    if (!row) return;

    const meta = (row.metadata ?? {}) as CalendarConnectionMetadata;
    delete meta.lastError;
    await this.prisma.calendar_connections.update({
      where: { id: connectionId },
      data: {
        last_synced_at: new Date(),
        metadata: { ...meta, consecutiveFailures: 0 } as object,
        updated_at: new Date(),
      },
    });
  }
}
