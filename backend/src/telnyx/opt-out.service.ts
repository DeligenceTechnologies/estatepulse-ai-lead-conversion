import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { ConsentStatus, FollowUpReason, LeadStatus, type Prisma } from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';
import { FollowupService } from '@/followup/followup.service';
import { type Actor, LeadStateService } from '@/lead/lead-state.service';

type Tx = Prisma.TransactionClient;

export interface OptOutEvent {
  /** What decided it: sms_reply, call, sms_chat, agent. */
  source: string;
  reason: string;
  channel?: 'sms' | 'voice';
  callId?: string | null;
  actor?: Actor;
}

/**
 * Do-not-contact for a phone, not for one lead record: a person who filled in
 * two forms is two leads with one number. An opt-out puts the number on the
 * organization's suppression list and, in the same transaction, makes every
 * lead with it do-not-contact with its sequences stopped. Each becomes
 * not_interested unless it is booked or closed: an opt-out ends our outreach,
 * not a meeting they made. START by text lifts it for the number.
 */
@Injectable()
export class OptOutService {
  private readonly logger = new Logger(OptOutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly state: LeadStateService,
    @Inject(forwardRef(() => FollowupService)) private readonly followup: FollowupService,
  ) {}

  /**
   * `leadId` is the lead that asked, opted out even when it has no phone.
   * `phone` is the number, read from that lead when not given, and all there
   * is for a number no lead has. Runs inside `db` when given. Returns the
   * leads opted out.
   */
  async optOut(orgId: string, who: { leadId?: string | null; phone?: string | null }, event: OptOutEvent, db?: Tx): Promise<string[]> {
    const run = async (tx: Tx): Promise<string[]> => {
      const asker = who.leadId ?? null;
      const phone =
        who.phone || (asker ? (await tx.lead.findUnique({ where: { id: asker }, select: { normalizedPhone: true } }))?.normalizedPhone : null) || null;
      if (!phone && !asker) return [];
      if (phone) {
        await tx.contactSuppression.upsert({
          where: { orgId_normalizedPhone: { orgId, normalizedPhone: phone } },
          create: { orgId, normalizedPhone: phone, source: event.source.slice(0, 30), reason: event.reason.slice(0, 500) },
          update: {},
        });
      }
      const leads = await tx.lead.findMany({
        where: { orgId, OR: [...(phone ? [{ normalizedPhone: phone }] : []), ...(asker ? [{ id: asker }] : [])] },
        select: { id: true },
      });
      for (const { id } of leads) {
        const own = !asker || id === asker;
        const reason = own ? event.reason : `${event.reason} (said by another lead with this phone)`;
        const callId = own ? event.callId : null;
        const at = { source: event.source, reason, channel: event.channel, callId, actor: event.actor };
        await tx.lead.update({ where: { id }, data: { dncStatus: true, automationPaused: true, consentStatus: ConsentStatus.revoked } });
        await this.state.move(id, LeadStatus.not_interested, { ...at, data: { lostReason: reason.slice(0, 255) } }, tx);
        await this.state.record({ ...at, orgId, leadId: id, type: 'opted_out' }, tx);
        await this.followup.stopForLead(orgId, id, 'opted_out', tx);
      }
      return leads.map((l) => l.id);
    };
    const ids = db ? await run(db) : await this.prisma.$transaction(run);
    this.logger.log(`opt-out (${event.source}): ${ids.length ? `leads ${ids.join(', ')} are` : 'a number no lead has is'} do-not-contact, sequences stopped`);
    return ids;
  }

  /** START by text: the number comes off the list and every lead with it may be contacted again. Automation stays paused: a person decides what happens next. */
  async optIn(orgId: string, phone: string, reason: string): Promise<string[]> {
    return this.prisma.$transaction(async (tx) => {
      await tx.contactSuppression.deleteMany({ where: { orgId, normalizedPhone: phone } });
      const leads = await tx.lead.findMany({ where: { orgId, normalizedPhone: phone, dncStatus: true }, select: { id: true } });
      for (const { id } of leads) {
        await this.state.move(
          id,
          LeadStatus.follow_up,
          { source: 'sms_reply', reason, channel: 'sms', alsoFrom: [LeadStatus.not_interested], onlyFrom: [LeadStatus.not_interested], data: { followUpReason: FollowUpReason.other } },
          tx,
        );
        await tx.lead.update({ where: { id }, data: { dncStatus: false, consentStatus: ConsentStatus.granted, consentAt: new Date(), consentSource: 'sms_start' } });
        await this.state.record({ orgId, leadId: id, type: 'opted_in', source: 'sms_reply', reason, channel: 'sms' }, tx);
      }
      return leads.map((l) => l.id);
    });
  }
}
