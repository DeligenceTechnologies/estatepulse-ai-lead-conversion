import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { ConsentStatus, FollowUpReason, LeadStatus } from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';
import { FollowupService } from '@/followup/followup.service';
import { REPLY_FROM } from '@/lead/lead-status';
import { normalizePhone } from './phone';
import { TelnyxCredentialsService } from './telnyx-credentials.service';

const STOP_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke', 'optout', 'opt-out']);
const START_WORDS = new Set(['start', 'unstop', 'yes']);
const keyword = (text: string) => text.trim().toLowerCase().replace(/[.!?,]+$/, '');

/**
 * Texts a lead sends back. STOP is honoured at once (do-not-contact, every
 * sequence stopped), START lifts it, and any other reply pauses automation so
 * a person takes over the conversation.
 */
@Injectable()
export class InboundSmsService {
  private readonly logger = new Logger(InboundSmsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly creds: TelnyxCredentialsService,
    @Inject(forwardRef(() => FollowupService)) private readonly followup: FollowupService,
  ) {}

  async onMessageReceived(payload: any): Promise<void> {
    const from = normalizePhone(payload?.from?.phone_number);
    const to = normalizePhone(payload?.to?.[0]?.phone_number ?? payload?.to?.phone_number);
    const text = String(payload?.text ?? '');
    const providerId: string | null = payload?.id ?? null;
    if (!from || !to) return;

    const orgId = await this.creds.orgForNumber(to);
    if (!orgId) {
      this.logger.warn(`message.received for ${to}, which no organization owns`);
      return;
    }
    if (providerId) {
      const seen = await this.prisma.message.findFirst({ where: { providerMessageId: providerId, direction: 'inbound' }, select: { id: true } });
      if (seen) return;
    }
    const lead = await this.prisma.lead.findFirst({
      where: { orgId, normalizedPhone: from },
      orderBy: { createdAt: 'desc' },
      select: { id: true, firstResponseAt: true },
    });
    if (!lead) {
      this.logger.warn(`Inbound SMS matches no lead in org ${orgId}`);
      return;
    }

    await this.prisma.message
      .create({
        data: {
          orgId,
          leadId: lead.id,
          senderType: 'lead',
          direction: 'inbound',
          channel: 'sms',
          body: text,
          providerMessageId: providerId,
          deliveryStatus: 'delivered',
          sentAt: new Date(),
          deliveredAt: new Date(),
        },
      })
      .catch((error) => this.logger.error(`storeInbound: ${(error as Error).message}`));

    const word = keyword(text);
    if (STOP_WORDS.has(word)) return this.onOptOut(orgId, lead.id);
    if (START_WORDS.has(word)) return this.onOptIn(lead.id);
    return this.onHumanReply(orgId, lead.id, !lead.firstResponseAt);
  }

  private async onOptOut(orgId: string, leadId: string): Promise<void> {
    await this.prisma.lead.update({
      where: { id: leadId },
      data: {
        dncStatus: true,
        automationPaused: true,
        status: LeadStatus.not_interested,
        lostReason: 'Opted out by SMS',
        consentStatus: ConsentStatus.revoked,
        firstResponseAt: new Date(),
        lastContactAt: new Date(),
      },
    });
    await this.followup.stopForLead(orgId, leadId, 'opted_out');
    this.logger.log(`lead ${leadId} opted out — DNC set, sequences stopped`);
  }

  /** Clears do-not-contact but leaves automation paused: a person decides what happens next. */
  private async onOptIn(leadId: string): Promise<void> {
    await this.prisma.lead.updateMany({
      where: { id: leadId, dncStatus: true, status: LeadStatus.not_interested },
      data: { status: LeadStatus.follow_up, followUpReason: FollowUpReason.other },
    });
    await this.prisma.lead.update({
      where: { id: leadId },
      data: {
        dncStatus: false,
        consentStatus: ConsentStatus.granted,
        consentAt: new Date(),
        consentSource: 'sms_start',
        firstResponseAt: new Date(),
        lastContactAt: new Date(),
      },
    });
  }

  private async onHumanReply(orgId: string, leadId: string, isFirst: boolean): Promise<void> {
    await this.prisma.lead.update({
      where: { id: leadId },
      data: { automationPaused: true, lastContactAt: new Date(), ...(isFirst ? { firstResponseAt: new Date() } : {}) },
    });
    await this.prisma.lead.updateMany({ where: { id: leadId, status: { in: REPLY_FROM } }, data: { status: LeadStatus.contacting } });
    await this.followup.pauseForLead(orgId, leadId);
  }
}
