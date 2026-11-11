import { Injectable } from '@nestjs/common';
import { AuditService } from '@/audit/audit.service';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { RELEASABLE_LEAD } from '@/google-sheets/approval';
import { LeadStateService } from './lead-state.service';

export interface ReviewApproval {
  /** Unpaused: the lead watcher enrolls it on its next tick. */
  released: boolean;
  /** Approved but still paused, because outreach could not reach it anyway. */
  held: 'DO_NOT_CONTACT' | 'NO_DIALABLE_PHONE' | 'NOT_RELEASABLE' | null;
}

/**
 * A lead that arrived with something worth a look (a warning from its form, a
 * phone that could not be parsed) starts paused. A person approving it clears
 * the reasons and, when it can still be contacted, lets outreach start.
 */
@Injectable()
export class LeadReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly state: LeadStateService,
  ) {}

  async approve(orgId: string, userId: string, leadId: string): Promise<ReviewApproval> {
    const result = await this.prisma.$transaction(async (tx) => {
      const lead = await tx.lead.findFirst({
        where: { id: leadId, orgId },
        select: { needsReview: true, reviewReasons: true, automationPaused: true, dncStatus: true, normalizedPhone: true },
      });
      if (!lead) throw new AppError('NOT_FOUND', 'That lead no longer exists.');
      if (!lead.needsReview) throw new AppError('CONFLICT', 'This lead is not waiting for review.');

      await tx.lead.update({ where: { id: leadId }, data: { needsReview: false, reviewReasons: [] } });
      const released = await tx.$queryRaw<{ id: string }[]>`
        UPDATE leads AS l
           SET automation_paused = false, updated_at = now()
         WHERE l.organization_id = ${orgId}::uuid AND l.id = ${leadId}::uuid AND ${RELEASABLE_LEAD}
        RETURNING l.id`;
      await this.audit.record(
        {
          orgId,
          actorType: 'user',
          actorId: userId,
          action: 'lead.review_approved',
          entityType: 'lead',
          entityId: leadId,
          payload: { reasons: lead.reviewReasons, released: released.length > 0 },
        },
        tx,
      );
      return { lead, released: released.length > 0 };
    });

    this.state.quietly({ orgId, leadId, type: 'review_approved', source: 'user', actor: { type: 'user', id: userId }, reason: 'Approved at review' });
    const { lead, released } = result;
    // Not paused to begin with (flagged mid-outreach): there was nothing to hold back.
    if (released || !lead.automationPaused) return { released, held: null };
    return {
      released,
      // Otherwise it was contacted already, closed, or an agent holds its chat.
      held: lead.dncStatus ? 'DO_NOT_CONTACT' : !lead.normalizedPhone ? 'NO_DIALABLE_PHONE' : 'NOT_RELEASABLE',
    };
  }
}
