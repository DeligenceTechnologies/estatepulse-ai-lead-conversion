import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DeliveryOutcome, QueueState } from '../../common/domain';
import { newId } from '../../common/ids';
import { PrismaService } from '../../prisma/prisma.service';
import { TallyAdapter } from '../ingest/adapters/tally.adapter';
import type { NormalizedAnswer } from '../ingest/adapters/types';
import { CANONICAL_FIELDS, CanonicalKey, IGNORE_TARGET } from './canonical-fields';
import { suggestMappings } from './heuristics';
import { applyTransform, type Transform } from './transforms';

interface ClaimedEvent {
  id: string;
  organization_id: string | null;
  lead_source_id: string | null;
  payload: unknown;
  attempts: number;
}

interface MappedResult {
  values: Record<string, string | number | boolean | null>;
  customFields: Record<string, string>;
  trace: {
    sourceFieldKey: string;
    sourceFieldLabel: string;
    rawValue: string;
    targetField: string | null;
    transformedValue: unknown;
    outcome: 'mapped' | 'unmapped' | 'transform_error';
    warning?: string;
  }[];
  warnings: string[];
}

/**
 * Turns stored webhook deliveries into Lead rows.
 *
 * Runs in-process behind WORKER_ENABLED. The queue is Postgres itself —
 * `webhook_events` rows are both the durability record and the work item, so
 * accepting a delivery and enqueueing its work are the same INSERT. With a
 * separate broker there would be an unavoidable dual write, and a failure
 * between the two would leave a lead durably stored but permanently invisible,
 * with a 202 already returned to the provider.
 */
@Injectable()
export class ProcessingWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProcessingWorker.name);
  private readonly adapter = new TallyAdapter();
  private readonly instanceId = randomUUID();
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (String(this.config.get('WORKER_ENABLED')) === 'false') {
      this.logger.log('Worker disabled (WORKER_ENABLED=false)');
      return;
    }
    const interval = Number(this.config.get('WORKER_POLL_INTERVAL_MS') ?? 1000);
    this.timer = setInterval(() => void this.tick(), interval);
    this.logger.log(`Worker started (poll ${interval}ms, instance ${this.instanceId.slice(0, 8)})`);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  /** Called by the ingest path so a delivery is usually processed in ~20ms. */
  nudge(): void {
    void this.tick();
  }

  private async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      await this.requeueStuck();
      const batch = await this.claim();
      for (const event of batch) {
        await this.process(event);
      }
    } catch (err) {
      this.logger.error(`Worker tick failed: ${String(err)}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * Claim work in a short transaction, then process OUTSIDE it.
   *
   * Holding a transaction open for the whole job would pin a Supavisor pooler
   * connection for its full duration and block vacuum. SKIP LOCKED lets any
   * number of instances poll concurrently without a coordinator.
   */
  private async claim(): Promise<ClaimedEvent[]> {
    const batchSize = Number(this.config.get('WORKER_BATCH_SIZE') ?? 10);
    return this.prisma.$queryRawUnsafe<ClaimedEvent[]>(
      `WITH claimed AS (
         SELECT id FROM webhook_events
          WHERE queue_state = 'PENDING' AND available_at <= now()
          ORDER BY available_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT $1
       )
       UPDATE webhook_events e
          SET queue_state = 'PROCESSING', locked_by = $2, locked_at = now(), attempts = e.attempts + 1
         FROM claimed
        WHERE e.id = claimed.id
       RETURNING e.id, e.organization_id, e.lead_source_id, e.payload, e.attempts`,
      batchSize,
      this.instanceId,
    );
  }

  /** A SIGKILL mid-job costs a few minutes of delay, never a lost lead. */
  private async requeueStuck(): Promise<void> {
    const ms = Number(this.config.get('WORKER_STUCK_AFTER_MS') ?? 300_000);
    await this.prisma.$executeRawUnsafe(
      `UPDATE webhook_events
          SET queue_state = 'PENDING', locked_by = NULL, locked_at = NULL
        WHERE queue_state = 'PROCESSING'
          AND locked_at < now() - ($1 || ' milliseconds')::interval`,
      String(ms),
    );
  }

  private async process(event: ClaimedEvent): Promise<void> {
    const startedAt = Date.now();
    try {
      if (!event.organization_id || !event.lead_source_id) {
        await this.finish(event, QueueState.DONE, DeliveryOutcome.ERROR, 'orphaned_event', startedAt);
        return;
      }

      const source = await this.prisma.lead_sources.findUnique({ where: { id: event.lead_source_id } });
      const org = await this.prisma.organizations.findUnique({ where: { id: event.organization_id } });
      if (!source || !org) {
        await this.finish(event, QueueState.DONE, DeliveryOutcome.ERROR, 'source_missing', startedAt);
        return;
      }

      // Idempotency guard for retries.
      //
      // A delivery can be retried after it already produced a lead — e.g. the
      // lead write succeeded and a later step (audit log, outbox) threw. Without
      // this check the retry would re-run the merge, inflating submission_count
      // and colliding on lead_submissions.webhook_event_id. The unique index on
      // that column remains the backstop; this makes the common path clean.
      const already = await this.prisma.lead_submissions.findUnique({
        where: { webhook_event_id: event.id },
        select: { lead_id: true },
      });
      if (already) {
        await this.finish(
          event,
          QueueState.DONE,
          DeliveryOutcome.PROCESSED,
          'already_processed',
          startedAt,
          undefined,
          already.lead_id ?? undefined,
        );
        return;
      }

      const parsed = this.adapter.parse(event.payload);
      const region = org.default_region ?? 'US';

      await this.syncFieldCatalog(event.organization_id, source.id, parsed.answers);
      const mappings = await this.ensureMappings(event.organization_id, source.id, parsed.answers, region);
      const mapped = this.applyMappings(parsed.answers, mappings, region);

      const phone = typeof mapped.values.phone === 'string' ? mapped.values.phone : null;
      const email = typeof mapped.values.email === 'string' ? mapped.values.email : null;

      // No usable identity: store the submission, do not invent a lead. It stays
      // replayable once the mapping is corrected.
      if (!phone && !email) {
        await this.finish(
          event,
          QueueState.DONE,
          DeliveryOutcome.NEEDS_IDENTITY,
          'no_phone_or_email',
          startedAt,
          mapped.trace,
        );
        return;
      }

      const { leadId, merged } = await this.upsertLead({
        organizationId: event.organization_id,
        leadSourceId: source.id,
        defaultConsent: source.default_consent_status,
        values: mapped.values,
        customFields: mapped.customFields,
        phone,
        email,
      });

      await this.prisma.lead_submissions.create({
        data: {
          id: newId(),
          organization_id: event.organization_id,
          lead_id: leadId,
          lead_source_id: source.id,
          webhook_event_id: event.id,
          provider_submission_id: parsed.providerSubmissionId,
          provider_respondent_id: parsed.providerRespondentId,
          submitted_at: parsed.submittedAt ?? new Date(),
          normalized_answers: parsed.answers as never,
          mapped_values: mapped.values as never,
          unmapped_keys: Object.keys(mapped.customFields),
          warnings: mapped.warnings as never,
          is_first_for_lead: !merged,
        },
      });

      // Outbox. Nothing consumes these yet; they are the seam that lets WF-04
      // (instant SMS) and WF-05 (AI voice) be added later without touching this
      // transaction. `lead.merged` is distinct so a returning lead is not
      // re-texted an intro message.
      await this.prisma.domain_events.create({
        data: {
          id: newId(),
          organization_id: event.organization_id,
          aggregate_type: 'lead',
          aggregate_id: leadId,
          event_type: merged ? 'lead.merged' : 'lead.created',
          payload: { leadId, leadSourceId: source.id, webhookEventId: event.id } as never,
        },
      });

      await this.prisma.audit_logs.create({
        data: {
          id: newId(),
          organization_id: event.organization_id,
          // Lowercase: audit_logs_actor_type_check allows only
          // user | agent | ai | system | webhook.
          actor_type: 'webhook',
          action: merged ? 'lead.merged' : 'lead.created',
          entity_type: 'lead',
          entity_id: leadId,
          payload: { source: source.name, webhookEventId: event.id } as never,
          response_time_ms: Date.now() - startedAt,
        },
      });

      await this.prisma.lead_sources.update({
        where: { id: source.id },
        data: { last_success_at: new Date(), ingest_status: 'ACTIVE' },
      });

      await this.finish(
        event,
        QueueState.DONE,
        mapped.warnings.length ? DeliveryOutcome.PROCESSED_WITH_WARNINGS : DeliveryOutcome.PROCESSED,
        null,
        startedAt,
        mapped.trace,
        leadId,
      );

      this.logger.log(`${merged ? 'Merged into' : 'Created'} lead ${leadId} from delivery ${event.id}`);
    } catch (err) {
      await this.fail(event, err, startedAt);
    }
  }

  // --- catalog + mappings ---------------------------------------------------

  private async syncFieldCatalog(orgId: string, sourceId: string, answers: NormalizedAnswer[]): Promise<void> {
    for (const a of answers) {
      await this.prisma.lead_source_fields.upsert({
        where: { lead_source_id_field_key: { lead_source_id: sourceId, field_key: a.key } },
        create: {
          id: newId(),
          organization_id: orgId,
          lead_source_id: sourceId,
          field_key: a.key,
          label: a.label,
          field_type: a.type,
          options: (a.optionIds ? a.textValues.map((t, i) => ({ id: a.optionIds![i], text: t })) : null) as never,
          sample_values: [a.scalarText].filter(Boolean) as never,
          status: 'ACTIVE',
        },
        update: { label: a.label, last_seen_at: new Date(), missing_streak: 0, status: 'ACTIVE' },
      });
    }
  }

  /**
   * Load this source's mappings, generating heuristic ones on first sight.
   *
   * Auto-applying high-confidence guesses is deliberate: a partially-mapped lead
   * a brokerage can call today beats a perfectly-mapped lead they get on
   * Thursday. Anything uncertain is left for the mapping UI.
   */
  private async ensureMappings(
    orgId: string,
    sourceId: string,
    answers: NormalizedAnswer[],
    region: string,
  ) {
    const existing = await this.prisma.lead_source_field_mappings.findMany({
      where: { lead_source_id: sourceId, is_active: true },
    });
    if (existing.length > 0) return existing;

    const suggestions = suggestMappings(answers, region);
    if (suggestions.length === 0) return [];

    await this.prisma.lead_source_field_mappings.createMany({
      data: suggestions.map((s) => ({
        id: newId(),
        organization_id: orgId,
        lead_source_id: sourceId,
        source_field_key: s.sourceFieldKey,
        target_field: s.targetField,
        transform: s.transform as never,
        is_active: true,
        confidence: s.confidence,
        origin: 'HEURISTIC',
      })),
      skipDuplicates: true,
    });

    await this.prisma.lead_sources.update({
      where: { id: sourceId },
      data: { mapping_status: 'NEEDS_REVIEW', mapping_version: { increment: 1 } },
    });

    this.logger.log(`Auto-mapped ${suggestions.length} field(s) for source ${sourceId}`);
    return this.prisma.lead_source_field_mappings.findMany({
      where: { lead_source_id: sourceId, is_active: true },
    });
  }

  /** Pure: answers + mappings -> canonical values, unmapped leftovers, trace. */
  private applyMappings(
    answers: NormalizedAnswer[],
    mappings: { source_field_key: string; target_field: string; transform: unknown }[],
    region: string,
  ): MappedResult {
    const result: MappedResult = { values: {}, customFields: {}, trace: [], warnings: [] };
    const byKey = new Map<string, typeof mappings>();
    for (const m of mappings) {
      const list = byKey.get(m.source_field_key) ?? [];
      list.push(m);
      byKey.set(m.source_field_key, list);
    }

    for (const a of answers) {
      const targets = byKey.get(a.key);

      if (!targets || targets.length === 0) {
        // Nothing a prospect told us is ever discarded.
        if (a.scalarText) result.customFields[a.label] = a.scalarText;
        result.trace.push({
          sourceFieldKey: a.key,
          sourceFieldLabel: a.label,
          rawValue: a.scalarText,
          targetField: null,
          transformedValue: null,
          outcome: 'unmapped',
        });
        continue;
      }

      for (const m of targets) {
        if (m.target_field === IGNORE_TARGET) continue;
        try {
          const { value, warning } = applyTransform(
            m.transform as Transform,
            a.textValues,
            a.scalarText,
            region,
          );
          if (value !== null && value !== '') result.values[m.target_field] = value;
          if (warning) result.warnings.push(`${a.label}: ${warning}`);
          result.trace.push({
            sourceFieldKey: a.key,
            sourceFieldLabel: a.label,
            rawValue: a.scalarText,
            targetField: m.target_field,
            transformedValue: value,
            outcome: 'mapped',
            ...(warning ? { warning } : {}),
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          result.warnings.push(`${a.label}: ${msg}`);
          result.trace.push({
            sourceFieldKey: a.key,
            sourceFieldLabel: a.label,
            rawValue: a.scalarText,
            targetField: m.target_field,
            transformedValue: null,
            outcome: 'transform_error',
            warning: msg,
          });
        }
      }
    }
    return result;
  }

  // --- identity + merge -----------------------------------------------------

  /**
   * Create or merge, serialized on identity.
   *
   * `pg_advisory_xact_lock` (NOT the session-scoped `pg_advisory_lock`, which
   * leaks across Supavisor's transaction pooling) closes the gap a unique index
   * cannot: you cannot row-lock a row that does not exist yet, so two concurrent
   * first-submissions would otherwise both insert. The partial unique index on
   * (organization_id, normalized_phone) remains the unbypassable backstop.
   */
  private async upsertLead(input: {
    organizationId: string;
    leadSourceId: string;
    defaultConsent: string;
    values: Record<string, string | number | boolean | null>;
    customFields: Record<string, string>;
    phone: string | null;
    email: string | null;
  }): Promise<{ leadId: string; merged: boolean }> {
    const { organizationId, leadSourceId, values, customFields, phone, email } = input;

    const normalizedPhone = phone && phone.startsWith('+') ? phone : null;
    const normalizedEmail = email ? email.trim().toLowerCase() : null;
    const identity = normalizedPhone ?? normalizedEmail ?? '';

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        `${organizationId}|${identity}`,
      );

      // Phone is the sole primary identity: it is the channel we dial and the
      // TCPA-relevant identifier. Email is only a fallback — households share
      // email addresses far more often than mobile numbers.
      let existing = normalizedPhone
        ? await tx.leads.findFirst({
            where: { organization_id: organizationId, normalized_phone: normalizedPhone },
          })
        : null;

      if (!existing && normalizedEmail) {
        existing = await tx.leads.findFirst({
          where: { organization_id: organizationId, normalized_email: normalizedEmail },
        });
      }

      const consentGranted = values.consent_status === true;

      if (!existing) {
        const id = newId();
        await tx.leads.create({
          data: {
            id,
            organization_id: organizationId,
            lead_source_id: leadSourceId,
            first_name: str(values.first_name),
            last_name: str(values.last_name),
            email,
            normalized_email: normalizedEmail,
            phone,
            normalized_phone: normalizedPhone,
            phone_valid: Boolean(normalizedPhone),
            // Always starts at 'new'. Downstream stages move it forward.
            status: 'new',
            temperature: 'cold',
            score: 0,
            location: str(values.location),
            timeline: str(values.timeline),
            buying_intent: str(values.buying_intent),
            financing_status: str(values.financing_status),
            min_budget: num(values.min_budget),
            max_budget: num(values.max_budget),
            bedrooms: int(values.bedrooms),
            motivation: str(values.motivation),
            // Defaults to the source's configured basis, NOT to 'granted'. The
            // demo's createLead() hardcodes granted for every lead, which would
            // assert consent we never obtained.
            consent_status: consentGranted ? 'granted' : input.defaultConsent,
            consent_source: consentGranted ? 'webhook_form' : null,
            consent_at: consentGranted ? new Date() : null,
            custom_fields: customFields as never,
            submission_count: 1,
            last_submission_at: new Date(),
          },
        });
        return { leadId: id, merged: false };
      }

      // --- merge ---
      const data: Record<string, unknown> = {
        submission_count: { increment: 1 },
        last_submission_at: new Date(),
        custom_fields: { ...(existing.custom_fields as object), ...customFields } as never,
      };

      // fill_if_empty: a non-empty existing value is never clobbered.
      for (const [key, col] of [
        ['first_name', 'first_name'],
        ['last_name', 'last_name'],
        ['email', 'email'],
        ['phone', 'phone'],
      ] as const) {
        const incoming = values[key];
        if (incoming && !(existing as Record<string, unknown>)[col]) data[col] = incoming;
      }
      if (!existing.normalized_phone && normalizedPhone) {
        data.normalized_phone = normalizedPhone;
        data.phone_valid = true;
      }
      if (!existing.normalized_email && normalizedEmail) data.normalized_email = normalizedEmail;

      // latest_wins: intent fields legitimately change, and stale values here
      // directly corrupt scoring.
      for (const key of ['location', 'timeline', 'buying_intent', 'financing_status', 'motivation'] as const) {
        if (values[key]) data[key] = values[key];
      }
      if (values.min_budget != null) data.min_budget = num(values.min_budget);
      if (values.max_budget != null) data.max_budget = num(values.max_budget);
      if (values.bedrooms != null) data.bedrooms = int(values.bedrooms);

      // Compliance is guarded, never a plain overwrite. `revoked` is terminal
      // from this path: a public web form is attacker-controlled input, so
      // letting it flip revoked -> granted would let anyone who knows a phone
      // number re-subscribe someone who opted out.
      if (consentGranted && existing.consent_status !== 'revoked') {
        data.consent_status = 'granted';
        data.consent_source = 'webhook_form';
        data.consent_at = new Date();
      }

      // Status never regresses. A dormant lead re-submitting is a high-value
      // signal, so closed/lost/nurture reopen; anything mid-conversation is left
      // alone rather than restarting outreach.
      if (['closed', 'lost', 'nurture'].includes(existing.status)) data.status = 'new';

      await tx.leads.update({ where: { id: existing.id }, data: data as never });
      return { leadId: existing.id, merged: true };
    });
  }

  // --- bookkeeping ----------------------------------------------------------

  private async finish(
    event: ClaimedEvent,
    queueState: string,
    outcome: string,
    reason: string | null,
    startedAt: number,
    trace?: unknown,
    leadId?: string,
  ): Promise<void> {
    await this.prisma.webhook_events.update({
      where: { id: event.id },
      data: {
        queue_state: queueState,
        outcome,
        outcome_reason: reason,
        processing_status: outcome === DeliveryOutcome.PROCESSED ? 'processed' : 'failed',
        processed_at: new Date(),
        processing_ms: Date.now() - startedAt,
        locked_by: null,
        locked_at: null,
        ...(trace ? { mapping_trace: trace as never } : {}),
        ...(leadId ? { lead_id: leadId } : {}),
      },
    });
  }

  private async fail(event: ClaimedEvent, err: unknown, startedAt: number): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    const maxAttempts = 6;
    const dead = event.attempts >= maxAttempts;

    // Exponential backoff with jitter: a provider-wide outage otherwise produces
    // a synchronized retry stampede when it recovers.
    const delaySec = Math.min(2 ** event.attempts * 10, 3600) * (0.75 + Math.random() * 0.5);

    this.logger.error(`Delivery ${event.id} failed (attempt ${event.attempts}): ${message}`);

    await this.prisma.webhook_events.update({
      where: { id: event.id },
      data: {
        queue_state: dead ? QueueState.DEAD_LETTER : QueueState.PENDING,
        outcome: dead ? DeliveryOutcome.ERROR : null,
        error_message: message.slice(0, 1000),
        processing_status: dead ? 'failed' : 'received',
        available_at: dead ? new Date() : new Date(Date.now() + delaySec * 1000),
        processing_ms: Date.now() - startedAt,
        locked_by: null,
        locked_at: null,
      },
    });
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function int(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.round(n);
}

export { CANONICAL_FIELDS, type CanonicalKey };
