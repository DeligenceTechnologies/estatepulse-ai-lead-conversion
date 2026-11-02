import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, ServiceUnavailableException, forwardRef } from '@nestjs/common';
import { LeadStatus } from '@prisma/client';
import type { Queue } from 'bullmq';
import { spoken } from '@/calendar/booking/booking-time';
import { PrismaService } from '@/common/prisma/prisma.service';
import { sha256Hex } from '@/common/utils/crypto';
import { contactZone, leadZone } from '@/common/utils/lead-timezone';
import { FollowupService } from '@/followup/followup.service';
import { OUTCOME_STATUSES, textBackPending } from '@/lead/lead-status';
import { LeadStateService } from '@/lead/lead-state.service';
import { TEXT_QUEUE, TextJob } from '@/queue/queue.constants';
import type { AssistantToolCaller } from './assistant-tool-auth.service';
import { CallToolsService } from './call-tools.service';
import { hoursSay, resolveCallback, retrySay, withinLeadHours } from './callback.service';

/** "Message me in 1 minute" is the soonest; the AI's reply has to land first. */
const MIN_AHEAD_MS = 60_000;
/** A text from the lead this soon after the AI promised one ("ok thanks") leaves the promise standing. */
export const ACK_WINDOW_MS = 2 * 60_000;
const ENQUEUE_TIMEOUT_MS = 5_000;

/** A hot lead still gets the text the AI promised; these end it. */
export const TEXT_BACK_BLOCKED: LeadStatus[] = OUTCOME_STATUSES.filter((s) => s !== LeadStatus.interested && s !== LeadStatus.appointment_requested);

export interface TextBackJobData {
  orgId: string;
  leadId: string;
  /** The lead's textBackAt when it was set; the job is dropped once that has moved or been cancelled. */
  at: string;
}

export type TextBackResult =
  | { ok: true; scheduled: true; at: string; spoken: string; say: string }
  | { ok: false; reason: string; say: string; suggested?: { at: string; spoken: string } };

/**
 * A text the lead asked for at a time of their choosing ("message me in 10
 * minutes", "text me tomorrow at 10"), set by the AI's schedule_text tool on a
 * call or in a text chat. Until it goes out nothing else reaches the lead; the
 * strategy and any sequence wait for it and then go on as usual. The lead
 * texting again (beyond a quick acknowledgement) cancels it: they are back.
 */
@Injectable()
export class TextBackService {
  private readonly logger = new Logger(TextBackService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly state: LeadStateService,
    @Inject(forwardRef(() => FollowupService)) private readonly followup: FollowupService,
    private readonly tools: CallToolsService,
    @InjectQueue(TEXT_QUEUE) private readonly queue: Queue<TextBackJobData>,
  ) {}

  async schedule(ctx: AssistantToolCaller, input: { day?: string; time?: string; inMinutes?: number; note?: string }, now = new Date()): Promise<TextBackResult> {
    if (!(await this.tools.settings(ctx.orgId)).textBack) {
      return { ok: false, reason: 'off', say: 'You cannot text them later. Ask them to text back whenever it suits them.' };
    }
    const lead = await this.prisma.lead.findFirst({
      where: { id: ctx.leadId, orgId: ctx.orgId },
      select: { status: true, dncStatus: true, phone: true, normalizedPhone: true, timezone: true },
    });
    if (!lead?.phone) return { ok: false, reason: 'lead_not_found', say: 'Ask them to text back whenever it suits them.' };
    if (lead.status === LeadStatus.appointment_booked) {
      return { ok: false, reason: 'already_booked', say: 'Their appointment is already booked; say the agent will be in touch before it.' };
    }
    if (lead.dncStatus || TEXT_BACK_BLOCKED.includes(lead.status)) {
      return { ok: false, reason: 'not_textable', say: 'Do not offer to text them later. Say someone from the team will be in touch if needed.' };
    }

    // "Their time" is the lead's own zone when it is known; the office's only to read the request
    // when it is not (the text-back worker still holds the text until someone sets a zone).
    const { timeZone: officeZone, quiet } = await this.followup.guardrailsFor(ctx.orgId);
    const zone = leadZone(lead);
    const timeZone = contactZone(zone) ?? officeZone;
    const resolved = withinLeadHours(resolveCallback(input, now, timeZone, quiet, MIN_AHEAD_MS), zone, quiet);
    if (!resolved.ok) {
      if (resolved.reason === 'outside_hours' && resolved.suggested) {
        const when = spoken(resolved.suggested, timeZone);
        return {
          ok: false,
          reason: 'outside_hours',
          say: `We only text ${hoursSay(quiet)} their time. Offer ${when} instead, or ask for another time in those hours.`,
          suggested: { at: resolved.suggested.toISOString(), spoken: when },
        };
      }
      return { ok: false, reason: resolved.reason, say: retrySay(resolved.reason, 'schedule_text') };
    }

    const at = resolved.at;
    const when = spoken(at, timeZone);
    const source = ctx.callId ? 'call' : 'sms_chat';
    // Asked again ("make it tomorrow instead"): the newer time replaces the older, whose job then drops itself.
    await this.prisma.lead.update({ where: { id: ctx.leadId }, data: { textBackAt: at } });
    try {
      await this.enqueue({ orgId: ctx.orgId, leadId: ctx.leadId, at: at.toISOString() }, at);
    } catch (error) {
      this.logger.warn(`text back for lead ${ctx.leadId}: ${(error as Error).message}`);
      await this.prisma.lead.updateMany({ where: { id: ctx.leadId, textBackAt: at }, data: { textBackAt: null } });
      return { ok: false, reason: 'unavailable', say: 'Ask them to text back whenever it suits them.' };
    }
    this.state.quietly({
      orgId: ctx.orgId,
      leadId: ctx.leadId,
      type: 'text_back_scheduled',
      source,
      channel: ctx.callId ? 'voice' : 'sms',
      callId: ctx.callId,
      reason: input.note?.slice(0, 500) || null,
      payload: { at: at.toISOString(), spoken: when },
    });
    const say = ctx.callId ? `Confirm you will text them on ${when}, then say goodbye.` : `Confirm in your reply that you will text them on ${when}.`;
    return { ok: true, scheduled: true, at: at.toISOString(), spoken: when, say };
  }

  /** Every text from the lead: one that comes after the acknowledgement window cancels the text they asked for. */
  async onLeadTexted(orgId: string, leadId: string, now = new Date()): Promise<void> {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId }, select: { textBackAt: true } });
    if (!lead || !textBackPending(lead, now.getTime())) return;
    const set = await this.prisma.leadEvent.findFirst({
      where: { leadId, type: 'text_back_scheduled' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (set && now.getTime() - set.createdAt.getTime() < ACK_WINDOW_MS) return;
    const { count } = await this.prisma.lead.updateMany({ where: { id: leadId, textBackAt: lead.textBackAt }, data: { textBackAt: null } });
    if (count) this.state.quietly({ orgId, leadId, type: 'text_back_cancelled', source: 'sms_reply', channel: 'sms', reason: 'The lead texted again before it' });
  }

  private async enqueue(data: TextBackJobData, at: Date): Promise<void> {
    const add = this.queue.add(TextJob.TextBack, data, {
      jobId: `text-${sha256Hex(`text:${data.leadId}:${data.at}`).slice(0, 40)}`,
      delay: Math.max(0, at.getTime() - Date.now()),
    });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ServiceUnavailableException('The text queue is unavailable')), ENQUEUE_TIMEOUT_MS);
    });
    try {
      await Promise.race([add, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
