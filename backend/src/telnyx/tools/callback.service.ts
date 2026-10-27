import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { CallDisposition, FollowUpReason, LeadStatus, SequenceTrigger } from '@prisma/client';
import { localDate, parseTime, resolveDay, spoken, zonedToUtc } from '@/calendar/booking/booking-time';
import { PrismaService } from '@/common/prisma/prisma.service';
import { inQuietHours, nextAllowedAt } from '@/common/utils/quiet-hours';
import { FollowupService } from '@/followup/followup.service';
import { LeadStateService } from '@/lead/lead-state.service';
import { ActivityService } from '../activity.service';
import { CallQueue } from '../calls/call.queue';
import { EngineService } from '../engine.service';
import { SmsService } from '../sms.service';
import { SmsConversationService } from '../sms/sms-conversation.service';
import { fillTemplate } from '../template';
import type { AssistantToolCaller } from './assistant-tool-auth.service';
import { CallToolsService } from './call-tools.service';

/** "Call me later", with no time named. */
export const LATER_MS = 3 * 60 * 60_000;
/** A missed callback is tried once more after this. */
export const RETRY_AFTER_MS = 15 * 60_000;
/** The furthest ahead a callback may be set. */
export const MAX_AHEAD_MS = 14 * 24 * 60 * 60_000;
/** A time this close to now, or past, is not a callback. */
const MIN_AHEAD_MS = 2 * 60_000;

/** Statuses a callback request moves to follow_up · callback_requested; a hot lead keeps its status. */
const PARKS: LeadStatus[] = [LeadStatus.new, LeadStatus.contacting, LeadStatus.engaged, LeadStatus.follow_up, LeadStatus.unresponsive, LeadStatus.not_interested];
const KEEPS: LeadStatus[] = [LeadStatus.interested, LeadStatus.appointment_requested];

export type CallbackResult =
  | { ok: true; scheduled: true; at: string; spoken: string; say: string }
  | { ok: false; reason: string; say: string; suggested?: { at: string; spoken: string } };

/**
 * The time the lead asked to be called back, in the organization's time zone
 * and calling window. No day and no time means "later": LATER_MS from now,
 * moved into the window. Pure, so the rules can be tested.
 */
export function resolveCallback(
  input: { day?: string; time?: string; inMinutes?: number },
  now: Date,
  timeZone: string,
  quiet?: { start: string; end: string },
): { ok: true; at: Date } | { ok: false; reason: string; suggested?: Date } {
  if (!input.day?.trim() && !input.time?.trim()) {
    if (input.inMinutes === undefined) return { ok: true, at: nextAllowedAt(timeZone, quiet, new Date(now.getTime() + LATER_MS)) };
    // "Call me in 5 minutes": the call they are on has to end first.
    const at = new Date(now.getTime() + Math.max(input.inMinutes * 60_000, MIN_AHEAD_MS));
    if (at.getTime() > now.getTime() + MAX_AHEAD_MS) return { ok: false, reason: 'too_far' };
    if (quiet && inQuietHours(timeZone, quiet, at)) return { ok: false, reason: 'outside_hours', suggested: nextAllowedAt(timeZone, quiet, at) };
    return { ok: true, at };
  }
  const time = parseTime(input.time);
  if (!time) return { ok: false, reason: 'time_needed' };
  const day = input.day?.trim() ? resolveDay(input.day, now, timeZone) : localDate(now, timeZone);
  if (!day) return { ok: false, reason: 'bad_day' };
  const at = zonedToUtc(day, time, timeZone);
  if (at.getTime() < now.getTime() + MIN_AHEAD_MS) return { ok: false, reason: 'in_the_past' };
  if (at.getTime() > now.getTime() + MAX_AHEAD_MS) return { ok: false, reason: 'too_far' };
  if (quiet && inQuietHours(timeZone, quiet, at)) return { ok: false, reason: 'outside_hours', suggested: nextAllowedAt(timeZone, quiet, at) };
  return { ok: true, at };
}

const SAY: Record<string, string> = {
  time_needed: 'Ask what time suits them, then call schedule_callback again with day and time.',
  bad_day: 'Ask which day suits them, then call schedule_callback again.',
  in_the_past: 'That time has already passed today. Ask whether they mean tomorrow or a later time today.',
  too_far: 'That is more than two weeks away. Ask for a time within the next two weeks.',
};

/**
 * Callbacks the lead asked for. Setting one parks the lead (follow_up ·
 * callback_requested, or a hot lead keeps its status), stops the strategy and
 * every sequence, and queues the call for that exact time: nothing else
 * contacts the lead before it. After the call that set it, the lead gets the
 * time by SMS (an org setting). A missed callback is tried once more after
 * RETRY_AFTER_MS; a second miss hands the lead to the no-answer follow-up.
 */
@Injectable()
export class CallbackService {
  private readonly logger = new Logger(CallbackService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly state: LeadStateService,
    @Inject(forwardRef(() => FollowupService)) private readonly followup: FollowupService,
    private readonly engine: EngineService,
    private readonly calls: CallQueue,
    private readonly sms: SmsService,
    private readonly activity: ActivityService,
    private readonly conversations: SmsConversationService,
    private readonly tools: CallToolsService,
  ) {}

  async schedule(ctx: AssistantToolCaller, input: { day?: string; time?: string; inMinutes?: number; note?: string }, now = new Date()): Promise<CallbackResult> {
    const lead = await this.prisma.lead.findFirst({ where: { id: ctx.leadId, orgId: ctx.orgId }, select: { status: true, dncStatus: true } });
    if (!lead) return { ok: false, reason: 'lead_not_found', say: 'Say someone from the team will be in touch.' };
    if (lead.status === LeadStatus.appointment_booked) {
      return { ok: false, reason: 'already_booked', say: 'Their appointment is already booked; say the agent will be in touch before it.' };
    }
    if (lead.dncStatus || (!PARKS.includes(lead.status) && !KEEPS.includes(lead.status))) {
      return { ok: false, reason: 'not_callable', say: 'Do not offer a callback. Say someone from the team will be in touch if needed.' };
    }

    const { timeZone, quiet } = await this.followup.guardrailsFor(ctx.orgId);
    const resolved = resolveCallback(input, now, timeZone, quiet);
    if (!resolved.ok) {
      if (resolved.reason === 'outside_hours' && resolved.suggested) {
        const when = spoken(resolved.suggested, timeZone);
        return {
          ok: false,
          reason: 'outside_hours',
          say: `We only call between ${quiet!.end} and ${quiet!.start} their time. Offer ${when} instead, or ask for another time in those hours.`,
          suggested: { at: resolved.suggested.toISOString(), spoken: when },
        };
      }
      return { ok: false, reason: resolved.reason, say: SAY[resolved.reason] };
    }

    const at = resolved.at;
    const when = spoken(at, timeZone);
    const source = ctx.callId ? 'call' : 'sms_chat';
    const reason = `Asked to be called back on ${when}${input.note ? ` (${input.note})` : ''}`;
    if (KEEPS.includes(lead.status)) {
      await this.prisma.lead.update({ where: { id: ctx.leadId }, data: { callbackAt: at } });
    } else {
      const { moved } = await this.state.move(ctx.leadId, LeadStatus.follow_up, {
        source,
        reason,
        channel: ctx.callId ? 'voice' : 'sms',
        callId: ctx.callId,
        alsoFrom: [LeadStatus.unresponsive, LeadStatus.not_interested],
        data: { callbackAt: at, followUpReason: FollowUpReason.callback_requested, aiSummary: reason.slice(0, 2000) },
      });
      if (!moved) return { ok: false, reason: 'not_callable', say: 'Say someone from the team will be in touch.' };
    }
    this.engine.stopStrategy(ctx.orgId, ctx.leadId, source, 'Callback requested');
    await this.followup.stopForLead(ctx.orgId, ctx.leadId, 'callback_requested');
    await this.calls.schedule(
      { orgId: ctx.orgId, leadId: ctx.leadId, source: 'callback', callbackAt: at.toISOString() },
      at,
      `callback:${ctx.leadId}:${at.getTime()}`,
    );
    this.state.quietly({
      orgId: ctx.orgId,
      leadId: ctx.leadId,
      type: 'callback_scheduled',
      source,
      channel: ctx.callId ? 'voice' : 'sms',
      callId: ctx.callId,
      reason: input.note?.slice(0, 500) || null,
      payload: { at: at.toISOString(), spoken: when },
    });
    const say = ctx.callId
      ? `Confirm you will call them back on ${when}, then say goodbye.`
      : `Confirm in your reply that you will call them on ${when}.`;
    return { ok: true, scheduled: true, at: at.toISOString(), spoken: when, say };
  }

  /**
   * After every call (once its disposition is saved): the call that set a
   * callback sends the confirmation; the callback call itself clears it when
   * they talked, or is tried once more, then handed to the no-answer follow-up.
   */
  async onCallEnded(ccid: string, now = new Date()): Promise<void> {
    const call = await this.prisma.call.findFirst({
      where: { providerCallId: ccid },
      orderBy: { createdAt: 'desc' },
      select: { id: true, orgId: true, leadId: true, disposition: true },
    });
    if (!call) return;
    const lead = await this.prisma.lead.findUnique({ where: { id: call.leadId }, select: { callbackAt: true, phone: true, dncStatus: true } });
    if (!lead?.callbackAt) return;

    const setHere = await this.prisma.leadEvent.findFirst({ where: { leadId: call.leadId, callId: call.id, type: 'callback_scheduled' }, select: { id: true } });
    if (setHere) {
      if (!lead.dncStatus) await this.confirm(call.orgId, call.leadId, lead.phone, lead.callbackAt);
      return;
    }
    // Placed before the callback was due (a call already ringing when it was set): not the callback.
    if (lead.callbackAt.getTime() > now.getTime()) return;

    const base = { orgId: call.orgId, leadId: call.leadId, source: 'callback', channel: 'voice', callId: call.id } as const;
    if (call.disposition === CallDisposition.connected) {
      await this.prisma.lead.update({ where: { id: call.leadId }, data: { callbackAt: null } });
      this.state.quietly({ ...base, type: 'callback_done' });
      return;
    }

    const lastSet = await this.prisma.leadEvent.findFirst({
      where: { leadId: call.leadId, type: 'callback_scheduled' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    const missed = await this.prisma.leadEvent.count({
      where: { leadId: call.leadId, type: 'callback_missed', ...(lastSet ? { createdAt: { gte: lastSet.createdAt } } : {}) },
    });
    this.state.quietly({ ...base, type: 'callback_missed', reason: call.disposition ?? null, payload: { attempt: missed + 1 } });
    if (missed === 0) {
      const at = new Date(now.getTime() + RETRY_AFTER_MS);
      await this.prisma.lead.update({ where: { id: call.leadId }, data: { callbackAt: at } });
      await this.calls.schedule({ orgId: call.orgId, leadId: call.leadId, source: 'callback', callbackAt: at.toISOString() }, at, `callback:${call.leadId}:${at.getTime()}`);
      return;
    }
    await this.prisma.lead.update({ where: { id: call.leadId }, data: { callbackAt: null } });
    // A hot lead stays with its agent; a parked one goes on to the no-answer follow-up.
    const { moved } = await this.state.move(call.leadId, LeadStatus.follow_up, {
      source: 'callback',
      reason: 'Missed the callback twice',
      callId: call.id,
      onlyFrom: [LeadStatus.follow_up],
      data: { followUpReason: FollowUpReason.no_answer },
    });
    if (!moved) return;
    const code = await this.followup.sequenceForTrigger(call.orgId, SequenceTrigger.follow_up_no_answer);
    if (code) await this.followup.enroll(call.orgId, call.leadId, code);
  }

  private async confirm(orgId: string, leadId: string, phone: string | null, at: Date): Promise<void> {
    const settings = await this.tools.settings(orgId);
    if (!settings.confirmSms || !phone) return;
    const [{ timeZone }, variables] = await Promise.all([this.followup.guardrailsFor(orgId), this.activity.leadVariables(orgId, leadId)]);
    const text = fillTemplate(settings.confirmMessage, { ...variables, callbackTime: spoken(at, timeZone) });
    try {
      const sent = await this.sms.sendSms(orgId, phone, text);
      await this.activity.recordSms(orgId, leadId, text, true, sent.id);
      await this.conversations.appendOurMessage(orgId, phone, text).catch(() => undefined);
    } catch (error) {
      this.logger.warn(`callback confirmation for lead ${leadId}: ${(error as Error).message}`);
      await this.activity.recordSms(orgId, leadId, text, false, (error as Error).message);
    }
  }
}
