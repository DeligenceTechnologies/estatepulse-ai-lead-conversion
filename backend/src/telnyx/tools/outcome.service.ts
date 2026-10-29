import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { ConsentStatus, LeadStatus } from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';
import { FollowupService } from '@/followup/followup.service';
import { LeadStateService } from '@/lead/lead-state.service';
import { EngineService } from '../engine.service';
import type { AssistantToolCaller } from './assistant-tool-auth.service';
import { OUTCOMES, type Outcome } from './call-tools';

export type OutcomeResult = { ok: true; recorded: Outcome; say: string } | { ok: false; reason: string; say: string };

const GOODBYE: Record<Outcome, string> = {
  not_interested: 'Thank them for their time and say a short, polite goodbye.',
  do_not_contact: 'Apologise for the bother, confirm they will not be contacted again, and say goodbye.',
  wrong_number: 'Apologise for the mix-up and say goodbye.',
};

/**
 * How a conversation ended, as the lead said it, recorded the moment the AI
 * hears it rather than when the call is scored: not interested, stop
 * contacting me (do-not-contact, for good), or a wrong number. Each one ends
 * the strategy, every sequence and any callback.
 */
@Injectable()
export class OutcomeService {
  private readonly logger = new Logger(OutcomeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly state: LeadStateService,
    @Inject(forwardRef(() => FollowupService)) private readonly followup: FollowupService,
    private readonly engine: EngineService,
  ) {}

  async record(ctx: AssistantToolCaller, input: { outcome?: string; note?: string }): Promise<OutcomeResult> {
    const outcome = OUTCOMES.find((o) => o === input.outcome);
    if (!outcome) return { ok: false, reason: 'bad_outcome', say: 'Use not_interested, do_not_contact or wrong_number.' };
    const lead = await this.prisma.lead.findFirst({ where: { id: ctx.leadId, orgId: ctx.orgId }, select: { id: true } });
    if (!lead) return { ok: false, reason: 'lead_not_found', say: GOODBYE[outcome] };

    const source = ctx.callId ? 'call' : 'sms_chat';
    const channel = ctx.callId ? ('voice' as const) : ('sms' as const);
    const note = input.note?.trim().slice(0, 300) || null;
    const said = { not_interested: 'Not interested', do_not_contact: 'Asked not to be contacted again', wrong_number: 'Wrong number' }[outcome];
    const reason = `${said} (told the AI ${ctx.callId ? 'on the call' : 'by text'})${note ? `: ${note}` : ''}`;
    this.state.quietly({ orgId: ctx.orgId, leadId: ctx.leadId, type: 'outcome_reported', source, channel, callId: ctx.callId, reason: note, payload: { outcome } });

    // They said how it ends, so no callback is still owed.
    await this.prisma.lead.update({ where: { id: ctx.leadId }, data: { callbackAt: null } });
    if (outcome === 'do_not_contact') await this.optOut(ctx, reason, source, channel);
    else await this.engine.setStatus(ctx.orgId, ctx.leadId, outcome === 'wrong_number' ? LeadStatus.invalid : LeadStatus.not_interested, reason, { source });
    this.engine.stopStrategy(ctx.orgId, ctx.leadId, source, said);

    // Each provider's agent ends a call with its own tool: Telnyx's assistant has hangup, Retell's agent end_call.
    const hangup = ctx.callId ? ` Then end the call with the ${ctx.provider === 'retell' ? 'end_call' : 'hangup'} tool.` : '';
    return { ok: true, recorded: outcome, say: `${GOODBYE[outcome]}${hangup}` };
  }

  /**
   * Do-not-contact and stopping the sequences land together, as for a STOP by
   * text. The lead becomes not_interested unless it is booked or closed: the
   * request ends our outreach, not a meeting they made.
   */
  private async optOut(ctx: AssistantToolCaller, reason: string, source: string, channel: 'sms' | 'voice'): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.lead.update({
        where: { id: ctx.leadId },
        data: { dncStatus: true, automationPaused: true, consentStatus: ConsentStatus.revoked, lastContactAt: new Date() },
      });
      await this.state.move(ctx.leadId, LeadStatus.not_interested, { source, reason, channel, callId: ctx.callId, data: { lostReason: reason.slice(0, 255) } }, tx);
      await this.state.record({ orgId: ctx.orgId, leadId: ctx.leadId, type: 'opted_out', source, reason, channel, callId: ctx.callId }, tx);
      await this.followup.stopForLead(ctx.orgId, ctx.leadId, 'opted_out', tx);
    });
    this.logger.log(`lead ${ctx.leadId} asked not to be contacted (${source}) — DNC set, sequences stopped`);
  }
}
