import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CallDisposition, CallStatus, FollowUpReason, LeadStatus } from '@prisma/client';
import { spoken } from '@/calendar/booking/booking-time';
import { PrismaService } from '@/common/prisma/prisma.service';
import type { IntegrationEnv } from '@/common/utils/interface';
import { LeadStateService } from '@/lead/lead-state.service';
import { IN_STRATEGY_STATUSES, callbackPending } from '@/lead/lead-status';
import { fullName } from '@/lead/lead-scope';
import { AssistantService } from './assistant.service';
import { CallSlots } from './calls/call-slots';
import { CONVERSATION_MIN_SECS, type CallIntent } from './calls/call.types';
import { LeadInsightsService } from './lead-insights.service';
import { TelnyxCredentialsService } from './telnyx-credentials.service';
import { TELNYX_API } from './telnyx-api';
import { fillTemplate } from './template';
import { CALLBACK_GREETING } from './tools/call-tools';
import { CallToolsService } from './tools/call-tools.service';
import { VoicemailService } from './voicemail/voicemail.service';

interface AttachPlan {
  apiKey: string;
  assistantId: string | null;
  record: boolean;
  variables: Record<string, string>;
  /** Replaces the assistant's own greeting (a callback the lead asked for). */
  greeting?: string;
}

/** A callback call is one placed this close to the time the lead asked for. */
const CALLBACK_WINDOW_MS = 2 * 60 * 60_000;

const PREPARED_TTL_MS = 5 * 60 * 1000;
/** How many of the latest texts the assistant sees as the chat so far. */
const RECENT_SMS = 8;
const RECORDING_LINK_REUSE_MS = 5 * 60 * 1000;
/** SIP answers that mean the number does not exist: Not Found, Gone, Address Incomplete, Does Not Exist Anywhere. */
const INVALID_NUMBER_SIP = new Set(['404', '410', '484', '604']);
const BUSY_SIP = new Set(['486', '600']);
const DECLINED_SIP = new Set(['603']);
/** Telnyx's answering-machine verdicts that mean a person, or may: the assistant starts for these. */
const PERSON_VERDICTS = new Set(['human_residence', 'human_business', 'not_sure', 'silence']);

/** A call not over yet: the only rows a hang-up may close. */
const OPEN_CALL_STATUSES: CallStatus[] = [CallStatus.queued, CallStatus.ringing, CallStatus.in_progress];
/** A lost "greeting ended" webhook must not keep a voicemail call open: it is hung up after this. */
const BEEP_WAIT_MAX_MS = 35_000;
/** The longest a voicemail message may play before the call is hung up regardless. */
const VOICEMAIL_PLAY_MAX_MS = 60_000;
/** For a voicemail when the assistant's own voice cannot be read or spoken. */
const FALLBACK_TTS_VOICE = 'AWS.Polly.Joanna-Neural';

/** A call an answering machine picked up, from the verdict until our hangup. */
interface MachineCall {
  orgId: string;
  leadId: string;
  callId: string;
  apiKey: string;
  stage: 'waiting_beep' | 'speaking' | 'done';
  timer?: NodeJS.Timeout;
  /** The message and voice, prepared during the greeting so it starts right at the beep; null when it cannot be. */
  ready: Promise<{ payload: string; voice: string | null } | null>;
}

/**
 * How a call ended for the lead, from whether it was answered, whether an
 * answering machine took it, how long they talked, and Telnyx's hangup_cause
 * (call_rejected, normal_clearing, originator_cancel, timeout, time_limit,
 * user_busy, not_found, no_answer, unspecified) with the SIP code behind it.
 * An unanswered `unspecified` with a SIP 5xx is the network failing, not the lead.
 */
export function dispositionOf(call: {
  answered: boolean;
  machine?: boolean;
  durationSeconds: number | null;
  hangupCause: string;
  sipCause?: string;
}): CallDisposition {
  if (call.answered && call.machine) return CallDisposition.voicemail;
  if (call.answered) return (call.durationSeconds ?? 0) >= CONVERSATION_MIN_SECS ? CallDisposition.connected : CallDisposition.short;
  const sip = call.sipCause ?? '';
  if (call.hangupCause === 'not_found' || INVALID_NUMBER_SIP.has(sip)) return CallDisposition.invalid_number;
  if (call.hangupCause === 'user_busy' || BUSY_SIP.has(sip)) return CallDisposition.busy;
  if (call.hangupCause === 'call_rejected' || DECLINED_SIP.has(sip)) return CallDisposition.rejected;
  if (call.hangupCause === 'unspecified' && /^5\d\d$/.test(sip)) return CallDisposition.failed;
  return CallDisposition.no_answer;
}

/**
 * What happened on the phone and over SMS, recorded as calls and messages,
 * and the lead status moves that follow from it. Everything a call needs once
 * it is answered (assistant, recording, the lead's details) is prepared while
 * it rings, so the caller never hears a gap.
 */
@Injectable()
export class ActivityService {
  private readonly logger = new Logger(ActivityService.name);
  private readonly recordingLinks = new Map<string, { url: string; until: number }>();
  private readonly prepared = new Map<string, Promise<AttachPlan | null>>();
  /** Answered calls whose assistant waits for Telnyx to say whether a person or a machine picked up. */
  private readonly awaitingVerdict = new Map<string, { plan: AttachPlan; timer: NodeJS.Timeout }>();
  /** Telnyx's verdict per live call; it can arrive before the answer has been handled. */
  private readonly verdicts = new Map<string, string>();
  /** Live calls on which the assistant was started. */
  private readonly started = new Set<string>();
  private readonly machines = new Map<string, MachineCall>();
  /** Calls whose machine greeting has ended, even before the verdict was handled. */
  private readonly greetingEnded = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly creds: TelnyxCredentialsService,
    private readonly insights: LeadInsightsService,
    private readonly assistants: AssistantService,
    private readonly slots: CallSlots,
    private readonly config: ConfigService<IntegrationEnv, true>,
    private readonly state: LeadStateService,
    private readonly voicemail: VoicemailService,
    private readonly callTools: CallToolsService,
  ) {}

  async recordSms(orgId: string, leadId: string, text: string, ok: boolean, providerIdOrReason?: string | null): Promise<void> {
    try {
      await this.prisma.message.create({
        data: {
          orgId,
          leadId,
          senderType: 'ai',
          direction: 'outbound',
          channel: 'sms',
          body: text,
          providerMessageId: ok ? (providerIdOrReason ?? null) : null,
          deliveryStatus: ok ? 'sent' : 'failed',
          sentAt: new Date(),
          ...(ok ? {} : { failedAt: new Date() }),
        },
      });
    } catch (error) {
      this.logger.error(`recordSms: ${(error as Error).message}`);
    }
    if (ok) await this.markContacted(leadId);
    else await this.noteAttemptFailure(leadId, providerIdOrReason ? `SMS failed: ${providerIdOrReason}` : 'SMS failed');
  }

  async startCall(orgId: string, leadId: string, providerCallId?: string | null, intent: CallIntent = {}): Promise<void> {
    if (providerCallId) this.prepareAttach(providerCallId, orgId, leadId, intent);
    try {
      await this.prisma.call.create({
        data: { orgId, leadId, provider: 'telnyx', providerCallId: providerCallId ?? null, status: CallStatus.ringing, startedAt: new Date() },
      });
    } catch (error) {
      this.logger.error(`startCall: ${(error as Error).message}`);
    }
    await this.markContacted(leadId);
  }

  async recordCallFailed(orgId: string, leadId: string, reason?: string, disposition: CallDisposition = CallDisposition.failed): Promise<void> {
    try {
      const call = await this.prisma.call.create({
        data: { orgId, leadId, provider: 'telnyx', status: CallStatus.failed, disposition, startedAt: new Date(), endedAt: new Date() },
        select: { id: true },
      });
      this.state.quietly({ orgId, leadId, type: 'call_ended', source: 'call', channel: 'voice', callId: call.id, reason: reason ?? null, payload: { disposition } });
    } catch (error) {
      this.logger.error(`recordCallFailed: ${(error as Error).message}`);
    }
    await this.noteAttemptFailure(leadId, reason ? `Call failed: ${reason}` : 'Call failed');
  }

  /** The strategy ended without an outcome: park the lead with why, and whether we ever talked to them. */
  async exitStrategy(leadId: string, reason: string): Promise<void> {
    try {
      const lead = await this.prisma.lead.findUnique({ where: { id: leadId }, select: { orgId: true, firstResponseAt: true } });
      if (!lead) return;
      const talked = await this.prisma.call.count({
        where: { orgId: lead.orgId, leadId, OR: [{ disposition: CallDisposition.connected }, { status: CallStatus.in_progress }] },
      });
      await this.state.move(leadId, LeadStatus.follow_up, {
        source: 'strategy',
        reason,
        onlyFrom: IN_STRATEGY_STATUSES,
        data: {
          aiSummary: reason.slice(0, 2000),
          lastContactAt: new Date(),
          followUpReason: talked > 0 || lead.firstResponseAt ? FollowUpReason.not_ready : FollowUpReason.no_answer,
        },
      });
    } catch (error) {
      this.logger.error(`exitStrategy: ${(error as Error).message}`);
    }
  }

  async onCallAnswered(ccid: string, intent: CallIntent = {}): Promise<void> {
    const plan = this.prepared.get(ccid);
    const call = await (async () => {
      const row = await this.callByProvider(ccid);
      if (!row) return null;
      // Only a call still dialing goes live. The hang-up may have been handled first (its webhook
      // overtook this one), or this is the same event again: then nothing more happens on it.
      // From here startedAt is when the lead picked up, so an answered call's duration is talk time, not ringing.
      const { count } = await this.prisma.call.updateMany({
        where: { id: row.id, status: { in: [CallStatus.queued, CallStatus.ringing] } },
        data: { status: CallStatus.in_progress, startedAt: new Date() },
      });
      return count > 0 ? row : null;
    })().catch((error) => {
      this.logger.error(`onCallAnswered ${ccid}: ${(error as Error).message}`);
      return null;
    });
    if (!call) return;

    // The slot and the lead's note are kept while the assistant attaches, not before it: the caller hears no gap.
    const bookkeeping = Promise.all([this.slots.extend(call.orgId, ccid).catch(() => undefined), this.markContacted(call.leadId)]).catch((error) =>
      this.logger.error(`onCallAnswered ${ccid}: ${(error as Error).message}`),
    );
    const p = await (plan ?? this.prepareAttach(ccid, call.orgId, call.leadId, intent));
    if (p) await this.attach(ccid, p, intent.amd !== false);
    await bookkeeping;
  }

  async onCallHangup(ccid: string, payload: { hangup_cause?: string; sip_hangup_cause?: string } = {}): Promise<void> {
    const verdict = this.verdicts.get(ccid) ?? null;
    this.forget(ccid);
    const call = await this.callByProvider(ccid);
    if (!call) return;
    await this.slots.release(call.orgId, ccid).catch((error) => this.logger.warn(`release slot ${ccid}: ${(error as Error).message}`));
    const cause = String(payload.hangup_cause ?? '');
    const sipCause = String(payload.sip_hangup_cause ?? '');
    // Decided on the row as it is, locked, so an answered event racing this one can never leave the
    // call live, and the end, the disposition and the length land together. A call already over (the
    // same hang-up again) is left as it was.
    const result = await this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<{ status: CallStatus; started_at: Date | null; disposition: CallDisposition | null }[]>`
        SELECT status, started_at, disposition FROM calls WHERE id = ${call.id}::uuid FOR UPDATE`;
      if (!row || !OPEN_CALL_STATUSES.includes(row.status)) return null;
      const answered = row.status === CallStatus.in_progress;
      const endedAt = new Date();
      const durationSeconds = row.started_at ? Math.round((endedAt.getTime() - new Date(row.started_at).getTime()) / 1000) : null;
      const machine = row.disposition === CallDisposition.voicemail || verdict === 'machine';
      const disposition = dispositionOf({ answered, machine, durationSeconds, hangupCause: cause, sipCause });
      await tx.call.update({
        where: { id: call.id },
        data: { status: answered ? CallStatus.completed : CallStatus.no_answer, disposition, endedAt, durationSeconds },
      });
      return { disposition, durationSeconds };
    });
    if (!result) return;
    const { disposition, durationSeconds } = result;
    this.state.quietly({
      orgId: call.orgId,
      leadId: call.leadId,
      type: 'call_ended',
      source: 'call',
      channel: 'voice',
      callId: call.id,
      reason: cause || null,
      payload: { disposition, durationSeconds, answeredBy: verdict, sip: sipCause || null },
    });
    if (disposition === CallDisposition.invalid_number) {
      await this.markInvalid(call.leadId, `Invalid number (${cause}${sipCause ? `, SIP ${sipCause}` : ''})`);
      return;
    }
    if (disposition === CallDisposition.connected) {
      // A conversation is the lead's first response; a pick-up-and-hang-up is not.
      await this.prisma.lead.updateMany({ where: { id: call.leadId, firstResponseAt: null }, data: { firstResponseAt: new Date() } });
      // A callback set on this call keeps the lead parked for it, out of the strategy's statuses.
      const lead = await this.prisma.lead.findUnique({ where: { id: call.leadId }, select: { callbackAt: true } });
      if (lead && callbackPending(lead)) return;
      await this.state.move(call.leadId, LeadStatus.engaged, { source: 'call', reason: 'Talked on the call', channel: 'voice', callId: call.id });
      return;
    }
    await this.noteAttemptFailure(call.leadId, cause ? `No answer on the last call (${cause})` : 'No answer on the last call');
  }

  async onRecordingSaved(ccid: string, payload: any): Promise<void> {
    const url: string | null =
      payload?.recording_urls?.mp3 ?? payload?.recording_urls?.wav ?? payload?.public_recording_urls?.mp3 ?? payload?.public_recording_urls?.wav ?? null;
    if (!url) return;
    const call = await this.callByProvider(ccid);
    if (call) await this.prisma.call.update({ where: { id: call.id }, data: { recordingUrl: url } }).catch(() => undefined);
  }

  async onTranscriptionSaved(ccid: string, payload: any): Promise<void> {
    const text: string | null =
      payload?.transcription_text ?? payload?.transcription_data?.transcription_text ?? payload?.transcription?.text ?? null;
    if (!text) return;
    const call = await this.callByProvider(ccid);
    if (!call) return;
    await this.prisma.call
      .update({ where: { id: call.id }, data: { transcript: call.transcript ? `${call.transcript}\n${text}` : text } })
      .catch((error) => this.logger.error(`onTranscriptionSaved: ${(error as Error).message}`));
  }

  /** Telnyx recording links expire; a fresh one is fetched on demand and reused for a few minutes. */
  async freshRecordingUrl(orgId: string, callControlId: string): Promise<string | null> {
    const key = `${orgId}:${callControlId}`;
    const hit = this.recordingLinks.get(key);
    if (hit && hit.until > Date.now()) return hit.url;
    try {
      const c = await this.creds.getCreds(orgId);
      if (!c?.apiKey) return null;
      const res = await fetch(`${TELNYX_API}/recordings?filter[call_control_id]=${encodeURIComponent(callControlId)}`, {
        headers: { Authorization: `Bearer ${c.apiKey}` },
      });
      if (!res.ok) return null;
      const rows = (((await res.json()) as { data?: any[] }).data ?? []) as any[];
      const urls = rows
        .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')))
        .map((r) => r.download_urls?.mp3 ?? r.download_urls?.wav)
        .filter(Boolean);
      const url = urls.at(-1) ?? null;
      if (url) {
        if (this.recordingLinks.size > 500) this.recordingLinks.clear();
        this.recordingLinks.set(key, { url, until: Date.now() + RECORDING_LINK_REUSE_MS });
      }
      return url;
    } catch (error) {
      this.logger.warn(`recordings ${callControlId}: ${(error as Error).message}`);
      return null;
    }
  }

  async markInvalid(leadId: string, reason: string): Promise<void> {
    await this.state
      .move(leadId, LeadStatus.invalid, {
        source: 'call',
        reason,
        onlyFrom: [...IN_STRATEGY_STATUSES, LeadStatus.follow_up, LeadStatus.unresponsive],
        data: { lostReason: reason.slice(0, 255), aiSummary: reason },
      })
      .catch((error) => this.logger.error(`markInvalid: ${(error as Error).message}`));
  }

  callByProvider(ccid: string) {
    return this.prisma.call.findFirst({ where: { providerCallId: ccid }, orderBy: { createdAt: 'desc' } });
  }

  private async markContacted(leadId: string): Promise<void> {
    await this.state.move(leadId, LeadStatus.contacting, { source: 'strategy', reason: 'First message or call', onlyFrom: [LeadStatus.new] }).catch(() => undefined);
    await this.prisma.lead.update({ where: { id: leadId }, data: { lastContactAt: new Date() } }).catch(() => undefined);
  }

  private async noteAttemptFailure(leadId: string, reason: string): Promise<void> {
    await this.prisma.lead
      .updateMany({ where: { id: leadId }, data: { aiSummary: reason.slice(0, 2000), lastContactAt: new Date() } })
      .catch((error) => this.logger.error(`noteAttemptFailure: ${(error as Error).message}`));
  }

  private prepareAttach(ccid: string, orgId: string, leadId: string, intent: CallIntent = {}): Promise<AttachPlan | null> {
    const plan = (async (): Promise<AttachPlan | null> => {
      const c = await this.creds.getCreds(orgId);
      if (!c?.apiKey) return null;
      const [settings, leadVars] = await Promise.all([
        this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { callRecordingEnabled: true } }),
        c.assistantId ? this.leadVariables(orgId, leadId) : Promise.resolve({} as Record<string, string>),
        c.assistantId ? this.assistants.ensureCallSetup(orgId) : Promise.resolve(),
        c.assistantId ? this.callTools.ensure(orgId) : Promise.resolve(),
      ]);
      if (c.assistantId) void this.insights.ensureProvisioned(orgId);
      const variables = intent.context ? { ...leadVars, call_context: intent.context } : leadVars;
      const greeting = variables.callback_due === 'yes' ? await this.assistants.greetingFor(orgId, fillTemplate(CALLBACK_GREETING, variables)) : undefined;
      return { apiKey: c.apiKey, assistantId: c.assistantId || null, record: settings?.callRecordingEnabled ?? true, variables, greeting };
    })().catch((error) => {
      this.logger.error(`prepare attach ${ccid}: ${(error as Error).message}`);
      return null;
    });
    this.prepared.set(ccid, plan);
    setTimeout(() => this.prepared.delete(ccid), PREPARED_TTL_MS).unref();
    return plan;
  }

  /** `detection`: the call was dialed with answering-machine detection, so a verdict is coming. */
  private async attach(ccid: string, p: AttachPlan, detection = true): Promise<void> {
    if (p.record) await this.action(ccid, p.apiKey, 'record_start', { format: 'mp3', channels: 'dual', transcription: true });
    if (!p.assistantId) return;
    const verdict = this.verdicts.get(ccid);
    if (verdict && !PERSON_VERDICTS.has(verdict)) return;
    const waitMs = this.config.get('AI_OPENING_WAIT_MS', { infer: true });
    // Without detection there is nothing to wait for: the assistant starts on the pick-up, and the
    // call analysis tells a voicemail from a conversation afterwards.
    if (verdict || !waitMs || !detection) return this.startAssistant(ccid, p);
    // The assistant, and with it the greeting, starts once Telnyx says a person
    // picked up (by then they have said "Hello?"), or when waitMs runs out
    // without a verdict. A machine never hears it.
    const timer = setTimeout(() => void this.releaseAssistant(ccid), waitMs);
    timer.unref();
    this.awaitingVerdict.set(ccid, { plan: p, timer });
  }

  /** Telnyx's verdict on who answered: a person starts the waiting assistant, a machine gets the voicemail. */
  async onMachineDetection(ccid: string, result: string | undefined, intent: CallIntent = {}): Promise<void> {
    if (this.verdicts.has(ccid)) return;
    const verdict = String(result || 'not_sure');
    this.verdicts.set(ccid, verdict);
    if (PERSON_VERDICTS.has(verdict)) return this.releaseAssistant(ccid);
    await this.onMachine(ccid, verdict, intent);
  }

  /** The machine's greeting is over (beep or not): the moment to leave the message. */
  async onGreetingEnded(ccid: string, intent: CallIntent = {}): Promise<void> {
    this.greetingEnded.add(ccid);
    // A beep heard before the verdict comes alone, without call.machine.premium.detection.ended.
    if (!this.verdicts.has(ccid)) {
      this.verdicts.set(ccid, 'machine');
      return this.onMachine(ccid, 'machine', intent);
    }
    const machine = this.machines.get(ccid);
    if (machine?.stage === 'waiting_beep') await this.leaveVoicemail(ccid, machine);
  }

  async onSpeakEnded(ccid: string, status: string | undefined): Promise<void> {
    if (this.machines.get(ccid)?.stage === 'speaking') await this.endVoicemail(ccid, status === 'completed');
  }

  /** Starts the assistant held back by attach(); once per call, whichever comes first. */
  private async releaseAssistant(ccid: string): Promise<void> {
    const waiting = this.awaitingVerdict.get(ccid);
    if (!waiting) return;
    this.awaitingVerdict.delete(ccid);
    clearTimeout(waiting.timer);
    await this.startAssistant(ccid, waiting.plan);
  }

  private async startAssistant(ccid: string, p: AttachPlan): Promise<void> {
    this.started.add(ccid);
    await this.action(ccid, p.apiKey, 'ai_assistant_start', {
      assistant: { id: p.assistantId },
      dynamic_variables: p.variables,
      ...(p.greeting ? { greeting: p.greeting } : {}),
    });
  }

  /**
   * An answering machine took the call: the assistant never talks to it (and
   * is stopped if it had started without a verdict). With voicemail on, the
   * message waits for the greeting to end; otherwise the call ends now.
   */
  private async onMachine(ccid: string, verdict: string, intent: CallIntent): Promise<void> {
    const waiting = this.awaitingVerdict.get(ccid);
    if (waiting) {
      clearTimeout(waiting.timer);
      this.awaitingVerdict.delete(ccid);
    }
    const call = await this.callByProvider(ccid);
    if (!call || call.endedAt) return;
    const c = await this.creds.getCreds(call.orgId).catch(() => null);
    if (!c?.apiKey) return;
    if (this.started.has(ccid)) await this.action(ccid, c.apiKey, 'ai_assistant_stop', {});
    if (verdict !== 'machine') {
      await this.action(ccid, c.apiKey, 'hangup', {});
      return;
    }
    await this.prisma.call
      .update({ where: { id: call.id }, data: { disposition: CallDisposition.voicemail } })
      .catch((error) => this.logger.warn(`voicemail ${ccid}: ${(error as Error).message}`));
    // The call step may override the organization's setting either way.
    const settings = await this.voicemail.settings(call.orgId);
    const leave = intent.voicemail === 'leave' || (intent.voicemail !== 'skip' && settings.enabled);
    if (!leave) {
      await this.action(ccid, c.apiKey, 'hangup', {});
      return;
    }
    const ready = Promise.all([this.leadVariables(call.orgId, call.leadId), this.assistants.voiceFor(call.orgId)])
      .then(([variables, voice]) => ({ payload: fillTemplate(settings.message, variables), voice }))
      .catch((error) => {
        this.logger.warn(`voicemail ${ccid}: ${(error as Error).message}`);
        return null;
      });
    const machine: MachineCall = { orgId: call.orgId, leadId: call.leadId, callId: call.id, apiKey: c.apiKey, stage: 'waiting_beep', ready };
    machine.timer = setTimeout(() => void this.endVoicemail(ccid, false), BEEP_WAIT_MAX_MS);
    machine.timer.unref();
    this.machines.set(ccid, machine);
    // The greeting may have ended while the verdict was being handled.
    if (this.greetingEnded.has(ccid)) await this.leaveVoicemail(ccid, machine);
  }

  private async leaveVoicemail(ccid: string, machine: MachineCall): Promise<void> {
    machine.stage = 'speaking';
    clearTimeout(machine.timer);
    machine.timer = setTimeout(() => void this.endVoicemail(ccid, false), VOICEMAIL_PLAY_MAX_MS);
    machine.timer.unref();
    const message = await machine.ready;
    if (!message) return this.endVoicemail(ccid, false);
    const { payload, voice } = message;
    let spoken = await this.action(ccid, machine.apiKey, 'speak', { payload, voice: voice ?? FALLBACK_TTS_VOICE });
    if (!spoken && voice) spoken = await this.action(ccid, machine.apiKey, 'speak', { payload, voice: FALLBACK_TTS_VOICE });
    if (!spoken) await this.endVoicemail(ccid, false);
  }

  /** Hangs up a voicemail call, once; `left` when the whole message was played. */
  private async endVoicemail(ccid: string, left: boolean): Promise<void> {
    const machine = this.machines.get(ccid);
    if (!machine || machine.stage === 'done') return;
    const played = machine.stage === 'speaking' && left;
    machine.stage = 'done';
    clearTimeout(machine.timer);
    if (played) {
      this.state.quietly({ orgId: machine.orgId, leadId: machine.leadId, type: 'voicemail_left', source: 'call', channel: 'voice', callId: machine.callId });
    }
    await this.action(ccid, machine.apiKey, 'hangup', {});
  }

  /** Drops everything held for a call that has ended. */
  private forget(ccid: string): void {
    const waiting = this.awaitingVerdict.get(ccid);
    if (waiting) clearTimeout(waiting.timer);
    this.awaitingVerdict.delete(ccid);
    const machine = this.machines.get(ccid);
    if (machine) clearTimeout(machine.timer);
    this.machines.delete(ccid);
    this.verdicts.delete(ccid);
    this.greetingEnded.delete(ccid);
    this.started.delete(ccid);
  }

  /** A Call Control command; false (logged) when Telnyx refused it or could not be reached. */
  private async action(ccid: string, apiKey: string, name: string, body: object): Promise<boolean> {
    try {
      const res = await fetch(`${TELNYX_API}/calls/${ccid}/actions/${name}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) this.logger.warn(`${name} ${ccid}: ${res.status} ${await res.text()}`);
      return res.ok;
    } catch (error) {
      this.logger.warn(`${name} ${ccid}: ${(error as Error).message}`);
      return false;
    }
  }

  /** The lead's details as the assistant's dynamic variables. */
  /**
   * The lead's details as the assistant's dynamic variables, on a call and in a
   * text chat. last_outbound_sms is the text a reply answers; recent_sms is the
   * chat so far, only once the lead has texted back.
   */
  async leadVariables(orgId: string, leadId: string): Promise<Record<string, string>> {
    const [lead, org, settings, texts] = await Promise.all([
      this.prisma.lead.findFirst({ where: { id: leadId, orgId } }),
      this.prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } }),
      this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { timezone: true } }),
      this.prisma.message.findMany({
        where: { orgId, leadId, channel: 'sms' },
        orderBy: { createdAt: 'desc' },
        take: RECENT_SMS,
        select: { direction: true, body: true },
      }),
    ]);
    if (!lead) return {};
    const lastOutbound = texts.find((m) => m.direction === 'outbound')?.body ?? '';
    const chatted = texts.some((m) => m.direction === 'inbound');
    const recent = chatted
      ? texts
          .slice()
          .reverse()
          .map((m) => `${m.direction === 'inbound' ? 'Lead' : 'Us'}: ${m.body ?? ''}`)
          .join(' | ')
          .slice(-1500)
      : '';
    const str = (v: unknown): string => (v == null ? '' : String(v));
    const callbackDue = !!lead.callbackAt && Math.abs(Date.now() - lead.callbackAt.getTime()) <= CALLBACK_WINDOW_MS;
    const budget =
      lead.minBudget != null && lead.maxBudget != null
        ? `${Number(lead.minBudget).toLocaleString()} to ${Number(lead.maxBudget).toLocaleString()}`
        : str(lead.maxBudget ?? lead.minBudget);
    return {
      firstName: lead.firstName?.trim() || 'there',
      lastName: str(lead.lastName),
      fullName: fullName(lead.firstName, lead.lastName),
      email: str(lead.email),
      phone: str(lead.phone),
      location: str(lead.location),
      budget,
      bedrooms: str(lead.bedrooms),
      timeline: str(lead.timeline),
      financingStatus: str(lead.financingStatus),
      temperature: str(lead.temperature),
      motivation: str(lead.motivation),
      brokerage: str(org?.name),
      leadId,
      last_outbound_sms: lastOutbound,
      recent_sms: recent,
      callback_due: callbackDue ? 'yes' : '',
      // Why this call is being made, set per call by the step that placed it.
      call_context: '',
      callback_time: lead.callbackAt ? spoken(lead.callbackAt, settings?.timezone || 'UTC') : '',
    };
  }
}
