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
const INVALID_NUMBER_CAUSES = new Set(['unallocated_number', 'invalid_number_format', 'number_changed']);

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
  /** Answered calls whose assistant waits for the lead to speak first. */
  private readonly awaitingLead = new Map<string, { plan: AttachPlan; timer: NodeJS.Timeout }>();

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
    const bookkeeping = (async () => {
      const call = await this.callByProvider(ccid);
      if (!call) return null;
      await this.prisma.call.update({ where: { id: call.id }, data: { status: CallStatus.in_progress } });
      await this.slots.extend(call.orgId, ccid).catch(() => undefined);
      await this.markContacted(call.leadId, true);
      return call;
    })().catch((error) => {
      this.logger.error(`onCallAnswered ${ccid}: ${(error as Error).message}`);
      return null;
    });

    let plan = this.prepared.get(ccid);
    if (!plan) {
      const call = await bookkeeping;
      if (!call) return;
      plan = this.prepareAttach(ccid, call.orgId, call.leadId);
    }
    const p = await plan;
    if (p) await this.attach(ccid, p);
    await bookkeeping;
  }

  async onCallHangup(ccid: string, payload: { hangup_cause?: string } = {}): Promise<void> {
    const waiting = this.awaitingLead.get(ccid);
    if (waiting) {
      clearTimeout(waiting.timer);
      this.awaitingLead.delete(ccid);
    }
    const call = await this.callByProvider(ccid);
    if (!call) return;
    await this.slots.release(call.orgId, ccid).catch((error) => this.logger.warn(`release slot ${ccid}: ${(error as Error).message}`));
    const answered = call.status === CallStatus.in_progress;
    await this.prisma.call.update({
      where: { id: call.id },
      data: {
        status: answered ? CallStatus.completed : CallStatus.no_answer,
        endedAt: new Date(),
        durationSeconds: call.startedAt ? Math.round((Date.now() - call.startedAt.getTime()) / 1000) : null,
      },
    });
    const cause = String(payload.hangup_cause ?? '');
    if (INVALID_NUMBER_CAUSES.has(cause)) {
      await this.markInvalid(call.leadId, `Invalid number (${cause})`);
      return;
    }
    if (!answered) {
      await this.noteAttemptFailure(call.leadId, cause ? `No answer on the last call (${cause})` : 'No answer on the last call');
    }
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
        c.assistantId ? this.assistants.ensureHangupTool(orgId) : Promise.resolve(),
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
