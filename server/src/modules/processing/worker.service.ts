import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DeliveryOutcome, MappingOrigin, MappingStatus, QueueState } from '../../common/domain';
import { newId } from '../../common/ids';
import { PrismaService } from '../../prisma/prisma.service';
import { TallyAdapter } from '../ingest/adapters/tally.adapter';
import type { NormalizedAnswer } from '../ingest/adapters/types';
import { CANONICAL_FIELDS, CanonicalKey, IGNORE_TARGET } from './canonical-fields';
import { suggestMappings } from './heuristics';
import { applyTransform, isValidEmail, type Transform } from './transforms';
import { validateCanonicalValues } from './validators';

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
      // lead write succeeded and a later step (audit log, outbox) threw. This
      // check matters more now than it did under merge semantics: a retry that
      // slipped past it used to inflate submission_count on one lead, whereas
      // one lead per submission means it would manufacture a SECOND lead for a
      // prospect who only ever filled the form once, and the brokerage would
      // call them twice. The unique lead_submissions.webhook_event_id — written
      // in the same transaction as the lead itself — is the backstop that makes
      // that impossible; this check keeps the common path clean.
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

      // Last gate before the columns. Anything that fails is demoted into
      // custom_fields rather than dropped, so the answer survives even though
      // it never reaches a typed column.
      const validated = validateCanonicalValues(mapped.values);
      for (const r of validated.rejected) {
        const label = CANONICAL_FIELDS[r.field]?.label ?? r.field;
        if (r.raw) mapped.customFields[`${label} (unvalidated)`] = r.raw;
      }
      mapped.values = validated.values;
      mapped.warnings.push(...validated.warnings);

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

      // What a human should actually look at: an answer we could not store, or
      // a contact detail we could not use. Informational transform notes — an
      // open-ended budget estimated at 1.5x, say — deliberately do NOT raise
      // the flag, or it would be raised on almost every lead and mean nothing.
      const reviewReasons = [...validated.warnings];
      if (phone && !phone.startsWith('+')) {
        reviewReasons.push('Phone number could not be parsed — this lead must not be auto-dialled');
      }

      // The lead and its submission are written together — see createLead.
      const leadId = await this.createLead({
        organizationId: event.organization_id,
        leadSourceId: source.id,
        defaultConsent: source.default_consent_status,
        values: mapped.values,
        customFields: mapped.customFields,
        phone,
        email,
        reviewReasons,
        submission: {
          webhookEventId: event.id,
          providerSubmissionId: parsed.providerSubmissionId,
          providerRespondentId: parsed.providerRespondentId,
          submittedAt: parsed.submittedAt ?? new Date(),
          normalizedAnswers: parsed.answers,
          mappedValues: mapped.values,
          unmappedKeys: Object.keys(mapped.customFields),
          warnings: mapped.warnings,
        },
      });

      // Outbox. Nothing consumes these yet; they are the seam that lets WF-04
      // (instant SMS) and WF-05 (AI voice) be added later without touching this
      // transaction. There is no longer a `lead.merged` counterpart: every
      // delivery that clears identity produces a new lead, so a consumer can
      // treat `lead.created` as "someone asked to be contacted" without having
      // to ask whether this one is a returning prospect.
      await this.prisma.domain_events.create({
        data: {
          id: newId(),
          organization_id: event.organization_id,
          aggregate_type: 'lead',
          aggregate_id: leadId,
          event_type: 'lead.created',
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
          action: 'lead.created',
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

      this.logger.log(`Created lead ${leadId} from delivery ${event.id}`);
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
          // `allOptions` is EVERY choice the question offers; textValues holds
          // only the ones this respondent picked. Storing the latter builds an
          // option-text -> enum map covering whichever answer happened to
          // arrive first, and every other choice then silently maps to null.
          options: (a.allOptions?.length
            ? a.allOptions
            : a.optionIds
              ? a.textValues.map((t, i) => ({ id: a.optionIds![i], text: t }))
              : null) as never,
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

    if (existing.length > 0) {
      // Top up rather than stopping.
      //
      // "Any mappings at all => leave it alone" had two costs. A question added
      // to a live form was never auto-mapped, however obvious it was. And a
      // source pre-mapped from its schema at connect time could never recover if
      // the predicted field keys turned out wrong — it would look configured
      // while mapping nothing. Suggesting only for answers no mapping covers
      // fixes both, and cannot disturb a mapping that already exists.
      const source = await this.prisma.lead_sources.findUnique({
        where: { id: sourceId },
        select: { mapping_status: true },
      });
      // A human has signed off on this source; never second-guess them.
      if (source?.mapping_status === MappingStatus.CONFIGURED) return existing;

      const covered = new Set(existing.map((m) => m.source_field_key));
      const uncovered = answers.filter((a) => !covered.has(a.key));
      if (uncovered.length === 0) return existing;

      // A target already claimed stays claimed — first mapping wins.
      const claimed = new Set(existing.map((m) => m.target_field));
      const additions = suggestMappings(uncovered, region).filter((s) => !claimed.has(s.targetField));
      if (additions.length === 0) return existing;

      await this.prisma.lead_source_field_mappings.createMany({
        data: additions.map((s) => ({
          id: newId(),
          organization_id: orgId,
          lead_source_id: sourceId,
          source_field_key: s.sourceFieldKey,
          target_field: s.targetField,
          transform: s.transform as never,
          is_active: true,
          confidence: s.confidence,
          origin: MappingOrigin.HEURISTIC,
        })),
        skipDuplicates: true,
      });

      await this.prisma.lead_sources.update({
        where: { id: sourceId },
        data: { mapping_status: MappingStatus.NEEDS_REVIEW, mapping_version: { increment: 1 } },
      });

      this.logger.log(`Topped up ${additions.length} mapping(s) for source ${sourceId}`);
      return this.prisma.lead_source_field_mappings.findMany({
        where: { lead_source_id: sourceId, is_active: true },
      });
    }

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

  // --- lead creation --------------------------------------------------------

  /**
   * One submission, one lead. Written with its `lead_submissions` row in a
   * single transaction.
   *
   * This used to be `upsertLead`: it looked for an existing lead with the same
   * normalized phone (falling back to email) and merged the incoming answers
   * into it under a per-field policy. That is correct when the only people
   * feeding a source are the brokerage's own staff, and it is wrong here. A
   * connected form is published — on a listing page, in an ad, in a link anyone
   * can forward — so two different prospects sharing one number is ordinary:
   * a couple, a family line, an assistant filling the form in for a client.
   * Merging them silently replaced the first prospect's budget, timeline and
   * location with the second's and left a single row, so the brokerage called
   * one person and never learned the other had asked to be contacted. Losing a
   * lead is the one failure this system exists to prevent.
   *
   * Duplicates are not ignored, they are reported instead of resolved: the
   * leads API counts leads sharing a normalized phone or email and the pipeline
   * badges them "repeat contact". A human can see both rows and decide, which
   * is the one thing the merge made impossible.
   *
   * De-duplication of DELIVERIES is untouched and lives where it belongs — on
   * the provider's event id (`webhook_events.dedupe_key`) and on
   * `lead_submissions.webhook_event_id`, whose insert shares this transaction.
   * A Tally retry therefore still cannot produce a second lead: the submission
   * insert conflicts and takes the lead row down with it, and the retry after
   * that finds the original through the guard at the top of `process`.
   */
  private async createLead(input: {
    organizationId: string;
    leadSourceId: string;
    defaultConsent: string;
    values: Record<string, string | number | boolean | null>;
    customFields: Record<string, string>;
    phone: string | null;
    email: string | null;
    /** Non-empty => something needs a human's eye. See `leads.review_reasons`. */
    reviewReasons: string[];
    submission: {
      webhookEventId: string;
      providerSubmissionId: string | null;
      providerRespondentId: string | null;
      submittedAt: Date;
      normalizedAnswers: NormalizedAnswer[];
      mappedValues: Record<string, unknown>;
      unmappedKeys: string[];
      warnings: string[];
    };
  }): Promise<string> {
    const { organizationId, leadSourceId, values, customFields, phone, email, reviewReasons } = input;

    const normalizedPhone = phone && phone.startsWith('+') ? phone : null;

    // `normalized_phone` and `normalized_email` are no longer merge keys, but
    // they are still worth computing: they are what the repeat-contact lookup
    // groups on, and `email_valid` keeps a form's worth of "n/a", "none" and
    // "-" from being reported as one prospect submitting fifty times.
    const emailValid = email ? isValidEmail(email) : false;
    const normalizedEmail = emailValid ? email!.trim().toLowerCase() : null;

    const consentGranted = values.consent_status === true;
    const leadId = newId();

    await this.prisma.$transaction(async (tx) => {
      await tx.leads.create({
        data: {
          id: leadId,
          organization_id: organizationId,
          lead_source_id: leadSourceId,
          first_name: str(values.first_name),
          last_name: str(values.last_name),
          email,
          normalized_email: normalizedEmail,
          phone,
          normalized_phone: normalizedPhone,
          phone_valid: Boolean(normalizedPhone),
          email_valid: emailValid,
          needs_review: reviewReasons.length > 0,
          review_reasons: reviewReasons,
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
          // Exactly one, by construction. The column stays because the
          // submission history hangs off it and because a future import path
          // may legitimately carry more.
          submission_count: 1,
          last_submission_at: input.submission.submittedAt,
        },
      });

      // Same transaction as the lead, deliberately. Apart from being the
      // idempotency backstop described above, it means a lead can never exist
      // without the raw answers that produced it — which is what makes a
      // mapping fix retroactively repairable.
      await tx.lead_submissions.create({
        data: {
          id: newId(),
          organization_id: organizationId,
          lead_id: leadId,
          lead_source_id: leadSourceId,
          webhook_event_id: input.submission.webhookEventId,
          provider_submission_id: input.submission.providerSubmissionId,
          provider_respondent_id: input.submission.providerRespondentId,
          submitted_at: input.submission.submittedAt,
          normalized_answers: input.submission.normalizedAnswers as never,
          mapped_values: input.submission.mappedValues as never,
          unmapped_keys: input.submission.unmappedKeys,
          warnings: input.submission.warnings as never,
          // Every submission is the first for its own lead now.
          is_first_for_lead: true,
        },
      });
    });

    return leadId;
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
