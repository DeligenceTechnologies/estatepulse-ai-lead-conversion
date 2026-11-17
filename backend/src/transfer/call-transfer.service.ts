import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { AssignmentType, CallStatus, CallTransferStatus, Prisma, TransferAttemptStatus } from '@prisma/client';
import { AuditService } from '@/audit/audit.service';
import { inUse } from '@/calendar/connection/connection-state';
import { PrismaService } from '@/common/prisma/prisma.service';
import { LeadAssignmentService } from '@/lead/lead-assignment.service';
import { fullName } from '@/lead/lead-scope';
import { ActivityService } from '@/telnyx/activity.service';
import type { AssistantToolCaller } from '@/telnyx/tools/assistant-tool-auth.service';
import type { AgentLeg, TransferLegHandler } from '@/telnyx/transfer-legs';
import { TransferLegs } from '@/telnyx/transfer-legs';
import { VoiceService } from '@/telnyx/voice.service';
import { AgentRouterService, type PickedAgent } from './agent-router.service';
import { liveTransferSettings, transferToolWanted, type LiveTransferSettings, type TransferFacts, type TransferReason } from './live-transfer';

/** What the transfer tool answers the assistant: always a 200, with what to say. */
export interface TransferToolAnswer {
  ok: boolean;
  reason?: string;
  say: string;
}

type Fallback = 'booking' | 'callback';

const OPEN_ATTEMPT: TransferAttemptStatus[] = [TransferAttemptStatus.dialing, TransferAttemptStatus.answered];
/** Past Telnyx's own ring timeout, our timer closes an attempt whose hang-up we never heard about. */
const RING_GRACE_SECS = 15;
/**
 * After the agent picks up, how long we wait for the answering-machine verdict. A person usually
 * says "hello" and is known in 2-4 seconds; with no verdict by then they are put through anyway.
 */
const DETECT_WAIT_SECS = 6;
/** Telnyx premium detection verdicts that mean a person (or may be one): the lead is put through. */
const PERSON_VERDICTS = new Set(['human_residence', 'human_business', 'human', 'not_sure', 'silence']);
/** With the assistant gone and nothing else to say, the line is closed after the goodbye is spoken. */
const GOODBYE_HANGUP_MS = 12_000;

const STILL_HOLDING = 'Thanks for holding. I am still connecting you.';
const ALREADY_CONNECTING = 'Say nothing more: the lead is already being connected to an agent.';

const FALLBACK_SAY: Record<Fallback, string> = {
  booking:
    'No agent can take the call right now. Tell the lead, then offer to book a time with an agent using check_availability and book_appointment. Only confirm a booking when book_appointment returns ok; if it fails, offer a callback with schedule_callback instead.',
  callback:
    'No agent can take the call right now. Tell the lead, then offer a callback from an agent and set it with schedule_callback. Booking is not available, so never say a meeting is booked.',
};
/** Why the assistant is back on the call after nobody took the transfer: its {{call_context}}. */
const FALLBACK_CONTEXT: Record<Fallback, string> = {
  booking:
    'We just tried to put the lead through to an agent and none could take the call. Offer to book a time with an agent now, using check_availability and book_appointment. Only say a meeting is booked when book_appointment returns ok; if booking fails or they prefer, set a callback with schedule_callback instead. Do not try to transfer them again.',
  callback:
    'We just tried to put the lead through to an agent and none could take the call. Online booking is not available, so offer a callback from an agent with schedule_callback, at a time that suits them. Never say a meeting is booked. Do not try to transfer them again.',
};
const FALLBACK_GREETING: Record<Fallback, string> = {
  booking: "Thanks for holding, and I'm sorry: none of our agents can pick up right this moment. I can book you a time with one of them instead. What day works best for you?",
  callback: "Thanks for holding, and I'm sorry: none of our agents can pick up right this moment. I can have one of them call you back. What time suits you best?",
};
/** When even the assistant cannot come back: the lead is not left in silence. */
const GOODBYE =
  "Thanks for holding, and I'm sorry: none of our agents can pick up right this moment. One of them will get back to you shortly. Goodbye for now.";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The transfer attempt an agent leg's client_state names; null for any other call's. */
export function attemptIdOf(clientState: unknown): string | null | undefined {
  if (typeof clientState !== 'string' || !clientState) return undefined;
  try {
    const raw = JSON.parse(Buffer.from(clientState, 'base64').toString('utf8')) as { xfer?: unknown };
    return typeof raw.xfer === 'string' && UUID.test(raw.xfer) ? raw.xfer : null;
  } catch {
    return null;
  }
}

/** How an agent's phone ended before they took the call, from Telnyx's hangup_cause. */
export function ringOutcome(hangupCause: string | undefined): TransferAttemptStatus {
  switch (hangupCause) {
    case 'user_busy':
      return TransferAttemptStatus.busy;
    case 'call_rejected':
      return TransferAttemptStatus.declined;
    case 'timeout':
    case 'no_answer':
    case 'originator_cancel':
    case 'normal_clearing':
      return TransferAttemptStatus.no_answer;
    default:
      return TransferAttemptStatus.failed;
  }
}

/**
 * Live transfer of an AI call to an agent, from the assistant's transfer_to_agent tool:
 *
 * 1. The assistant stops and the lead hears the hold message.
 * 2. The round robin picks an available agent (AgentRouterService), checked again at the moment
 *    of ringing, and their phone rings for the configured time.
 * 3. When the agent picks up, the two calls are bridged straight away and the lead is assigned to
 *    that agent. Answering-machine detection runs on the agent's call, so a voicemail greeting
 *    is hung up on instead of bridged.
 * 4. A busy, unanswered or rejected call, or a voicemail, moves on to the next agent, up to the
 *    configured number.
 * 5. When nobody takes it, the assistant comes back and offers a booking (or a callback, when
 *    booking is not available).
 *
 * Every step is a conditional update on the attempt's or the transfer's status, so webhooks that
 * race (a pick-up arriving as our ring timer fires, the lead hanging up as the agent answers, the same
 * event twice) settle on one outcome, and only the step that closed an attempt rings the next agent.
 */
@Injectable()
export class CallTransferService implements OnModuleInit, TransferLegHandler {
  private readonly logger = new Logger(CallTransferService.name);
  /** Per open attempt: gives it up if Telnyx never tells us how it ended. */
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly router: AgentRouterService,
    private readonly voice: VoiceService,
    private readonly activity: ActivityService,
    private readonly assignments: LeadAssignmentService,
    private readonly audit: AuditService,
    private readonly legs: TransferLegs,
  ) {}

  onModuleInit(): void {
    this.legs.register(this);
  }

  async settings(orgId: string): Promise<LiveTransferSettings> {
    const row = await this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { liveTransfer: true } });
    return liveTransferSettings(row?.liveTransfer);
  }

  // ─── The assistant's tool ────────────────────────────────────────────────────────────────

  async start(caller: AssistantToolCaller, reason: TransferReason, facts: TransferFacts): Promise<TransferToolAnswer> {
    const fallback = await this.fallbackKind(caller.orgId);
    if (!caller.callId) {
      return { ok: false, reason: 'not_on_call', say: 'Transfers only work on a phone call. Offer to have an agent call them, with schedule_callback.' };
    }
    const s = await this.settings(caller.orgId);
    const allowed = transferToolWanted(s) && (reason === 'hot_lead' ? s.onHotLead : s.onRequest);
    if (!allowed) return { ok: false, reason: 'off', say: FALLBACK_SAY[fallback] };

    const call = await this.prisma.call.findUnique({ where: { id: caller.callId }, select: { providerCallId: true, status: true } });
    if (!call?.providerCallId || call.status !== CallStatus.in_progress) return { ok: false, reason: 'call_over', say: FALLBACK_SAY[fallback] };
    const lead = await this.prisma.lead.findUnique({
      where: { id: caller.leadId },
      select: { firstName: true, lastName: true, location: true, assignedToId: true },
    });
    if (!lead) return { ok: false, reason: 'no_lead', say: FALLBACK_SAY[fallback] };

    // One transfer per call: a second request (the model repeating itself) is answered from the first.
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`call-transfer:${caller.callId}`}))`;
      const earlier = await tx.callTransfer.findFirst({ where: { callId: caller.callId! }, orderBy: { createdAt: 'desc' }, select: { status: true } });
      if (earlier) return { earlier: earlier.status };
      const t = await tx.callTransfer.create({
        data: {
          orgId: caller.orgId,
          leadId: caller.leadId,
          callId: caller.callId!,
          leadCallControlId: call.providerCallId!,
          reason,
          facts: facts as Prisma.InputJsonObject,
        },
        select: { id: true },
      });
      return { id: t.id };
    });
    if ('earlier' in created) {
      return created.earlier === CallTransferStatus.dialing || created.earlier === CallTransferStatus.connected
        ? { ok: true, say: ALREADY_CONNECTING }
        : { ok: false, reason: 'already_tried', say: FALLBACK_SAY[fallback] };
    }

    const transfer = { id: created.id, orgId: caller.orgId, leadId: caller.leadId, leadCcid: call.providerCallId };
    const first = await this.router.claimNext({
      orgId: caller.orgId,
      transferId: transfer.id,
      position: 1,
      leadLocation: facts.location || lead.location,
      exclude: [],
      preferUserId: lead.assignedToId,
    });
    if (!first) {
      // Nobody to ring: the assistant is still talking, so it is told what to offer instead.
      await this.prisma.callTransfer.updateMany({
        where: { id: transfer.id, status: CallTransferStatus.dialing },
        data: { status: CallTransferStatus.no_agent, fallback, endedAt: new Date() },
      });
      this.record(transfer, 'call.transfer_no_agent', { reason, rung: 0, fallback });
      return { ok: false, reason: 'no_agent', say: FALLBACK_SAY[fallback] };
    }

    void this.holdAndRing(transfer, first, s).catch((error) => this.logger.error(`transfer ${transfer.id}: ${(error as Error).message}`));
    this.record(transfer, 'call.transfer_started', { reason, facts, firstAgentId: first.userId });
    return { ok: true, say: 'Say nothing more. The lead is being put on hold and connected to an agent.' };
  }

  private async holdAndRing(t: TransferRef, first: PickedAgent, s: LiveTransferSettings): Promise<void> {
    if (!(await this.activity.pauseAssistant(t.orgId, t.leadCcid))) {
      // The assistant could not be stopped (the call is likely over): nothing is bridged over it.
      await this.closeAttempt(first.attemptId, TransferAttemptStatus.cancelled, OPEN_ATTEMPT);
      await this.prisma.callTransfer.updateMany({
        where: { id: t.id, status: CallTransferStatus.dialing },
        data: { status: CallTransferStatus.failed, endedAt: new Date() },
      });
      return;
    }
    await this.say(t, s.holdMessage);
    await this.ring(t, first, s);
  }

  // ─── Ringing agents ──────────────────────────────────────────────────────────────────────

  private async ring(t: TransferRef, agent: PickedAgent, s: LiveTransferSettings): Promise<void> {
    try {
      const { call_control_id: ccid } = await this.voice.dialAgent(t.orgId, agent.phone, { xfer: agent.attemptId }, s.ringSeconds);
      if (ccid) {
        await this.prisma.transferAttempt.updateMany({ where: { id: agent.attemptId, agentCallControlId: null }, data: { agentCallControlId: ccid } });
      }
      this.arm(agent.attemptId, s.ringSeconds + RING_GRACE_SECS);
    } catch (error) {
      this.logger.warn(`transfer ${t.id}: could not ring agent ${agent.userId}: ${(error as Error).message}`);
      if (await this.closeAttempt(agent.attemptId, TransferAttemptStatus.failed, OPEN_ATTEMPT, 'dial_failed')) await this.next(t.id);
    }
  }

  /** After an attempt closed: the next agent, or the fallback when the round is used up or nobody is left. */
  private async next(transferId: string): Promise<void> {
    const t = await this.transfer(transferId);
    if (!t || t.status !== CallTransferStatus.dialing) return;
    const s = await this.settings(t.orgId);
    const tried = t.attempts.map((a) => a.userId);
    if (tried.length < s.agentsPerTransfer) {
      const agent = await this.router.claimNext({
        orgId: t.orgId,
        transferId: t.id,
        position: tried.length + 1,
        leadLocation: (t.facts as TransferFacts | null)?.location || t.lead.location,
        exclude: tried,
      });
      if (agent) {
        // The lead may have hung up while the next agent was being picked.
        const still = await this.prisma.callTransfer.count({ where: { id: t.id, status: CallTransferStatus.dialing } });
        if (!still) {
          await this.closeAttempt(agent.attemptId, TransferAttemptStatus.cancelled, OPEN_ATTEMPT);
          return;
        }
        await this.say(t, STILL_HOLDING);
        await this.ring(t, agent, s);
        return;
      }
    }
    await this.fallBack(t, CallTransferStatus.no_agent, [CallTransferStatus.dialing]);
  }

  /** Nobody took the call: the assistant comes back to offer a booking or a callback. */
  private async fallBack(t: TransferRef & { attempts?: unknown[] }, status: CallTransferStatus, from: CallTransferStatus[]): Promise<void> {
    const fallback = await this.fallbackKind(t.orgId);
    const { count } = await this.prisma.callTransfer.updateMany({
      where: { id: t.id, status: { in: from } },
      data: { status, fallback, endedAt: new Date() },
    });
    if (!count) return;
    this.record(t, 'call.transfer_no_agent', { rung: t.attempts?.length ?? null, fallback, status });
    const back = await this.activity.resumeAssistant(t.orgId, t.leadId, t.leadCcid, FALLBACK_CONTEXT[fallback], FALLBACK_GREETING[fallback]);
    if (back) return;
    this.logger.warn(`transfer ${t.id}: the assistant would not restart; saying goodbye`);
    await this.say(t, GOODBYE);
    setTimeout(() => void this.activity.command(t.orgId, t.leadCcid, 'hangup'), GOODBYE_HANGUP_MS).unref();
  }

  // ─── Agent leg events ────────────────────────────────────────────────────────────────────

  async findAgentLeg(ccid: string, clientState: unknown): Promise<AgentLeg | null> {
    const id = attemptIdOf(clientState);
    if (id === null) return null;
    const attempt = id
      ? await this.prisma.transferAttempt.findUnique({ where: { id }, select: { id: true, orgId: true } })
      : await this.prisma.transferAttempt.findFirst({ where: { agentCallControlId: ccid }, select: { id: true, orgId: true } });
    return attempt ? { orgId: attempt.orgId, attemptId: attempt.id } : null;
  }

  async onAgentLegEvent(leg: AgentLeg, ccid: string, type: string, payload: any): Promise<void> {
    if (type === 'call.answered') await this.answered(leg, ccid);
    else if (type === 'call.machine.premium.detection.ended' || type === 'call.machine.detection.ended') await this.detected(leg, ccid, payload?.result);
    // A beep heard before any verdict comes alone: that is a voicemail.
    else if (type === 'call.machine.premium.greeting.ended' || type === 'call.machine.greeting.ended') await this.detected(leg, ccid, 'machine');
    else if (type === 'call.hangup') await this.agentHungUp(leg, ccid, payload?.hangup_cause);
  }

  /** The agent picked up: we wait a moment for the answering-machine verdict, then put the lead through. */
  private async answered(leg: AgentLeg, ccid: string): Promise<void> {
    const { count } = await this.prisma.transferAttempt.updateMany({
      where: { id: leg.attemptId, status: TransferAttemptStatus.dialing },
      data: { status: TransferAttemptStatus.answered, answeredAt: new Date(), agentCallControlId: ccid },
    });
    // Picked up after we gave up on them, or after the lead left: they are let go.
    if (!count) return void (await this.activity.command(leg.orgId, ccid, 'hangup'));
    const { transfer } = await this.prisma.transferAttempt.findUniqueOrThrow({ where: { id: leg.attemptId }, select: { transfer: { select: { status: true } } } });
    if (transfer.status !== CallTransferStatus.dialing) {
      await this.closeAttempt(leg.attemptId, TransferAttemptStatus.cancelled, [TransferAttemptStatus.answered]);
      return void (await this.activity.command(leg.orgId, ccid, 'hangup'));
    }
    // No verdict in time (detection off on the account, or slow): a person is assumed.
    this.arm(leg.attemptId, DETECT_WAIT_SECS, () => this.connect(leg, ccid));
  }

  /** The answering-machine verdict on the agent's call: a person is put through, a voicemail is hung up on. */
  private async detected(leg: AgentLeg, ccid: string, result: unknown): Promise<void> {
    const verdict = String(result || 'not_sure');
    if (PERSON_VERDICTS.has(verdict)) return this.connect(leg, ccid);
    if (!(await this.closeAttempt(leg.attemptId, TransferAttemptStatus.voicemail, OPEN_ATTEMPT, verdict))) return;
    await this.activity.command(leg.orgId, ccid, 'hangup');
    await this.next(await this.transferIdOf(leg.attemptId));
  }

  /** The agent is on the line: if the lead is still waiting and nobody else took them, the calls are bridged. */
  private async connect(leg: AgentLeg, agentCcid: string): Promise<void> {
    const won = await this.prisma.$transaction(async (tx) => {
      const attempt = await tx.transferAttempt.findUnique({ where: { id: leg.attemptId }, select: { transferId: true, userId: true } });
      if (!attempt) return null;
      const [t] = await tx.$queryRaw<{ status: CallTransferStatus }[]>`
        SELECT status FROM call_transfers WHERE id = ${attempt.transferId}::uuid FOR UPDATE`;
      if (t?.status !== CallTransferStatus.dialing) return null;
      const { count } = await tx.transferAttempt.updateMany({
        where: { id: leg.attemptId, status: TransferAttemptStatus.answered },
        data: { status: TransferAttemptStatus.accepted },
      });
      if (!count) return null;
      await tx.callTransfer.update({
        where: { id: attempt.transferId },
        data: { status: CallTransferStatus.connected, connectedUserId: attempt.userId, connectedAt: new Date() },
      });
      return attempt;
    });
    this.disarm(leg.attemptId);
    if (!won) {
      // Too late: the lead hung up, or the attempt was already given up on.
      await this.closeAttempt(leg.attemptId, TransferAttemptStatus.cancelled, OPEN_ATTEMPT);
      await this.activity.command(leg.orgId, agentCcid, 'speak', { payload: 'Sorry, the caller is no longer waiting.', voice: await this.activity.voiceOf(leg.orgId) });
      setTimeout(() => void this.activity.command(leg.orgId, agentCcid, 'hangup'), 4000).unref();
      return;
    }

    const t = await this.transfer(won.transferId);
    if (!t) return;
    const bridged = await this.activity.command(leg.orgId, t.leadCcid, 'bridge', { call_control_id: agentCcid });
    if (!bridged) {
      this.logger.warn(`transfer ${t.id}: bridge to agent ${won.userId} refused`);
      await this.prisma.transferAttempt.updateMany({
        where: { id: leg.attemptId, status: TransferAttemptStatus.accepted },
        data: { status: TransferAttemptStatus.failed, hangupCause: 'bridge_failed', endedAt: new Date() },
      });
      await this.activity.command(leg.orgId, agentCcid, 'hangup');
      await this.fallBack(t, CallTransferStatus.failed, [CallTransferStatus.connected]);
      return;
    }
    this.record(t, 'call.transfer_connected', { agentId: won.userId, rung: t.attempts.length });
    await this.assignIfUnassigned(t, won.userId);
  }

  private async agentHungUp(leg: AgentLeg, ccid: string, cause: string | undefined): Promise<void> {
    const attempt = await this.prisma.transferAttempt.findUnique({ where: { id: leg.attemptId }, select: { status: true, transferId: true } });
    if (!attempt) return;
    const now = new Date();
    if (attempt.status === TransferAttemptStatus.dialing || attempt.status === TransferAttemptStatus.answered) {
      // Hung up while ringing (busy, rejected, unanswered), or just after picking up.
      const outcome = attempt.status === TransferAttemptStatus.answered ? TransferAttemptStatus.declined : ringOutcome(cause);
      if (await this.closeAttempt(leg.attemptId, outcome, [attempt.status], cause)) await this.next(attempt.transferId);
      return;
    }
    // The agent's side of a bridged call, or a leg we already closed: just when it ended.
    await this.prisma.transferAttempt.updateMany({ where: { id: leg.attemptId, endedAt: null }, data: { endedAt: now, hangupCause: cause?.slice(0, 60) ?? null } });
    if (attempt.status === TransferAttemptStatus.accepted) {
      await this.prisma.callTransfer.updateMany({ where: { id: attempt.transferId, endedAt: null }, data: { endedAt: now } });
    }
  }

  /** The lead's call ended: a transfer still ringing agents is abandoned and every agent still ringing is let go. */
  async onLeadHangup(ccid: string): Promise<void> {
    const transfers = await this.prisma.callTransfer.findMany({
      where: { leadCallControlId: ccid, endedAt: null },
      select: { id: true, orgId: true, leadId: true, status: true },
    });
    const now = new Date();
    for (const t of transfers) {
      if (t.status !== CallTransferStatus.dialing) {
        await this.prisma.callTransfer.updateMany({ where: { id: t.id, endedAt: null }, data: { endedAt: now } });
        continue;
      }
      const { count } = await this.prisma.callTransfer.updateMany({
        where: { id: t.id, status: CallTransferStatus.dialing },
        data: { status: CallTransferStatus.abandoned, endedAt: now },
      });
      if (!count) continue;
      const ringing = await this.prisma.transferAttempt.findMany({
        where: { transferId: t.id, status: { in: OPEN_ATTEMPT } },
        select: { id: true, agentCallControlId: true },
      });
      for (const a of ringing) {
        if (!(await this.closeAttempt(a.id, TransferAttemptStatus.cancelled, OPEN_ATTEMPT, 'lead_hung_up'))) continue;
        if (a.agentCallControlId) await this.activity.command(t.orgId, a.agentCallControlId, 'hangup');
      }
      this.record(t, 'call.transfer_abandoned', { agentsCancelled: ringing.length });
    }
  }

  // ─── Reporting ───────────────────────────────────────────────────────────────────────────

  async recent(orgId: string, leadId?: string, take = 50) {
    const rows = await this.prisma.callTransfer.findMany({
      where: { orgId, ...(leadId ? { leadId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(take, 1), 200),
      select: {
        id: true,
        leadId: true,
        callId: true,
        status: true,
        reason: true,
        facts: true,
        fallback: true,
        connectedUserId: true,
        startedAt: true,
        connectedAt: true,
        endedAt: true,
        lead: { select: { firstName: true, lastName: true } },
        attempts: {
          orderBy: { position: 'asc' },
          select: { position: true, userId: true, status: true, hangupCause: true, dialedAt: true, answeredAt: true, endedAt: true, user: { select: { firstName: true, lastName: true } } },
        },
      },
    });
    return rows.map(({ lead, attempts, ...t }) => ({
      ...t,
      leadName: fullName(lead.firstName, lead.lastName, 'Unknown lead'),
      attempts: attempts.map(({ user, ...a }) => ({ ...a, agentName: fullName(user.firstName, user.lastName) })),
    }));
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────────────────

  /** Booking when the assistant has the booking tools and the calendar works; otherwise a callback. */
  private async fallbackKind(orgId: string): Promise<Fallback> {
    const [setting, calendar] = await Promise.all([
      this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { inCallBooking: true } }),
      this.prisma.calendarConnection.findFirst({ where: inUse(orgId), select: { provider: true, status: true } }),
    ]);
    const booking = (setting?.inCallBooking as { tokenHash?: string } | null)?.tokenHash;
    return booking && calendar?.provider === 'calendly' && calendar.status === 'active' ? 'booking' : 'callback';
  }

  /** Closes an attempt that is still in one of `from`; true only for the caller that closed it. */
  private async closeAttempt(attemptId: string, status: TransferAttemptStatus, from: TransferAttemptStatus[], cause?: string): Promise<boolean> {
    const { count } = await this.prisma.transferAttempt.updateMany({
      where: { id: attemptId, status: { in: from } },
      data: { status, endedAt: new Date(), ...(cause ? { hangupCause: cause.slice(0, 60) } : {}) },
    });
    if (count) this.disarm(attemptId);
    return count > 0;
  }

  /**
   * After `secs`, if nothing else settled the attempt: `then`, or by default it is given up on
   * (its leg hung up and the next agent rung).
   */
  private arm(attemptId: string, secs: number, then: () => Promise<void> = () => this.expire(attemptId)): void {
    this.disarm(attemptId);
    const timer = setTimeout(() => {
      this.timers.delete(attemptId);
      void then().catch((error) => this.logger.warn(`transfer attempt ${attemptId} timer: ${(error as Error).message}`));
    }, secs * 1000);
    timer.unref();
    this.timers.set(attemptId, timer);
  }

  private disarm(attemptId: string): void {
    const timer = this.timers.get(attemptId);
    if (timer) clearTimeout(timer);
    this.timers.delete(attemptId);
  }

  private async expire(attemptId: string): Promise<void> {
    const a = await this.prisma.transferAttempt.findUnique({ where: { id: attemptId }, select: { orgId: true, status: true, transferId: true, agentCallControlId: true } });
    if (!a || !OPEN_ATTEMPT.includes(a.status)) return;
    if (!(await this.closeAttempt(attemptId, TransferAttemptStatus.no_answer, [a.status], 'timeout'))) return;
    if (a.agentCallControlId) await this.activity.command(a.orgId, a.agentCallControlId, 'hangup');
    await this.next(a.transferId);
  }

  private async transferIdOf(attemptId: string): Promise<string> {
    return (await this.prisma.transferAttempt.findUniqueOrThrow({ where: { id: attemptId }, select: { transferId: true } })).transferId;
  }

  private async transfer(id: string) {
    const t = await this.prisma.callTransfer.findUnique({
      where: { id },
      select: {
        id: true,
        orgId: true,
        leadId: true,
        leadCallControlId: true,
        status: true,
        facts: true,
        lead: { select: { firstName: true, lastName: true, location: true } },
        attempts: { orderBy: { position: 'asc' }, select: { userId: true, status: true } },
      },
    });
    return t ? { ...t, leadCcid: t.leadCallControlId } : null;
  }

  /** Spoken to the lead while they hold. */
  private async say(t: TransferRef, text: string): Promise<void> {
    await this.activity.command(t.orgId, t.leadCcid, 'speak', { payload: text, voice: await this.activity.voiceOf(t.orgId) });
  }

  /** The agent who took the call gets the lead, unless another agent already has it (the owner decides then). */
  private async assignIfUnassigned(t: TransferRef, userId: string): Promise<void> {
    const lead = await this.prisma.lead.findUnique({ where: { id: t.leadId }, select: { assignedToId: true } });
    if (!lead || (lead.assignedToId && lead.assignedToId !== userId)) return;
    await this.assignments
      .assign(t.orgId, t.leadId, userId, { actorType: 'ai', actorId: null, assignmentType: AssignmentType.ai, reason: 'Took the live transfer of their call' })
      .catch((error) => this.logger.warn(`transfer ${t.id}: could not assign the lead: ${(error as Error).message}`));
  }

  private record(t: { id: string; orgId: string; leadId: string }, action: string, payload: Record<string, unknown>): void {
    void this.audit
      .record({ orgId: t.orgId, actorType: 'ai', actorId: null, action, entityType: 'lead', entityId: t.leadId, payload: { transferId: t.id, ...payload } })
      .catch((error) => this.logger.warn(`audit ${action}: ${(error as Error).message}`));
  }
}

interface TransferRef {
  id: string;
  orgId: string;
  leadId: string;
  leadCcid: string;
}
