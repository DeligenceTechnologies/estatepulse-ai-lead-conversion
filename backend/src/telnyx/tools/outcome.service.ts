import { Injectable } from '@nestjs/common';
import { LeadStatus } from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';
import { LeadStateService } from '@/lead/lead-state.service';
import { EngineService } from '../engine.service';
import { OptOutService } from '../opt-out.service';
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly state: LeadStateService,
    private readonly optOuts: OptOutService,
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
    // For the number, every lead with it, as for a STOP by text: the request ends our outreach, not a meeting they made.
    if (outcome === 'do_not_contact') {
      await this.prisma.$transaction(async (tx) => {
        await tx.lead.update({ where: { id: ctx.leadId }, data: { lastContactAt: new Date() } });
        await this.optOuts.optOut(ctx.orgId, { leadId: ctx.leadId }, { source, reason, channel, callId: ctx.callId }, tx);
      });
    } else {
      await this.engine.setStatus(ctx.orgId, ctx.leadId, outcome === 'wrong_number' ? LeadStatus.invalid : LeadStatus.not_interested, reason, { source });
    }
    this.engine.stopStrategy(ctx.orgId, ctx.leadId, source, said);

    const hangup = ctx.callId ? ' Then end the call with the hangup tool.' : '';
    return { ok: true, recorded: outcome, say: `${GOODBYE[outcome]}${hangup}` };
  }
}
