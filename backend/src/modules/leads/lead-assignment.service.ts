import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppError } from '../../common/errors';
import { newId } from '../../common/ids';
import { EventsBus } from '../events/events.bus';
import { TENANT_PRISMA, type GuardedPrisma } from '../../prisma/prisma.service';

/** Verbatim from lead_assignments_type_check. */
const MANUAL = 'manual';

/**
 * Who made an assignment, and why — written to lead_assignments.assignment_type
 * and the audit log. Values are verbatim from lead_assignments_type_check and
 * audit_logs_actor_type_check.
 */
export interface AssignedBy {
  actorType: 'user' | 'ai';
  /** users.id for a person; null for the AI. */
  actorId: string | null;
  assignmentType: 'manual' | 'round_robin';
  reason: string;
}

const byOwner = (userId: string): AssignedBy => ({
  actorType: 'user',
  actorId: userId,
  assignmentType: MANUAL,
  reason: 'Assigned manually by the owner',
});
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

  /**
   * `by` defaults to the owner's manual assignment, which is what the owner
   * route passes `callerUserId` for. Automation (the AI booking a meeting during
   * a call) passes its own actor so the history says who really decided.
   */
  async assign(
    organizationId: string,
    callerUserId: string | null,
    leadId: string,
    agentId: string,
    actor?: AssignedBy,
  ): Promise<LeadAssignmentDTO> {
    const by = actor ?? (callerUserId ? byOwner(callerUserId) : null);
    if (!by) throw new Error('assign() needs either a calling user or an explicit actor');
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

      // The agent's row, locked, plus two reads in the same round trip: their
      // membership status, and the lead's current assignment. The latter is
      // safe to read here because the lead lock above already freezes it —
      // nothing else can change it before this transaction ends. The cap count
      // below is NOT read here: it can be moved by another transaction holding
      // this agent's lock, so it must be its own statement, run after the lock
      // is granted and therefore seeing that transaction's commit.
      const agent = await tx.$queryRaw<
        Array<{
          id: string;
          user_id: string;
          display_name: string;
          max_active_leads: number;
          membership_status: string | null;
          current_id: string | null;
          current_agent_id: string | null;
          current_type: string | null;
          current_assigned_at: Date | null;
        }>
      >`
        select ap.id, ap.user_id, ap.display_name, ap.max_active_leads,
               m.status as membership_status,
               cur.id as current_id, cur.agent_id as current_agent_id,
               cur.assignment_type as current_type, cur.assigned_at as current_assigned_at
          from agent_profiles ap
          left join organization_members m
            on m.organization_id = ${organizationId}::uuid and m.user_id = ap.user_id
          left join lateral (
            select la.id, la.agent_id, la.assignment_type, la.assigned_at
              from lead_assignments la
             where la.organization_id = ${organizationId}::uuid and la.lead_id = ${leadId}::uuid and la.is_current
             limit 1
          ) cur on true
         where ap.id = ${agentId}::uuid and ap.organization_id = ${organizationId}::uuid
           for update of ap
      `;
      const profile = agent[0];
      if (!profile) {
        throw new AppError('NOT_FOUND', 'No such agent in this organization');
      }

      if (profile.membership_status !== ACTIVE) {
        throw new AppError('CONFLICT', `${profile.display_name} is not an active member and cannot take leads`);
      }

      const current = profile.current_id
        ? {
            id: profile.current_id,
            agent_id: profile.current_agent_id!,
            assignment_type: profile.current_type!,
            assigned_at: profile.current_assigned_at!,
          }
        : null;

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

      // The outbox seam agent handoff (SMS to the agent) will consume. Written
      // in the same transaction so an assignment and its event exist together
      // or not at all. Nothing reads it yet.
      const event = {
        leadId,
        agentId: profile.id,
        previousAgentId: current?.agent_id ?? null,
        assignmentType: by.assignmentType,
      };
      // The reason is part of the record, so the trail says why this agent.
      const audit = {
        agentId: profile.id,
        agentName: profile.display_name,
        previousAgentId: current?.agent_id ?? null,
        assignmentType: by.assignmentType,
        reason: by.reason,
      };

      // Every write in one statement, inside the same transaction: retire the
      // current row (retired, never deleted — the history of who held a lead is
      // the assignment audit trail the milestone asks for; a null id retires
      // nothing), add the new one, touch the lead, and write the event and the
      // audit row. One round trip instead of five.
      const [created] = await tx.$queryRaw<Array<{ assigned_at: Date }>>`
        with retired as (
          update lead_assignments set is_current = false, unassigned_at = ${now}
           where id = ${current?.id ?? null}::uuid and organization_id = ${organizationId}::uuid
        ), created as (
          insert into lead_assignments (organization_id, lead_id, agent_id, assignment_type, assigned_at)
          values (${organizationId}::uuid, ${leadId}::uuid, ${profile.id}::uuid, ${by.assignmentType}, ${now})
          returning assigned_at
        ), touched as (
          update leads set updated_at = ${now}
           where id = ${leadId}::uuid and organization_id = ${organizationId}::uuid
        ), outbox as (
          insert into domain_events (id, organization_id, aggregate_type, aggregate_id, event_type, payload)
          values (${newId()}::uuid, ${organizationId}::uuid, 'lead', ${leadId}::uuid, 'lead.assigned', ${JSON.stringify(event)}::jsonb)
        ), audited as (
          insert into audit_logs (id, organization_id, actor_type, actor_id, action, entity_type, entity_id, payload)
          values (${newId()}::uuid, ${organizationId}::uuid, ${by.actorType}, ${by.actorId}::uuid,
                  ${current ? 'lead.reassigned' : 'lead.assigned'}, 'lead', ${leadId}::uuid, ${JSON.stringify(audit)}::jsonb)
        )
        select assigned_at from created
      `;

      return {
        leadSourceId: lead[0]!.lead_source_id,
        dto: {
          leadId,
          agent: { id: profile.id, name: profile.display_name },
          assignmentType: by.assignmentType,
          assignedAt: created!.assigned_at,
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
