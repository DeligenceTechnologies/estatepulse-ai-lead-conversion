import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CallStatus, FollowUpReason, LeadStatus } from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';
import type { IntegrationEnv } from '@/common/utils/interface';
import { IN_STRATEGY_STATUSES } from '@/lead/lead-status';
import { fullName } from '@/lead/lead-scope';
import { AssistantService } from './assistant.service';
import { CallSlots } from './calls/call-slots';
import { LeadInsightsService } from './lead-insights.service';
import { voicemailOf, type Strategy } from './strategy-store.service';
import { TelnyxCredentialsService } from './telnyx-credentials.service';
import { TELNYX_API } from './telnyx-api';

interface AttachPlan {
  apiKey: string;
  assistantId: string | null;
  record: boolean;
  variables: Record<string, string>;
}

const PREPARED_TTL_MS = 5 * 60 * 1000;
const RECORDING_LINK_REUSE_MS = 5 * 60 * 1000;
/** SIP answers that mean the number does not exist: Not Found, Gone, Address Incomplete, Does Not Exist Anywhere. */
const DEAD_NUMBER_SIP = new Set(['404', '410', '484', '604']);
const MACHINE_RESULTS = new Set(['machine', 'silence', 'fax_detected']);

/**
 * Why a call ended, in Telnyx's hangup_cause words (call_rejected, normal_clearing, originator_cancel,
 * timeout, time_limit, user_busy, not_found, no_answer, unspecified), with the SIP code folded in
 * when the cause is unspecified: a dead number is 'not_found', busy 'user_busy', declined 'call_rejected'.
 */
export function endReasonOf(cause: string | undefined, sip: string | undefined): string {
  const c = (cause ?? '').trim() || 'unspecified';
  const s = (sip ?? '').trim();
  if (c === 'not_found' || DEAD_NUMBER_SIP.has(s)) return 'not_found';
  if (c !== 'unspecified') return c.slice(0, 40);
  if (s === '486' || s === '600') return 'user_busy';
  if (s === '603') return 'call_rejected';
  return c;
}

/**
 * What happened on the phone and over SMS, recorded as calls and messages,
 * and the lead status moves that follow from it. Everything a call needs once
 * it is answered (assistant, recording, the lead's details) is prepared while
 * it rings, so the caller never hears a gap. A call's row only ever moves
 * forward (ringing → in progress → completed, or ringing → no answer), so a
 * repeated or late event changes nothing.
 */
@Injectable()
export class ActivityService {
  private readonly logger = new Logger(ActivityService.name);
  private readonly recordingLinks = new Map<string, { url: string; until: number }>();
  private readonly prepared = new Map<string, Promise<AttachPlan | null>>();
  /** Answered calls whose assistant waits for the lead to speak first. */
  private readonly awaitingLead = new Map<string, { plan: AttachPlan; timer: NodeJS.Timeout }>();
  /** Calls a machine picked up, waiting for its beep to leave the owner's message. */
  private readonly leaving = new Map<string, { apiKey: string; text: string }>();
  /** Beeps heard before the machine verdict came. */
  private readonly beepHeard = new Set<string>();
  /** Calls on which the message is being left; the hang-up follows its end. */
  private readonly spoken = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly creds: TelnyxCredentialsService,
    private readonly insights: LeadInsightsService,
    private readonly assistants: AssistantService,
    private readonly slots: CallSlots,
    private readonly config: ConfigService<IntegrationEnv, true>,
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

  async startCall(orgId: string, leadId: string, providerCallId?: string | null): Promise<void> {
    if (providerCallId) this.prepareAttach(providerCallId, orgId, leadId);
    try {
      await this.prisma.call.create({
        data: { orgId, leadId, provider: 'telnyx', providerCallId: providerCallId ?? null, status: CallStatus.ringing, startedAt: new Date() },
      });
    } catch (error) {
      this.logger.error(`startCall: ${(error as Error).message}`);
    }
    await this.markContacted(leadId);
  }

  async recordCallFailed(orgId: string, leadId: string, reason?: string): Promise<void> {
    try {
      await this.prisma.call.create({
        data: { orgId, leadId, provider: 'telnyx', status: CallStatus.failed, startedAt: new Date(), endedAt: new Date() },
      });
    } catch (error) {
      this.logger.error(`recordCallFailed: ${(error as Error).message}`);
    }
    await this.noteAttemptFailure(leadId, reason ? `Call failed: ${reason}` : 'Call failed');
  }

  /** The strategy ended without an outcome: park the lead with why, and whether we ever reached them. */
  async exitStrategy(leadId: string, reason: string): Promise<void> {
    try {
      const lead = await this.prisma.lead.findUnique({ where: { id: leadId }, select: { orgId: true, firstResponseAt: true } });
      if (!lead) return;
      const answered = await this.prisma.call.count({
        where: { orgId: lead.orgId, leadId, status: { in: [CallStatus.completed, CallStatus.in_progress] } },
      });
      await this.prisma.lead.updateMany({
        where: { id: leadId, status: { in: IN_STRATEGY_STATUSES } },
        data: {
          aiSummary: reason.slice(0, 2000),
          lastContactAt: new Date(),
          status: LeadStatus.follow_up,
          followUpReason: answered > 0 || lead.firstResponseAt ? FollowUpReason.not_ready : FollowUpReason.no_answer,
        },
      });
    } catch (error) {
      this.logger.error(`exitStrategy: ${(error as Error).message}`);
    }
  }

  async onCallAnswered(ccid: string): Promise<void> {
    const prepared = this.prepared.get(ccid);
    const call = await this.answeredRow(ccid);
    if (!call) return;
    // The slot and the lead's note are kept while the assistant attaches, not before it: the caller hears no gap.
    const bookkeeping = Promise.all([this.slots.extend(call.orgId, ccid).catch(() => undefined), this.markContacted(call.leadId, true)]).catch(
      (error) => this.logger.error(`onCallAnswered ${ccid}: ${(error as Error).message}`),
    );
    const p = await (prepared ?? this.prepareAttach(ccid, call.orgId, call.leadId));
    if (p) await this.attach(ccid, p);
    await bookkeeping;
  }

  /** The call's row moved to in progress; null when it was not still ringing (a hang-up got there first, or the same event again) or could not be read. */
  private async answeredRow(ccid: string) {
    try {
      const call = await this.callByProvider(ccid);
      if (!call) return null;
      const { count } = await this.prisma.call.updateMany({
        where: { id: call.id, status: { in: [CallStatus.queued, CallStatus.ringing] } },
        data: { status: CallStatus.in_progress, answeredAt: new Date() },
      });
      return count === 0 ? null : call;
    } catch (error) {
      this.logger.error(`onCallAnswered ${ccid}: ${(error as Error).message}`);
      return null;
    }
  }

  async onCallHangup(ccid: string, payload: { hangup_cause?: string; sip_hangup_cause?: string } = {}): Promise<void> {
    const waiting = this.awaitingLead.get(ccid);
    if (waiting) {
      clearTimeout(waiting.timer);
      this.awaitingLead.delete(ccid);
    }
    this.leaving.delete(ccid);
    this.beepHeard.delete(ccid);
    this.spoken.delete(ccid);
    const call = await this.callByProvider(ccid);
    if (!call) return;
    await this.slots.release(call.orgId, ccid).catch((error) => this.logger.warn(`release slot ${ccid}: ${(error as Error).message}`));
    const endReason = endReasonOf(payload.hangup_cause, payload.sip_hangup_cause);
    // One move, decided on the row as it is at that moment: answered → completed, never answered →
    // no answer. A call already over (the same hang-up twice) is left as it is. Stamped with this
    // process's clock, like answered_at and started_at (the database's can be hundreds of ms off),
    // and the end never precedes the pick-up, whichever event took its timestamp first.
    const now = new Date();
    const durationSeconds = call.startedAt ? Math.round((now.getTime() - call.startedAt.getTime()) / 1000) : null;
    const [ended] = await this.prisma.$queryRaw<{ status: CallStatus }[]>`
      UPDATE calls
         SET status = CASE WHEN status = 'in_progress'::call_status THEN 'completed'::call_status ELSE 'no_answer'::call_status END,
             ended_at = GREATEST(answered_at, ${now}::timestamptz),
             duration_seconds = ${durationSeconds}::int,
             end_reason = ${endReason}
       WHERE id = ${call.id}::uuid AND status IN ('queued'::call_status, 'ringing'::call_status, 'in_progress'::call_status)
       RETURNING status`;
    if (!ended) return;
    const answered = ended.status === CallStatus.completed;
    const cause = String(payload.hangup_cause ?? '');
    if (endReason === 'not_found') {
      await this.markInvalid(call.leadId, `Invalid number (${cause}${payload.sip_hangup_cause ? `, SIP ${payload.sip_hangup_cause}` : ''})`);
      return;
    }
    if (!answered) {
      await this.noteAttemptFailure(call.leadId, cause ? `No answer on the last call (${cause})` : 'No answer on the last call');
    }
  }

  /**
   * Answering machine detection's verdict (premium or standard): a machine is voicemail; not sure
   * is taken as a person and the assistant carries on. On a machine the assistant is silenced and,
   * as "Detect voicemail" in AI Settings says, the call hangs up or the owner's message is left
   * after the beep. The call's row says a machine answered either way, so the step after it goes
   * at once ("not answered") without waiting for an analysis.
   */
  async onMachineDetection(ccid: string, payload: { result?: string } = {}): Promise<void> {
    const call = await this.callByProvider(ccid);
    if (!call || !payload.result) return;
    const machine = MACHINE_RESULTS.has(payload.result);
    await this.prisma.call.update({ where: { id: call.id }, data: { answeredBy: machine ? 'machine' : 'human' } });
    if (!machine) return;
    const c = await this.creds.getCreds(call.orgId);
    if (!c?.apiKey) return;
    await this.silenceAssistant(ccid, c.apiKey);
    const vm = voicemailOf(await this.strategyOf(call.orgId));
    if (vm.action !== 'leave_message') return this.action(ccid, c.apiKey, 'hangup', {});
    const text = await this.fillVariables(call.orgId, call.leadId, vm.message);
    // The beep may have come before the verdict; otherwise the message waits for it.
    if (this.beepHeard.delete(ccid)) return this.speakVoicemail(ccid, c.apiKey, text);
    this.leaving.set(ccid, { apiKey: c.apiKey, text });
  }

  /** The machine's greeting ended: after a beep the message is left; without one there is nothing to leave it on. */
  async onMachineGreetingEnded(ccid: string, payload: { result?: string } = {}): Promise<void> {
    const beep = payload.result === 'beep_detected';
    const waiting = this.leaving.get(ccid);
    if (!waiting) {
      if (beep) this.beepHeard.add(ccid);
      return;
    }
    this.leaving.delete(ccid);
    if (beep) return this.speakVoicemail(ccid, waiting.apiKey, waiting.text);
    await this.action(ccid, waiting.apiKey, 'hangup', {});
  }

  /** The message has been left: hang up. */
  async onSpeakEnded(ccid: string): Promise<void> {
    const apiKey = this.spoken.get(ccid);
    if (!apiKey) return;
    this.spoken.delete(ccid);
    await this.action(ccid, apiKey, 'hangup', {});
  }

  private async speakVoicemail(ccid: string, apiKey: string, text: string): Promise<void> {
    this.spoken.set(ccid, apiKey);
    // The basic service level: en-US text, the voice named by gender. Enough for a short message.
    await this.action(ccid, apiKey, 'speak', { payload: text, voice: 'female', service_level: 'basic', language: 'en-US' });
  }

  /** The assistant has nothing to say to a machine: dropped while still waiting for the lead's first words, stopped once started. */
  private async silenceAssistant(ccid: string, apiKey: string): Promise<void> {
    const waiting = this.awaitingLead.get(ccid);
    if (waiting) {
      this.awaitingLead.delete(ccid);
      clearTimeout(waiting.timer);
      await this.action(ccid, apiKey, 'transcription_stop', {});
      return;
    }
    await this.action(ccid, apiKey, 'ai_assistant_stop', {});
  }

  private async strategyOf(orgId: string): Promise<Strategy | null> {
    const settings = await this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { outreachStrategy: true } }).catch(() => null);
    return (settings?.outreachStrategy as unknown as Strategy | null) ?? null;
  }

  private async fillVariables(orgId: string, leadId: string, template: string): Promise<string> {
    const v = await this.callVariables(orgId, leadId);
    return template.replace(/\{\{firstName\}\}/g, v.firstName || 'there').replace(/\{\{brokerage\}\}/g, v.brokerage || 'our team');
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
    await this.prisma.lead
      .updateMany({
        where: { id: leadId, status: { in: [...IN_STRATEGY_STATUSES, LeadStatus.follow_up] } },
        data: { status: LeadStatus.invalid, lostReason: reason.slice(0, 255), aiSummary: reason },
      })
      .catch((error) => this.logger.error(`markInvalid: ${(error as Error).message}`));
  }

  callByProvider(ccid: string) {
    return this.prisma.call.findFirst({ where: { providerCallId: ccid }, orderBy: { createdAt: 'desc' } });
  }

  private async markContacted(leadId: string, response = false): Promise<void> {
    await this.prisma.lead
      .updateMany({ where: { id: leadId, status: LeadStatus.new }, data: { status: LeadStatus.contacting } })
      .catch(() => undefined);
    await this.prisma.lead
      .update({ where: { id: leadId }, data: { lastContactAt: new Date(), ...(response ? { firstResponseAt: new Date() } : {}) } })
      .catch(() => undefined);
  }

  private async noteAttemptFailure(leadId: string, reason: string): Promise<void> {
    await this.prisma.lead
      .updateMany({ where: { id: leadId }, data: { aiSummary: reason.slice(0, 2000), lastContactAt: new Date() } })
      .catch((error) => this.logger.error(`noteAttemptFailure: ${(error as Error).message}`));
  }

  private prepareAttach(ccid: string, orgId: string, leadId: string): Promise<AttachPlan | null> {
    const plan = (async (): Promise<AttachPlan | null> => {
      const c = await this.creds.getCreds(orgId);
      if (!c?.apiKey) return null;
      const [settings, variables] = await Promise.all([
        this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { callRecordingEnabled: true } }),
        c.assistantId ? this.callVariables(orgId, leadId) : Promise.resolve({}),
        c.assistantId ? this.assistants.ensureCallSetup(orgId) : Promise.resolve(),
      ]);
      if (c.assistantId) void this.insights.ensureProvisioned(orgId);
      return { apiKey: c.apiKey, assistantId: c.assistantId || null, record: settings?.callRecordingEnabled ?? true, variables };
    })().catch((error) => {
      this.logger.error(`prepare attach ${ccid}: ${(error as Error).message}`);
      return null;
    });
    this.prepared.set(ccid, plan);
    setTimeout(() => this.prepared.delete(ccid), PREPARED_TTL_MS).unref();
    return plan;
  }

  private async attach(ccid: string, p: AttachPlan): Promise<void> {
    if (p.record) await this.action(ccid, p.apiKey, 'record_start', { format: 'mp3', channels: 'dual', transcription: true });
    if (!p.assistantId) return;
    const waitMs = this.config.get('AI_OPENING_WAIT_MS', { infer: true });
    if (!waitMs) return this.startAssistant(ccid, p);
    // The lead answers first ("Hello?"): the assistant, and with it the greeting,
    // starts on their first words, or once they have stayed silent for waitMs.
    // A live transcript of their side tells us when they speak.
    const timer = setTimeout(() => void this.releaseAssistant(ccid), waitMs);
    timer.unref();
    this.awaitingLead.set(ccid, { plan: p, timer });
    await this.action(ccid, p.apiKey, 'transcription_start', {
      transcription_engine: 'Google',
      transcription_tracks: 'inbound',
      transcription_engine_config: { transcription_engine: 'Google', language: 'en', interim_results: true },
    });
  }

  /** A live transcript of the lead's side: their first words start the waiting assistant. */
  async onCallSpeech(ccid: string, payload: { transcription_data?: { transcript?: string } } = {}): Promise<void> {
    if (payload.transcription_data?.transcript?.trim()) await this.releaseAssistant(ccid);
  }

  /** Starts the assistant held back by attach(); once per call, whichever comes first. */
  private async releaseAssistant(ccid: string): Promise<void> {
    const waiting = this.awaitingLead.get(ccid);
    if (!waiting) return;
    this.awaitingLead.delete(ccid);
    clearTimeout(waiting.timer);
    void this.action(ccid, waiting.plan.apiKey, 'transcription_stop', {});
    await this.startAssistant(ccid, waiting.plan);
  }

  private async startAssistant(ccid: string, p: AttachPlan): Promise<void> {
    await this.action(ccid, p.apiKey, 'ai_assistant_start', { assistant: { id: p.assistantId }, dynamic_variables: p.variables });
  }

  private async action(ccid: string, apiKey: string, name: string, body: object): Promise<void> {
    try {
      const res = await fetch(`${TELNYX_API}/calls/${ccid}/actions/${name}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) this.logger.warn(`${name} ${ccid}: ${res.status} ${await res.text()}`);
    } catch (error) {
      this.logger.warn(`${name} ${ccid}: ${(error as Error).message}`);
    }
  }

  /** The lead's details as the assistant's dynamic variables. */
  private async callVariables(orgId: string, leadId: string): Promise<Record<string, string>> {
    const [lead, org] = await Promise.all([
      this.prisma.lead.findFirst({ where: { id: leadId, orgId } }),
      this.prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } }),
    ]);
    if (!lead) return {};
    const str = (v: unknown): string => (v == null ? '' : String(v));
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
    };
  }
}
