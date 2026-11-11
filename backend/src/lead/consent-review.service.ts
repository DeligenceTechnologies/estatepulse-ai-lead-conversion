import { Injectable } from '@nestjs/common';
import { ConsentStatus, Prisma } from '@prisma/client';
import { AuditService } from '@/audit/audit.service';
import { PrismaService } from '@/common/prisma/prisma.service';
import { AWAITING_CONSENT_REVIEW, CONSENT_REVIEW_REASON } from './consent';
import { fullName } from './lead-scope';
import { LeadStateService } from './lead-state.service';

const REJECTED_REASON = 'Rejected at consent review';

export interface ConsentReviewItem {
  leadId: string;
  name: string;
  phone: string | null;
  email: string | null;
  addedAt: Date;
}

/**
 * Manual leads added without consent (ManualLeadService), held in Import
 * Review. Recording the consent makes one an ordinary lead: unpaused, it is
 * picked up by the lead watcher like any new lead. Rejecting closes it.
 */
@Injectable()
export class ConsentReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly state: LeadStateService,
  ) {}

  async list(orgId: string): Promise<{ items: ConsentReviewItem[]; total: number }> {
    const where = { orgId, ...AWAITING_CONSENT_REVIEW };
    const [rows, total] = await Promise.all([
      this.prisma.lead.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 500,
        select: { id: true, firstName: true, lastName: true, phone: true, email: true, createdAt: true },
      }),
      this.prisma.lead.count({ where }),
    ]);
    return {
      items: rows.map((l) => ({ leadId: l.id, name: fullName(l.firstName, l.lastName, 'Unknown lead'), phone: l.phone, email: l.email, addedAt: l.createdAt })),
      total,
    };
  }

  /** The owner attests the consent: the lead leaves review and outreach starts unless it is do-not-contact. */
  async approve(orgId: string, userId: string, leadIds: string[]): Promise<{ approved: number }> {
    const approved = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        UPDATE leads
           SET consent_status = ${ConsentStatus.granted}::"consent_status",
               consent_source = 'owner_attested',
               consent_at = now(),
               automation_paused = dnc_status,
               ${withoutReason()},
               updated_at = now()
         WHERE organization_id = ${orgId}::uuid AND id = ANY(${leadIds}::uuid[]) AND ${CONSENT_REVIEW_REASON} = ANY(review_reasons)
        RETURNING id`;
      await this.audit.recordMany(
        rows.map((r) => ({ orgId, actorType: 'user' as const, actorId: userId, action: 'lead.consent_recorded', entityType: 'lead', entityId: r.id, payload: {} })),
        tx,
      );
      return rows;
    });
    for (const { id } of approved) {
      this.state.quietly({ orgId, leadId: id, type: 'consent_recorded', source: 'user', actor: { type: 'user', id: userId }, reason: 'Consent recorded at review' });
    }
    return { approved: approved.length };
  }

  /** Like a rejected import: closed, kept paused, never contacted. */
  async reject(orgId: string, userId: string, leadIds: string[]): Promise<{ rejected: number }> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        UPDATE leads
           SET status = 'closed',
               lost_reason = ${REJECTED_REASON},
               automation_paused = true,
               ${withoutReason()},
               updated_at = now()
         WHERE organization_id = ${orgId}::uuid AND id = ANY(${leadIds}::uuid[]) AND ${CONSENT_REVIEW_REASON} = ANY(review_reasons)
        RETURNING id`;
      await this.audit.recordMany(
        rows.map((r) => ({ orgId, actorType: 'user' as const, actorId: userId, action: 'lead.consent_rejected', entityType: 'lead', entityId: r.id, payload: {} })),
        tx,
      );
      return { rejected: rows.length };
    });
  }
}

/** Drops the consent reason; the lead still needs review only for any other reason it carries. */
function withoutReason() {
  return Prisma.sql`review_reasons = array_remove(review_reasons, ${CONSENT_REVIEW_REASON}),
               needs_review = cardinality(array_remove(review_reasons, ${CONSENT_REVIEW_REASON})) > 0`;
}
