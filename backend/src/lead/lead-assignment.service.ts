import { Injectable } from '@nestjs/common';
import { AssignmentType, Prisma, type ActorType } from '@prisma/client';
import { AuditService } from '@/audit/audit.service';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { EventsBus } from '@/events/events.bus';
import { INACTIVE_STATUSES } from './lead-status';
import { AGENT_ROLE_WHERE, fullName } from './lead-scope';

export interface AssignedBy {
  actorType: Extract<ActorType, 'user' | 'ai'>;
  actorId: string | null;
  assignmentType: AssignmentType;
  reason: string;
}

export interface LeadAssignmentDTO {
  leadId: string;
  agent: { id: string; name: string };
  assignmentType: AssignmentType;
  assignedAt: Date;
  /** False when the lead was already with this user and nothing was written. */
  changed: boolean;
}

/** A second request for the same lead waits on its row lock; give it time. */
const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 };

/** Leads an agent is holding that still count against their cap. */
export const activeLeadsOf = (orgId: string, userId: string) =>
  ({ orgId, assignedToId: userId, status: { notIn: INACTIVE_STATUSES } }) satisfies Prisma.LeadWhereInput;

/**
 * Handing a lead to a user who takes leads. The lead row and then the user row
 * are locked for the whole transaction, so two assignments of one lead
 * serialise, and two leads racing onto an agent's last free slot cannot both
 * get it. The cap is enforced, never overridden.
 */
@Injectable()
export class LeadAssignmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: EventsBus,
  ) {}

  async assign(orgId: string, leadId: string, userId: string, by: AssignedBy): Promise<LeadAssignmentDTO> {
    const result = await this.withLockTimeout(() =>
      this.prisma.$transaction(async (tx) => {
        const [lead] = await tx.$queryRaw<{ id: string; lead_source_id: string | null; assigned_to_id: string | null }[]>`
          SELECT id, lead_source_id, assigned_to_id FROM leads
           WHERE id = ${leadId}::uuid AND organization_id = ${orgId}::uuid
           FOR UPDATE`;
        if (!lead) throw new AppError('NOT_FOUND', 'No such lead in this organization');

        const [user] = await tx.$queryRaw<{ id: string; first_name: string; last_name: string; max_active_leads: number }[]>`
          SELECT id, first_name, last_name, max_active_leads FROM users
           WHERE id = ${userId}::uuid AND organization_id = ${orgId}::uuid
           FOR UPDATE`;
        if (!user) throw new AppError('NOT_FOUND', 'No such agent in this organization');
        const name = fullName(user.first_name, user.last_name);

        const takesLeads = await tx.user.count({
          where: { id: userId, orgId, status: 'active', roles: { some: { role: AGENT_ROLE_WHERE } } },
        });
        if (!takesLeads) throw new AppError('CONFLICT', `${name} is not an active agent and cannot take leads`);

        const current = await tx.lead.findUniqueOrThrow({
          where: { id: leadId },
          select: { assignedToId: true, assignmentType: true, assignedAt: true },
        });
        if (current.assignedToId === userId) {
          return {
            leadSourceId: lead.lead_source_id,
            dto: {
              leadId,
              agent: { id: userId, name },
              assignmentType: current.assignmentType ?? by.assignmentType,
              assignedAt: current.assignedAt ?? new Date(),
              changed: false,
            },
          };
        }

        const held = await tx.lead.count({ where: activeLeadsOf(orgId, userId) });
        if (held >= user.max_active_leads) {
          throw new AppError(
            'CONFLICT',
            `${name} is at their lead cap (${held}/${user.max_active_leads}). Raise the cap on Team Members or choose another agent.`,
          );
        }

        const assignedAt = new Date();
        await tx.lead.update({
          where: { id: leadId },
          data: { assignedToId: userId, assignedAt, assignmentType: by.assignmentType },
        });
        await this.audit.record(
          {
            orgId,
            actorType: by.actorType,
            actorId: by.actorId,
            action: current.assignedToId ? 'lead.reassigned' : 'lead.assigned',
            entityType: 'lead',
            entityId: leadId,
            payload: {
              agentId: userId,
              agentName: name,
              previousAgentId: current.assignedToId,
              assignmentType: by.assignmentType,
              reason: by.reason,
            },
          },
          tx,
        );
        return {
          leadSourceId: lead.lead_source_id,
          dto: { leadId, agent: { id: userId, name }, assignmentType: by.assignmentType, assignedAt, changed: true },
        };
      }, TX_OPTIONS),
    );

    if (result.dto.changed) {
      this.events.publish({ organizationId: orgId, type: 'lead.assigned', leadSourceId: result.leadSourceId });
    }
    return result.dto;
  }

  /** P2028: the lock queue outlasted the transaction. Nothing was written, so it is retryable. */
  private async withLockTimeout<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2028') {
        throw new AppError('CONFLICT', 'This lead is being updated by someone else. Try again in a moment.');
      }
      throw error;
    }
  }
}
