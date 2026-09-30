import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppError } from '../../common/errors';
import { TENANT_PRISMA, type GuardedPrisma } from '../../prisma/prisma.service';
import { CalendarConnectionsService } from './calendar-connections.service';
import { CalendarReauthRequired, type ConnectionRef } from './calendly.client';
import { CalendarProviderRegistry } from './providers/provider.registry';
import type { NormalizedMember } from './providers/types';
import type {
  CalendarConnectionMetadata,
  CalendarMemberDTO,
  MemberSyncResultDTO,
} from './types';

/** The agent_profiles columns this service reads. */
interface AgentRow {
  id: string;
  display_name: string;
  email: string | null;
  calendly_user_uri: string | null;
  cal_user_id: number | null;
  users: { email: string } | null;
}

/**
 * Who, on the office's scheduling team, is which agent here.
 *
 * This is the join that replaces per-agent connections. Before, a booking
 * belonged to an agent because it came back on that agent's own credential. Now
 * every booking arrives on one office credential and names a scheduling user,
 * so something has to say that Calendly user `.../users/abc`, or Cal.com user
 * `501`, is Alex Vance — and that is
 * `agent_profiles.calendly_user_uri` / `.cal_user_id`, written here.
 *
 * Provider-neutral: which column is written comes from the registry, and the
 * matching rule below is the same either way.
 *
 * Matching is by EMAIL, and only at the moment of linking. Once the id is
 * stored, nothing matches on email again: an agent who changes their address on
 * either side keeps every appointment they already have, and a rename cannot
 * quietly reassign a booking to a colleague.
 *
 * Nothing here invites anybody. Adding an agent to the scheduling team is done
 * in Calendly's or Cal.com's own UI by the account holder.
 */
@Injectable()
export class CalendarRosterService {
  private readonly logger = new Logger(CalendarRosterService.name);

  constructor(
    private readonly providers: CalendarProviderRegistry,
    private readonly connections: CalendarConnectionsService,
    @Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma,
  ) {}

  /**
   * Pull the provider's member list and link it to the agent roster.
   *
   * Safe to re-run: linking is idempotent, and a member already linked to the
   * agent we would choose is left untouched rather than rewritten.
   */
  async syncMembers(organizationId: string): Promise<MemberSyncResultDTO> {
    const conn = await this.requireConnection(organizationId);
    const members = await this.fetchMembers(conn);
    const agents = await this.agents(organizationId);
    const column = this.providers.hostColumn(conn.provider);

    // Index the roster by every address an agent answers to. agent_profiles.email
    // is the one the owner typed on the roster screen and users.email is the one
    // they sign in with; those legitimately differ, and a scheduling seat may
    // have been created from either.
    const byEmail = new Map<string, AgentRow>();
    for (const agent of agents) {
      for (const email of [agent.email, agent.users?.email]) {
        const key = email?.trim().toLowerCase();
        // First writer wins, so a stale profile email never displaces the
        // login address of a different person.
        if (key && !byEmail.has(key)) byEmail.set(key, agent);
      }
    }

    // A member already claimed by an agent. The partial unique index would
    // reject a second claim at the database, which would surface as a 500 in
    // the middle of a sweep; this skips it as the no-op it really is.
    const claimed = new Map<string, AgentRow>();
    for (const agent of agents) {
      const current = this.hostIdOf(agent, column);
      if (current) claimed.set(current, agent);
    }

    let linked = 0;
    let unmatched = 0;

    for (const member of members) {
      const email = member.email?.trim().toLowerCase();
      const agent = email ? byEmail.get(email) : undefined;

      if (!agent) {
        unmatched += 1;
        continue;
      }

      const owner = claimed.get(member.hostId);
      if (owner && owner.id !== agent.id) {
        // Two agents whose emails both point at one scheduling seat. Leaving
        // the existing link alone is the conservative answer: it is the one the
        // synced appointments already reference.
        this.logger.warn(
          `${conn.provider} member ${member.hostId} is already linked to agent ${owner.id}; ` +
            `not relinking to ${agent.id}`,
        );
        continue;
      }

      const url = member.schedulingUrl;
      if (this.hostIdOf(agent, column) === member.hostId) {
        // Already linked. Only the public booking page can have moved.
        await this.prisma.agent_profiles.updateMany({
          where: { id: agent.id, organization_id: organizationId, NOT: { calendly_url: url } },
          data: { calendly_url: url, updated_at: new Date() },
        });
        continue;
      }

      await this.prisma.agent_profiles.updateMany({
        where: { id: agent.id, organization_id: organizationId },
        data: {
          // The column, and the value's TYPE, both come from the provider:
          // Calendly stores a URI as text, Cal.com a user id as an integer.
          [column]: column === 'cal_user_id' ? Number(member.hostId) : member.hostId,
          calendly_url: url,
          updated_at: new Date(),
        },
      });
      this.setHostId(agent, column, member.hostId);
      claimed.set(member.hostId, agent);
      linked += 1;
    }

    await this.stampSyncedAt(conn.id);

    return {
      members: members.length,
      linked,
      unmatched,
      agentsUnlinked: agents.filter((a) => !this.hostIdOf(a, column)).length,
    };
  }

  /**
   * The member list as the owner sees it, each row carrying the agent it
   * resolves to.
   *
   * A read, not a sync: it never writes a link. The owner presses Sync for
   * that, so opening a settings screen cannot change who owns an appointment.
   */
  async listMembers(organizationId: string): Promise<CalendarMemberDTO[]> {
    const conn = await this.requireConnection(organizationId);
    const column = this.providers.hostColumn(conn.provider);
    const [members, agents] = await Promise.all([
      this.fetchMembers(conn),
      this.agents(organizationId),
    ]);

    const byHostId = new Map<string, AgentRow>();
    for (const agent of agents) {
      const id = this.hostIdOf(agent, column);
      if (id) byHostId.set(id, agent);
    }

    return members.map((m) => {
      const agent = byHostId.get(m.hostId) ?? null;
      return {
        schedulingUserId: m.hostId,
        name: m.name,
        email: m.email,
        role: m.role,
        schedulingUrl: m.schedulingUrl ?? '',
        timezone: m.timezone ?? '',
        agentId: agent?.id ?? null,
        agentName: agent?.display_name ?? null,
      };
    });
  }

  /** The host ids this office has linked — what Calendly's event-type fan-out needs. */
  async linkedHostIds(organizationId: string, provider: string): Promise<string[]> {
    const column = this.providers.hostColumn(provider);
    const agents = await this.agents(organizationId);
    return agents.map((a) => this.hostIdOf(a, column)).filter((id): id is string => Boolean(id));
  }

  // ---------------------------------------------------------------------------

  private hostIdOf(agent: AgentRow, column: string): string | null {
    const raw = column === 'cal_user_id' ? agent.cal_user_id : agent.calendly_user_uri;
    return raw === null || raw === undefined ? null : String(raw);
  }

  private setHostId(agent: AgentRow, column: string, value: string): void {
    if (column === 'cal_user_id') agent.cal_user_id = Number(value);
    else agent.calendly_user_uri = value;
  }

  private async requireConnection(organizationId: string): Promise<ConnectionRef> {
    const row = await this.connections.syncableOrgRow(organizationId);
    if (!row) {
      throw new AppError(
        'VALIDATION_ERROR',
        'No scheduling account is connected for this organization yet.',
      );
    }
    return row;
  }

  private async agents(organizationId: string): Promise<AgentRow[]> {
    return this.prisma.agent_profiles.findMany({
      where: { organization_id: organizationId },
      select: {
        id: true,
        display_name: true,
        email: true,
        calendly_user_uri: true,
        cal_user_id: true,
        users: { select: { email: true } },
      },
    });
  }

  private async fetchMembers(conn: ConnectionRef): Promise<NormalizedMember[]> {
    try {
      return await this.providers.get(conn.provider).listMembers(conn);
    } catch (err) {
      if (err instanceof CalendarReauthRequired) {
        await this.connections.markReauthRequired(conn.id, err);
      }
      throw err;
    }
  }

  /** Record that the roster was matched, without disturbing sync bookkeeping. */
  private async stampSyncedAt(connectionId: string): Promise<void> {
    const row = await this.prisma.calendar_connections.findUnique({ where: { id: connectionId } });
    if (!row) return;
    await this.prisma.calendar_connections.update({
      where: { id: connectionId },
      data: {
        metadata: {
          ...((row.metadata ?? {}) as CalendarConnectionMetadata),
          membersSyncedAt: new Date().toISOString(),
        } as object,
        updated_at: new Date(),
      },
    });
  }
}
