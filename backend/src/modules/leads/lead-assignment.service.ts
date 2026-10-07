import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppError } from '../../common/errors';
import { newId } from '../../common/ids';
import { EventsBus } from '../events/events.bus';
import { TENANT_PRISMA, type GuardedPrisma } from '../../prisma/prisma.service';

/** Verbatim from lead_assignments_type_check. */
const MANUAL = 'manual';
/** Verbatim from organization_members_status_check. */
const ACTIVE = 'active';

/**
 * Prisma's interactive-transaction defaults (2s to get a connection, 5s to
 * run) are sized for uncontended work. Here a second request for the same lead
 * WAITS on the row lock by design, and against a remote database each waiter
 * holds its turn for several round trips, so a small burst — a double click,
 * two owners in two tabs — would otherwise time out as a 500 while doing
 * exactly what it should.
 */
const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 };

export interface LeadAssignmentDTO {
  leadId: string;
  agent: { id: string; name: string };
  assignmentType: string;
  assignedAt: Date;
  /** False when the lead was already with this agent and nothing was written. */
  changed: boolean;
}

/**
 * An owner handing a lead to an agent by hand.
 *
 * "Agent" means an agent_profiles row, whatever the member's role: an owner who
 * takes leads is assignable exactly like anyone else, which is what makes a
 * one-person office work. The profile's member must be active — a suspended
 * agent cannot sign in to work the lead.
 *
 * One current assignment per lead is the invariant, and nothing in the schema
 * enforces it (there is no partial unique index on is_current). It is held
 * here instead: the lead row is locked FOR UPDATE for the whole transaction, so
 * two concurrent assigns of one lead serialise and the second sees — and
 * retires — the first's row rather than adding a sibling to it. The agent's
 * profile row is locked too, so two different leads racing onto an agent's
 * last free slot cannot both get it. Lock order is always lead, then agent,
 * so two of these transactions cannot deadlock on each other.
 *
 * The lead cap is enforced, not overridden: an owner who wants to exceed it
 * raises the cap on the Agent Team page, which is a visible decision rather
 * than a silent one.
 */
@Injectable()
export class LeadAssignmentService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma,
    private readonly events: EventsBus,
  ) {}

  async assign(
    organizationId: string,
    callerUserId: string,
    leadId: string,
    agentId: string,
  ): Promise<LeadAssignmentDTO> {
    const result = await this.withLockTimeout(() => this.prisma.$transaction(async (tx) => {
      // Scoped by organization in the same statement that locks it, so a lead
      // id from another tenant is simply not found — the same 404 as a lead
      // that does not exist, which confirms nothing about other tenants.
      const lead = await tx.$queryRaw<Array<{ id: string; lead_source_id: string | null }>>`
        select id, lead_source_id from leads
         where id = ${leadId}::uuid and organization_id = ${organizationId}::uuid
         for update
      `;
      if (lead.length === 0) {
        throw new AppError('NOT_FOUND', 'No such lead in this organization');
      }

      const agent = await tx.$queryRaw<
        Array<{ id: string; user_id: string; display_name: string; max_active_leads: number }>
      >`
        select id, user_id, display_name, max_active_leads from agent_profiles
         where id = ${agentId}::uuid and organization_id = ${organizationId}::uuid
         for update
      `;
      const profile = agent[0];
      if (!profile) {
        throw new AppError('NOT_FOUND', 'No such agent in this organization');
      }

      const membership = await tx.organization_members.findFirst({
        where: { organization_id: organizationId, user_id: profile.user_id },
        select: { status: true },
      });
      if (membership?.status !== ACTIVE) {
        throw new AppError('CONFLICT', `${profile.display_name} is not an active member and cannot take leads`);
      }

      const current = await tx.lead_assignments.findFirst({
        where: { organization_id: organizationId, lead_id: leadId, is_current: true },
        select: { id: true, agent_id: true, assignment_type: true, assigned_at: true },
      });

      // Already theirs: answer as a success and write nothing, so a double
      // click or a re-save cannot churn the history or the audit log.
      if (current?.agent_id === profile.id) {
        return {
          leadSourceId: lead[0]!.lead_source_id,
          dto: {
            leadId,
            agent: { id: profile.id, name: profile.display_name },
            assignmentType: current.assignment_type,
            assignedAt: current.assigned_at,
            changed: false,
          },
        };
      }

      // The same count the roster shows as "Active Leads", so the number the
      // owner reads beside the agent is the number enforced here.
      const held = await tx.lead_assignments.count({
        where: { organization_id: organizationId, agent_id: profile.id, is_current: true },
      });
      if (held >= profile.max_active_leads) {
        throw new AppError(
          'CONFLICT',
          `${profile.display_name} is at their lead cap (${held}/${profile.max_active_leads}). ` +
            'Raise the cap on the Agent Team page or choose another agent.',
        );
      }

      const now = new Date();
      if (current) {
        // Retired, never deleted: the history of who held a lead is the
        // assignment audit trail the milestone asks for.
        await tx.lead_assignments.update({
          where: { id: current.id },
          data: { is_current: false, unassigned_at: now },
        });
      }

      const created = await tx.lead_assignments.create({
        data: {
          organization_id: organizationId,
          lead_id: leadId,
          agent_id: profile.id,
          assignment_type: MANUAL,
          assigned_at: now,
        },
        select: { assigned_at: true },
      });

      await tx.leads.update({
        where: { id: leadId },
        data: { updated_at: now },
      });

      // The outbox seam agent handoff (SMS to the agent) will consume. Written
      // in the same transaction so an assignment and its event exist together
      // or not at all. Nothing reads it yet.
      await tx.domain_events.create({
        data: {
          id: newId(),
          organization_id: organizationId,
          aggregate_type: 'lead',
          aggregate_id: leadId,
          event_type: 'lead.assigned',
          payload: {
            leadId,
            agentId: profile.id,
            previousAgentId: current?.agent_id ?? null,
            assignmentType: MANUAL,
          } as never,
        },
      });

      await tx.audit_logs.create({
        data: {
          id: newId(),
          organization_id: organizationId,
          actor_type: 'user',
          actor_id: callerUserId,
          action: current ? 'lead.reassigned' : 'lead.assigned',
          entity_type: 'lead',
          entity_id: leadId,
          // The reason is part of the record: "manual, by this owner" is the
          // assignment reason for every row this path writes.
          payload: {
            agentId: profile.id,
            agentName: profile.display_name,
            previousAgentId: current?.agent_id ?? null,
            assignmentType: MANUAL,
            reason: 'Assigned manually by the owner',
          } as never,
        },
      });

      return {
        leadSourceId: lead[0]!.lead_source_id,
        dto: {
          leadId,
          agent: { id: profile.id, name: profile.display_name },
          assignmentType: MANUAL,
          assignedAt: created.assigned_at,
          changed: true,
        },
      };
    }, TX_OPTIONS));

    // After the commit, so a browser refetching on this event reads the new row.
    if (result.dto.changed) {
      this.events.publish({ organizationId, type: 'lead.assigned', leadSourceId: result.leadSourceId });
    }
    return result.dto;
  }

  /**
   * P2028 is Prisma giving up on the transaction itself — no connection in
   * time, or the lock queue outlasted the timeout. Nothing was written (the
   * transaction rolled back), so it is a retryable conflict for the owner, not
   * a server fault.
   */
  private async withLockTimeout<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2028') {
        throw new AppError('CONFLICT', 'This lead is being updated by someone else. Try again in a moment.');
      }
      throw err;
    }
  }
}
