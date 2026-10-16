import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConsentStatus,
  DeliveryOutcome,
  LeadStatus,
  LeadTemperature,
  MappingOrigin,
  MappingStatus,
  QueueState,
  type LeadSourceFieldMapping,
  type Prisma,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AuditService } from '@/audit/audit.service';
import { PrismaService } from '@/common/prisma/prisma.service';
import type { IntegrationEnv } from '@/common/utils/interface';
import { EventsBus } from '@/events/events.bus';
import { adapterFor } from '../adapters/generic.adapter';
import type { NormalizedAnswer } from '../adapters/types';
import { CANONICAL_FIELDS, IGNORE_TARGET } from './canonical-fields';
import { suggestMappings } from './heuristics';
import { applyTransform, isValidEmail, type Transform } from './transforms';
import { validateCanonicalValues } from './validators';

interface ClaimedEvent {
  id: string;
  organization_id: string;
  lead_source_id: string;
  provider: string;
  payload: unknown;
  attempts: number;
}

type MappedValue = string | number | boolean | null;

interface TraceEntry {
  sourceFieldKey: string;
  sourceFieldLabel: string;
  rawValue: string;
  targetField: string | null;
  transformedValue: unknown;
  outcome: 'mapped' | 'unmapped' | 'transform_error';
  warning?: string;
}

interface MappedResult {
  values: Record<string, MappedValue>;
  customFields: Record<string, string>;
  trace: TraceEntry[];
  warnings: string[];
}

const MAX_ATTEMPTS = 6;
const PHONE_UNPARSED = 'Phone number could not be parsed — this lead must not be auto-dialled';

/**
 * Turns stored deliveries into leads. Claims a batch with FOR UPDATE SKIP
 * LOCKED so several API instances can run it side by side, backs off when
 * idle, retries failures with jittered backoff and dead-letters after six.
 */
@Injectable()
export class ProcessingWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProcessingWorker.name);
  private readonly instanceId = `ingest-${randomUUID()}`;
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;
  private inFlight: Promise<void> | null = null;
  private delay: number;
  private lastRequeueAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<IntegrationEnv, true>,
    private readonly events: EventsBus,
    private readonly audit: AuditService,
  ) {
    this.delay = this.config.get('WORKER_POLL_INTERVAL_MS', { infer: true });
  }

  onModuleInit(): void {
    if (!this.config.get('WORKER_ENABLED', { infer: true })) {
      this.logger.log('Ingest worker disabled (WORKER_ENABLED=false)');
      return;
    }
    this.scheduleNext();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.inFlight) {
      await Promise.race([this.inFlight, new Promise((resolve) => setTimeout(resolve, 5000).unref())]);
    }
  }

  /** Runs a tick now instead of waiting for the next poll. */
  nudge(): void {
    if (this.config.get('WORKER_ENABLED', { infer: true })) void this.tick();
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick().finally(() => this.scheduleNext()), this.delay);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    this.inFlight = this.runTick();
    await this.inFlight;
  }

  private async runTick(): Promise<void> {
    const base = this.config.get('WORKER_POLL_INTERVAL_MS', { infer: true });
    const max = Math.max(base, this.config.get('WORKER_MAX_POLL_INTERVAL_MS', { infer: true }));
    try {
      if (Date.now() - this.lastRequeueAt >= 60_000) {
        await this.requeueStuck();
        this.lastRequeueAt = Date.now();
      }
      const batch = await this.claim();
      this.delay = batch.length > 0 ? base : Math.min(this.delay * 2, max);
      for (const event of batch) await this.process(event);
    } catch (error) {
      this.logger.error(`Ingest worker tick failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
      this.inFlight = null;
    }
  }

  private claim(): Promise<ClaimedEvent[]> {
    const batchSize = this.config.get('WORKER_BATCH_SIZE', { infer: true });
    return this.prisma.$queryRaw<ClaimedEvent[]>`
      WITH claimed AS (
        SELECT id FROM ingest_events
         WHERE queue_state = 'PENDING' AND available_at <= now()
           -- CRM webhooks are queued here too, and drained by CrmSyncService under its own lease.
           AND provider <> 'HUBSPOT'
         ORDER BY available_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT ${batchSize}
      )
      UPDATE ingest_events e
         SET queue_state = 'PROCESSING', locked_by = ${this.instanceId}, locked_at = now(), attempts = e.attempts + 1
        FROM claimed
       WHERE e.id = claimed.id
      RETURNING e.id, e.organization_id, e.lead_source_id, e.provider::text AS provider, e.payload, e.attempts`;
  }

  private async requeueStuck(): Promise<void> {
    const stuckMs = this.config.get('WORKER_STUCK_AFTER_MS', { infer: true });
    await this.prisma.$executeRaw`
      UPDATE ingest_events
         SET queue_state = 'PENDING', locked_by = NULL, locked_at = NULL
       WHERE queue_state = 'PROCESSING' AND provider <> 'HUBSPOT' AND locked_at < now() - make_interval(secs => ${stuckMs / 1000})`;
  }

  private async process(event: ClaimedEvent): Promise<void> {
    const startedAt = Date.now();
    try {
      const [source, settings] = await Promise.all([
        this.prisma.leadSource.findUnique({ where: { id: event.lead_source_id } }),
        this.prisma.organizationSetting.findUnique({ where: { orgId: event.organization_id }, select: { defaultRegion: true } }),
      ]);
      if (!source) {
        await this.finish(event, QueueState.DONE, DeliveryOutcome.ERROR, 'source_missing', startedAt);
        return;
      }
      const already = await this.prisma.ingestEvent.findUnique({ where: { id: event.id }, select: { leadId: true } });
      if (already?.leadId) {
        await this.finish(event, QueueState.DONE, DeliveryOutcome.PROCESSED, 'already_processed', startedAt);
        return;
      }

      const parsed = adapterFor(event.provider).parse(event.payload);
      const region = settings?.defaultRegion ?? 'US';
      await this.syncFieldCatalog(event.organization_id, source.id, parsed.answers);
      const mappings = await this.ensureMappings(event.organization_id, source.id, source.mappingStatus, parsed.answers, region);
      const mapped = this.applyMappings(parsed.answers, mappings, region);

      const validated = validateCanonicalValues(mapped.values);
      for (const rejected of validated.rejected) {
        const label = CANONICAL_FIELDS[rejected.field]?.label ?? rejected.field;
        if (rejected.raw) mapped.customFields[`${label} (unvalidated)`] = rejected.raw;
      }
      mapped.values = validated.values;
      mapped.warnings.push(...validated.warnings);

      const phone = typeof mapped.values.phone === 'string' ? mapped.values.phone : null;
      const email = typeof mapped.values.email === 'string' ? mapped.values.email : null;
      if (!phone && !email) {
        await this.finish(event, QueueState.DONE, DeliveryOutcome.NEEDS_IDENTITY, 'no_phone_or_email', startedAt, mapped);
        return;
      }

      const reviewReasons = [...validated.warnings];
      if (phone && !phone.startsWith('+')) reviewReasons.push(PHONE_UNPARSED);
      const leadId = await this.createLead({
        orgId: event.organization_id,
        leadSourceId: source.id,
        defaultConsent: source.defaultConsentStatus,
        values: mapped.values,
        customFields: mapped.customFields,
        phone,
        email,
        reviewReasons,
        submittedAt: parsed.submittedAt ?? new Date(),
      });

      await this.prisma.ingestEvent.update({
        where: { id: event.id },
        data: {
          leadId,
          providerRespondentId: parsed.providerRespondentId,
          normalizedAnswers: parsed.answers as unknown as Prisma.InputJsonValue,
          mappedValues: mapped.values as Prisma.InputJsonValue,
          unmappedKeys: Object.keys(mapped.customFields),
          warnings: mapped.warnings,
        },
      });
      await this.audit.record({
        orgId: event.organization_id,
        actorType: 'webhook',
        action: 'lead.created',
        entityType: 'lead',
        entityId: leadId,
        payload: { source: source.name, ingestEventId: event.id },
        durationMs: Date.now() - startedAt,
      });
      await this.prisma.leadSource.update({
        where: { id: source.id },
        data: { lastSuccessAt: new Date(), ingestStatus: 'ACTIVE' },
      });
      await this.finish(
        event,
        QueueState.DONE,
        mapped.warnings.length ? DeliveryOutcome.PROCESSED_WITH_WARNINGS : DeliveryOutcome.PROCESSED,
        null,
        startedAt,
        mapped,
      );
      this.events.publish({ organizationId: event.organization_id, type: 'lead.created', leadSourceId: source.id });
      this.logger.log(`Created lead ${leadId} from delivery ${event.id}`);
    } catch (error) {
      await this.fail(event, error, startedAt);
    }
  }

  private async syncFieldCatalog(orgId: string, leadSourceId: string, answers: NormalizedAnswer[]): Promise<void> {
    for (const a of answers) {
      const options = a.allOptions?.length
        ? a.allOptions
        : a.optionIds
          ? a.textValues.map((text, i) => ({ id: a.optionIds![i], text }))
          : undefined;
      await this.prisma.leadSourceField.upsert({
        where: { leadSourceId_fieldKey: { leadSourceId, fieldKey: a.key } },
        create: {
          orgId,
          leadSourceId,
          fieldKey: a.key,
          label: a.label,
          fieldType: a.type,
          ...(options ? { options: options as unknown as Prisma.InputJsonValue } : {}),
          sampleValues: [a.scalarText].filter(Boolean),
          status: 'ACTIVE',
        },
        update: { label: a.label, lastSeenAt: new Date(), missingStreak: 0, status: 'ACTIVE' },
      });
    }
  }

  /**
   * The first delivery maps itself from the heuristics; later ones only add
   * mappings for questions nobody has decided on yet, and never once an owner
   * has confirmed the mapping. Suggestions leave the source NEEDS_REVIEW.
   */
  private async ensureMappings(
    orgId: string,
    leadSourceId: string,
    mappingStatus: MappingStatus | null,
    answers: NormalizedAnswer[],
    region: string,
  ): Promise<LeadSourceFieldMapping[]> {
    const existing = await this.prisma.leadSourceFieldMapping.findMany({ where: { leadSourceId, isActive: true } });
    if (mappingStatus === MappingStatus.CONFIGURED && existing.length > 0) return existing;

    const covered = new Set(existing.map((m) => m.sourceFieldKey));
    const claimed = new Set(existing.map((m) => m.targetField));
    const additions = suggestMappings(
      answers.filter((a) => !covered.has(a.key)),
      region,
    ).filter((s) => !claimed.has(s.targetField));
    if (additions.length === 0) return existing;

    await this.prisma.leadSourceFieldMapping.createMany({
      data: additions.map((s) => ({
        orgId,
        leadSourceId,
        sourceFieldKey: s.sourceFieldKey,
        targetField: s.targetField,
        transform: s.transform as Prisma.InputJsonValue,
        isActive: true,
        confidence: s.confidence,
        origin: MappingOrigin.HEURISTIC,
      })),
      skipDuplicates: true,
    });
    await this.prisma.leadSource.update({
      where: { id: leadSourceId },
      data: { mappingStatus: MappingStatus.NEEDS_REVIEW, mappingVersion: { increment: 1 } },
    });
    this.logger.log(`Mapped ${additions.length} field(s) for source ${leadSourceId}`);
    return this.prisma.leadSourceFieldMapping.findMany({ where: { leadSourceId, isActive: true } });
  }

  private applyMappings(answers: NormalizedAnswer[], mappings: LeadSourceFieldMapping[], region: string): MappedResult {
    const result: MappedResult = { values: {}, customFields: {}, trace: [], warnings: [] };
    const byKey = new Map<string, LeadSourceFieldMapping[]>();
    for (const m of mappings) byKey.set(m.sourceFieldKey, [...(byKey.get(m.sourceFieldKey) ?? []), m]);

    for (const a of answers) {
      const base = { sourceFieldKey: a.key, sourceFieldLabel: a.label, rawValue: a.scalarText };
      const targets = byKey.get(a.key);
      if (!targets?.length) {
        if (a.scalarText) result.customFields[a.label] = a.scalarText;
        result.trace.push({ ...base, targetField: null, transformedValue: null, outcome: 'unmapped' });
        continue;
      }
      for (const m of targets) {
        if (m.targetField === IGNORE_TARGET) continue;
        try {
          const { value, warning } = applyTransform(m.transform as unknown as Transform, a.textValues, a.scalarText, region);
          if (value !== null && value !== '') result.values[m.targetField] = value;
          if (warning) result.warnings.push(`${a.label}: ${warning}`);
          result.trace.push({ ...base, targetField: m.targetField, transformedValue: value, outcome: 'mapped', ...(warning ? { warning } : {}) });
        } catch (error) {
          const message = (error as Error).message;
          result.warnings.push(`${a.label}: ${message}`);
          result.trace.push({ ...base, targetField: m.targetField, transformedValue: null, outcome: 'transform_error', warning: message });
        }
      }
    }
    return result;
  }

  private async createLead(input: {
    orgId: string;
    leadSourceId: string;
    defaultConsent: ConsentStatus;
    values: Record<string, MappedValue>;
    customFields: Record<string, string>;
    phone: string | null;
    email: string | null;
    reviewReasons: string[];
    submittedAt: Date;
  }): Promise<string> {
    const { values, phone, email } = input;
    const normalizedPhone = phone?.startsWith('+') ? phone : null;
    const emailValid = email ? isValidEmail(email) : false;
    const consentGranted = values.consent_status === true;
    const lead = await this.prisma.lead.create({
      data: {
        orgId: input.orgId,
        leadSourceId: input.leadSourceId,
        firstName: text(values.first_name),
        lastName: text(values.last_name),
        email,
        normalizedEmail: emailValid ? email!.trim().toLowerCase() : null,
        phone,
        normalizedPhone,
        phoneValid: Boolean(normalizedPhone),
        emailValid,
        needsReview: input.reviewReasons.length > 0,
        reviewReasons: input.reviewReasons,
        status: normalizedPhone || emailValid ? LeadStatus.new : LeadStatus.invalid,
        temperature: LeadTemperature.cold,
        score: 0,
        location: text(values.location),
        timeline: text(values.timeline),
        buyingIntent: text(values.buying_intent),
        financingStatus: text(values.financing_status),
        minBudget: num(values.min_budget),
        maxBudget: num(values.max_budget),
        bedrooms: int(values.bedrooms),
        motivation: text(values.motivation),
        consentStatus: consentGranted ? ConsentStatus.granted : input.defaultConsent,
        consentSource: consentGranted ? 'webhook_form' : null,
        consentAt: consentGranted ? new Date() : null,
        customFields: input.customFields,
        lastSubmissionAt: input.submittedAt,
      },
      select: { id: true },
    });
    return lead.id;
  }

  private async finish(
    event: ClaimedEvent,
    queueState: QueueState,
    outcome: DeliveryOutcome,
    reason: string | null,
    startedAt: number,
    mapped?: MappedResult,
  ): Promise<void> {
    await this.prisma.ingestEvent.update({
      where: { id: event.id },
      data: {
        queueState,
        outcome,
        outcomeReason: reason,
        processedAt: new Date(),
        processingMs: Date.now() - startedAt,
        lockedBy: null,
        lockedAt: null,
        ...(mapped ? { mappingTrace: mapped.trace as unknown as Prisma.InputJsonValue } : {}),
      },
    });
  }

  private async fail(event: ClaimedEvent, error: unknown, startedAt: number): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const dead = event.attempts >= MAX_ATTEMPTS;
    const delaySeconds = Math.min(2 ** event.attempts * 10, 3600) * (0.75 + Math.random() * 0.5);
    this.logger.error(`Delivery ${event.id} failed (attempt ${event.attempts}): ${message}`);
    await this.prisma.ingestEvent.update({
      where: { id: event.id },
      data: {
        queueState: dead ? QueueState.DEAD_LETTER : QueueState.PENDING,
        outcome: dead ? DeliveryOutcome.ERROR : null,
        errorMessage: message.slice(0, 1000),
        availableAt: dead ? new Date() : new Date(Date.now() + delaySeconds * 1000),
        processingMs: Date.now() - startedAt,
        lockedBy: null,
        lockedAt: null,
      },
    });
  }
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.round(n);
};
