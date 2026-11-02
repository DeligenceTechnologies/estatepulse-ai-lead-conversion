import { Injectable, Logger } from '@nestjs/common';
import { CallDisposition, LeadStatus, type Call, type LeadTemperature, type Prisma } from '@prisma/client';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { verifyTelnyxSignature } from '@/common/utils/crypto';
import { LeadStateService } from '@/lead/lead-state.service';
import { OUTCOME_STATUSES } from '@/lead/lead-status';
import { EngineService } from './engine.service';
import { LeadInsightsService } from './lead-insights.service';
import { LeadMemoryService } from './lead-memory.service';
import {
  leadDetailsFrom,
  parseExtraction,
  scoreLead,
  type Extraction,
  type ScoreReason,
  type Thresholds,
  type ThresholdsInput,
} from './lead-scoring';
import { TelnyxCredentialsService } from './telnyx-credentials.service';
import { OutcomeService } from './tools/outcome.service';

export interface Qualification {
  source: 'telnyx_insights' | 'transcript';
  score: number;
  temperature: LeadTemperature;
  reasons: ScoreReason[];
  override: string | null;
  thresholds: Thresholds;
  extraction: Extraction;
  scoredAt: string;
}

export interface SignedDelivery {
  signature: string | undefined;
  timestamp: string | undefined;
  rawBody: Buffer | undefined;
}

/** How long to wait for the Insight before scoring from the transcript ourselves. */
export const TRANSCRIPT_FALLBACK_MS = 90_000;

/** Outcomes past which a new score only updates the temperature, never the status. */
const SETTLED_STATUSES: LeadStatus[] = OUTCOME_STATUSES.filter((s) => s !== LeadStatus.interested);

@Injectable()
export class LeadScoringService {
  private readonly logger = new Logger(LeadScoringService.name);
  private readonly pendingFallback = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly creds: TelnyxCredentialsService,
    private readonly insights: LeadInsightsService,
    private readonly engine: EngineService,
    private readonly state: LeadStateService,
    private readonly outcomes: OutcomeService,
    private readonly memory: LeadMemoryService,
  ) {}

  /** The Insight's result for a call. Signed by Telnyx; refused when the signature does not verify. */
  async onInsightsGenerated(ccid: string, payload: any, delivery: SignedDelivery): Promise<void> {
    const call = await this.prisma.call.findFirst({ where: { providerCallId: ccid }, orderBy: { createdAt: 'desc' } });
    if (!call || call.disposition === CallDisposition.voicemail) return;
    const c = await this.creds.getCreds(call.orgId).catch(() => null);
    if (c?.publicKey && !verifyTelnyxSignature({ publicKey: c.publicKey, ...delivery })) {
      this.logger.warn(`insights for call ${call.id}: bad Telnyx signature — ignored`);
      return;
    }
    const results: any[] = Array.isArray(payload?.results) ? payload.results : [];
    const extraction = results.map((r) => parseExtraction(r?.result)).find((x) => x != null);
    if (!extraction) return;
    await this.apply(call, extraction, 'telnyx_insights');
  }

  onTranscriptSaved(ccid: string, delayMs = TRANSCRIPT_FALLBACK_MS): void {
    void (async () => {
      const call = await this.prisma.call.findFirst({ where: { providerCallId: ccid }, orderBy: { createdAt: 'desc' }, select: { id: true, orgId: true } });
      if (!call || this.pendingFallback.has(call.id)) return;
      this.pendingFallback.add(call.id);
      setTimeout(() => {
        void this.scoreIfUnscored(call.orgId, call.id)
          .catch((error) => this.logger.warn(`transcript scoring for call ${call.id}: ${(error as Error).message}`))
          .finally(() => this.pendingFallback.delete(call.id));
      }, delayMs).unref();
    })().catch((error) => this.logger.warn(`transcript fallback ${ccid}: ${(error as Error).message}`));
  }

  async scoreIfUnscored(orgId: string, callId: string): Promise<Qualification | null> {
    const call = await this.prisma.call.findFirst({ where: { id: callId, orgId } });
    // A voicemail's transcript is the machine's greeting, not anything the lead said.
    if (!call?.transcript?.trim() || call.disposition === CallDisposition.voicemail) return null;
    if ((call.extractedIntel as { qualification?: unknown } | null)?.qualification) return null;
    return this.classifyCall(orgId, callId);
  }

  async classifyCall(orgId: string, callId: string): Promise<Qualification> {
    const call = await this.prisma.call.findFirst({ where: { id: callId, orgId } });
    if (!call) throw new AppError('NOT_FOUND', 'No such call');
    if (!call.transcript?.trim()) throw new AppError('CONFLICT', 'This call has no transcript to classify yet');
    return this.apply(call, await this.insights.extractFromTranscript(orgId, call.transcript), 'transcript');
  }

  async getThresholds(orgId: string): Promise<Thresholds> {
    const s = await this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { leadHotThreshold: true, leadWarmThreshold: true } });
    return { hot: s?.leadHotThreshold ?? 75, warm: s?.leadWarmThreshold ?? 45 };
  }

  async setThresholds(orgId: string, input: ThresholdsInput): Promise<Thresholds> {
    const data = { leadHotThreshold: input.hotThreshold, leadWarmThreshold: input.warmThreshold };
    const s = await this.prisma.organizationSetting.upsert({
      where: { orgId },
      create: { orgId, ...data },
      update: data,
      select: { leadHotThreshold: true, leadWarmThreshold: true },
    });
    return { hot: s.leadHotThreshold, warm: s.leadWarmThreshold };
  }

  /** Scores the call, and moves the lead only when this is its latest call. */
  private async apply(call: Call, extraction: Extraction, source: Qualification['source']): Promise<Qualification> {
    const orgId = call.orgId;
    const thresholds = await this.getThresholds(orgId);
    const result = scoreLead(extraction, thresholds);
    const qualification: Qualification = { source, ...result, thresholds, extraction, scoredAt: new Date().toISOString() };
    const intel =
      call.extractedIntel && typeof call.extractedIntel === 'object' && !Array.isArray(call.extractedIntel)
        ? (call.extractedIntel as Record<string, unknown>)
        : {};
    // Voicemail the detection missed, a phone menu, the assistant talking alone: nobody was reached,
    // so the call is not answered, written with the score so no step reads one without the other.
    const reachedNoOne = extraction.reached_person === false;
    await this.prisma.call.update({
      where: { id: call.id },
      data: {
        extractedIntel: { ...intel, qualification } as unknown as Prisma.InputJsonObject,
        aiSummary: extraction.summary || null,
        handoffRequested: call.handoffRequested || extraction.human_requested,
        ...(reachedNoOne && call.disposition === CallDisposition.connected ? { disposition: CallDisposition.voicemail } : {}),
      },
    });
    if (reachedNoOne) {
      await this.undoConversation(call);
      this.logger.log(`call ${call.id} reached no one (${source}) — counted as not answered, the lead left as it was`);
      return qualification;
    }
    // From any call, not just the latest: an answer newer than this call is kept.
    await this.memory.afterCall(call, extraction);

    const lead = await this.prisma.lead.findFirst({ where: { id: call.leadId, orgId }, select: { status: true, dncStatus: true } });
    if (!lead) return qualification;
    // Asked not to be contacted: honoured from any call and whatever the lead's status, like a STOP
    // text, in case the AI did not record it during the call.
    if (extraction.do_not_contact && !lead.dncStatus) {
      await this.outcomes.record({ orgId, leadId: call.leadId, callId: call.id }, { outcome: 'do_not_contact', note: 'Found in the call analysis' });
      return qualification;
    }

    const latest = await this.prisma.call.findFirst({ where: { leadId: call.leadId, orgId }, orderBy: { createdAt: 'desc' }, select: { id: true } });
    if (latest && latest.id !== call.id) return qualification;
    await this.prisma.lead.update({ where: { id: call.leadId }, data: { score: result.score, ...leadDetailsFrom(extraction) } });
    const ended = endingOutcome(extraction);
    if (SETTLED_STATUSES.includes(lead.status) || lead.dncStatus) {
      await this.prisma.lead.update({ where: { id: call.leadId }, data: { temperature: result.temperature } });
    } else if (ended) {
      // A wrong number or a clear "no" ends the outreach here instead of parking the lead for nurture.
      await this.prisma.lead.update({ where: { id: call.leadId }, data: { temperature: result.temperature } });
      await this.engine.setStatus(orgId, call.leadId, ended, leadReason(qualification), { source: 'scoring' });
    } else {
      await this.engine.qualified(orgId, call.leadId, result.temperature, leadReason(qualification), {
        callbackRequested: Boolean(extraction.callback_requested),
      });
    }
    this.logger.log(`lead ${call.leadId} scored ${result.score} → ${result.temperature} (${source})`);
    return qualification;
  }

  /**
   * What the hang-up did for a conversation, undone for a call that reached
   * no one: the lead goes back to the status it had before the call made it
   * engaged, and its first response is its first text, if any.
   */
  private async undoConversation(call: Call): Promise<void> {
    const engaged = await this.prisma.leadEvent.findFirst({
      where: { leadId: call.leadId, callId: call.id, type: 'status_changed', toStatus: LeadStatus.engaged },
      select: { fromStatus: true },
    });
    if (engaged?.fromStatus) {
      await this.state.move(call.leadId, engaged.fromStatus, {
        source: 'scoring',
        reason: 'The call reached no one (voicemail or a phone menu)',
        callId: call.id,
        channel: 'voice',
        onlyFrom: [LeadStatus.engaged],
        alsoFrom: [LeadStatus.engaged],
      });
    }
    const firstText = await this.prisma.message.findFirst({
      where: { leadId: call.leadId, channel: 'sms', direction: 'inbound' },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    await this.prisma.lead.updateMany({
      where: { id: call.leadId, firstResponseAt: { gte: call.createdAt } },
      data: { firstResponseAt: firstText?.createdAt ?? null },
    });
  }
}

/**
 * The status a call ends the outreach with, if any: a wrong number, or a "no"
 * that came without a request for a meeting or a callback (a mixed answer
 * stays with the score).
 */
export function endingOutcome(x: Extraction): LeadStatus | null {
  if (x.invalid_lead) return LeadStatus.invalid;
  if (x.not_interested && !x.appointment_requested && !x.callback_requested) return LeadStatus.not_interested;
  return null;
}

function leadReason(q: Qualification): string {
  const head = `${q.temperature.toUpperCase()} — ${q.score}${q.override ? ` (${q.override})` : ''}.`;
  return `${head} ${q.extraction.summary}`.trim().slice(0, 2000);
}
