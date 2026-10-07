import { Inject, Injectable, Logger } from '@nestjs/common';
import { LeadStatus, OUTCOME_STATUSES } from '../common/domain';
import { AppError } from '../common/errors';
import { PrismaService, TENANT_PRISMA, type GuardedPrisma } from '../prisma/prisma.service';
import { CredStoreService } from './cred-store.service';
import { EngineService } from './engine.service';
import { LeadInsightsService } from './lead-insights.service';
import {
  leadDetailsFrom,
  parseExtraction,
  scoreLead,
  type Extraction,
  type ScoreReason,
  type Temperature,
  type Thresholds,
  type ThresholdsInput,
} from './lead-scoring';
import { verifyTelnyxSignature } from './telnyx-signature';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Stored on voice_calls.extracted_intel.qualification and returned to the UI. */
export interface Qualification {
  source: 'telnyx_insights' | 'transcript';
  score: number;
  temperature: Temperature;
  reasons: ScoreReason[];
  override: string | null;
  thresholds: Thresholds;
  extraction: Extraction;
  scoredAt: string;
}

/**
 * How long after a transcript lands to wait for Telnyx's Insight before scoring
 * from the transcript instead. The Insight is the better source (the whole
 * conversation, not a possibly truncated transcript), so it gets first go.
 */
export const TRANSCRIPT_FALLBACK_MS = 90_000;

/**
 * A lead in one of these has an outcome a call score must never walk back —
 * an appointment, an opt-out, an invalid number, a closed deal (legacy
 * spellings included). Every outcome except `qualified`, which a later call
 * may legitimately re-score.
 */
const SETTLED_STATUSES = OUTCOME_STATUSES.filter((s) => s !== LeadStatus.QUALIFIED);

export interface SignedDelivery {
  signature: string | undefined;
  timestamp: string | undefined;
  rawBody: Buffer | undefined;
}

/**
 * Turns what Telnyx extracted from a call into a score, a temperature and the
 * hand-off that follows. The arithmetic is lead-scoring.ts; the hand-off is
 * EngineService.qualified(), the same one the in-call tool has always used —
 * hot waits for an agent, warm and cold go to nurture.
 */
@Injectable()
export class LeadScoringService {
  private readonly logger = new Logger(LeadScoringService.name);
  /** Calls with a transcript fallback already scheduled — one per call, however many transcript events arrive. */
  private readonly pendingFallback = new Set<string>();

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma,
    // Unguarded for one lookup only: the webhook carries a call_control_id and
    // nothing else, so finding the call IS how the tenant is discovered.
    private readonly unscoped: PrismaService,
    private readonly creds: CredStoreService,
    private readonly insights: LeadInsightsService,
    private readonly engine: EngineService,
  ) {}

  /** `call.conversation_insights.generated` from the Call Control webhook. */
  async onInsightsGenerated(ccid: string, payload: any, delivery: SignedDelivery): Promise<void> {
    const call = await this.unscoped.voice_calls.findFirst({
      where: { provider_call_id: ccid },
      orderBy: { created_at: 'desc' },
    });
    if (!call) return;

    // This event changes who an agent calls next, so it is verified whenever
    // the office has saved its Telnyx public key. Without one there is nothing
    // to verify against; the call_control_id is the only proof, as it is for
    // every other voice event today.
    const c = await this.creds.getCreds(call.organization_id).catch(() => null);
    if (c?.publicKey) {
      if (!verifyTelnyxSignature({ publicKey: c.publicKey, ...delivery })) {
        this.logger.warn(`insights for call ${call.id}: bad Telnyx signature — ignored`);
        return;
      }
    } else {
      this.logger.warn(`insights for call ${call.id}: no Telnyx public key saved, signature not verified`);
    }

    const results: any[] = Array.isArray(payload?.results) ? payload.results : [];
    const extraction = results.map((r) => parseExtraction(r?.result)).find((x) => x != null);
    if (!extraction) {
      this.logger.log(`insights for call ${call.id}: no lead qualification result among ${results.length}`);
      return;
    }
    await this.apply(call, extraction, 'telnyx_insights');
  }

  /**
   * `call.recording.transcription.saved` — the safety net that makes scoring
   * automatic even when the Insight result never arrives (Insight not set up
   * yet, Telnyx not delivering it, a webhook lost). Waits for the Insight first;
   * if the call is still unscored after that, scores it from the transcript —
   * exactly what the owner's "Classify from transcript" button does.
   *
   * In-process timer: a restart in that window loses it, and the button remains
   * for that case. Never throws into the webhook.
   */
  async onTranscriptSaved(ccid: string, delayMs = TRANSCRIPT_FALLBACK_MS): Promise<void> {
    const call = await this.unscoped.voice_calls.findFirst({
      where: { provider_call_id: ccid },
      orderBy: { created_at: 'desc' },
      select: { id: true, organization_id: true },
    });
    if (!call || this.pendingFallback.has(call.id)) return;
    this.pendingFallback.add(call.id);

    const timer = setTimeout(() => {
      void this.scoreIfUnscored(call.organization_id, call.id)
        .catch((e) => this.logger.warn(`transcript scoring for call ${call.id}: ${(e as Error).message}`))
        .finally(() => this.pendingFallback.delete(call.id));
    }, delayMs);
    timer.unref?.();
  }

  /** Score from the transcript only if nothing has scored this call yet. */
  async scoreIfUnscored(orgId: string, callId: string): Promise<Qualification | null> {
    const call = await this.prisma.voice_calls.findFirst({ where: { id: callId, organization_id: orgId } });
    if (!call?.transcript?.trim()) return null;
    const intel = (call.extracted_intel ?? {}) as Record<string, unknown>;
    if (intel.qualification) return null;
    this.logger.log(`call ${callId}: no Insight result, scoring from the transcript`);
    return this.classifyCall(orgId, callId);
  }

  /** Score a call from its stored transcript — the automatic fallback when no Insight result arrived. */
  async classifyCall(orgId: string, callId: string): Promise<Qualification> {
    const call = await this.prisma.voice_calls.findFirst({ where: { id: callId, organization_id: orgId } });
    if (!call) throw new AppError('NOT_FOUND', 'No such call');
    if (!call.transcript?.trim()) throw new AppError('CONFLICT', 'This call has no transcript to classify yet');

    const extraction = await this.insights.extractFromTranscript(orgId, call.transcript);
    return this.apply(call, extraction, 'transcript');
  }

  async getThresholds(orgId: string): Promise<Thresholds> {
    const org = await this.prisma.organizations.findUnique({
      where: { id: orgId },
      select: { lead_hot_threshold: true, lead_warm_threshold: true },
    });
    if (!org) throw new AppError('NOT_FOUND', 'Organization not found');
    return { hot: org.lead_hot_threshold, warm: org.lead_warm_threshold };
  }

  async setThresholds(orgId: string, input: ThresholdsInput): Promise<Thresholds> {
    const org = await this.prisma.organizations.update({
      where: { id: orgId },
      data: { lead_hot_threshold: input.hotThreshold, lead_warm_threshold: input.warmThreshold, updated_at: new Date() },
      select: { lead_hot_threshold: true, lead_warm_threshold: true },
    });
    return { hot: org.lead_hot_threshold, warm: org.lead_warm_threshold };
  }

  private async apply(
    call: { id: string; organization_id: string; lead_id: string; extracted_intel: unknown; handoff_requested: boolean },
    extraction: Extraction,
    source: Qualification['source'],
  ): Promise<Qualification> {
    const orgId = call.organization_id;
    const thresholds = await this.getThresholds(orgId);
    const result = scoreLead(extraction, thresholds);
    const qualification: Qualification = {
      source,
      ...result,
      thresholds,
      extraction,
      scoredAt: new Date().toISOString(),
    };

    const intel =
      call.extracted_intel && typeof call.extracted_intel === 'object' && !Array.isArray(call.extracted_intel)
        ? (call.extracted_intel as Record<string, unknown>)
        : {};
    await this.prisma.voice_calls.update({
      where: { id: call.id },
      data: {
        extracted_intel: { ...intel, qualification } as object,
        ai_summary: extraction.summary || null,
        handoff_requested: call.handoff_requested || extraction.human_requested,
        updated_at: new Date(),
      },
    });

    // The lead follows its most recent call only. An older call's result
    // arriving late must not overwrite what a newer conversation established.
    const latest = await this.prisma.voice_calls.findFirst({
      where: { lead_id: call.lead_id, organization_id: orgId },
      orderBy: { created_at: 'desc' },
      select: { id: true },
    });
    if (latest && latest.id !== call.id) {
      this.logger.log(`call ${call.id} scored ${result.score} (${result.temperature}); lead follows a newer call`);
      return qualification;
    }

    const lead = await this.prisma.leads.findFirst({
      where: { id: call.lead_id, organization_id: orgId },
      select: { status: true, dnc_status: true },
    });
    if (!lead) return qualification;

    // The score, and whatever details the caller gave (budget, location,
    // timeline, bedrooms, financing, motivation). Only details actually said
    // are written, so a call that skipped the budget keeps the one on file.
    await this.prisma.leads.update({
      where: { id: call.lead_id },
      data: { score: result.score, ...leadDetailsFrom(extraction), updated_at: new Date() },
    });
    if (SETTLED_STATUSES.includes(lead.status) || lead.dnc_status) {
      // Record what the call showed, but do not reopen a settled or do-not-contact lead.
      await this.prisma.leads.update({ where: { id: call.lead_id }, data: { temperature: result.temperature } });
    } else {
      await this.engine.qualified(orgId, call.lead_id, result.temperature, leadReason(qualification));
    }

    this.logger.log(`lead ${call.lead_id} scored ${result.score} → ${result.temperature} (${source})`);
    return qualification;
  }
}

/** The one line shown as the lead's reason: "HOT — 55. <summary>". */
function leadReason(q: Qualification): string {
  const head = `${q.temperature.toUpperCase()} — ${q.score}${q.override ? ` (${q.override})` : ''}.`;
  return `${head} ${q.extraction.summary}`.trim().slice(0, 2000);
}
