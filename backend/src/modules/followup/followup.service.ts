import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AppError } from '../../common/errors';
import { nextAllowedAt, type QuietHours } from '../../common/quiet-hours';
import { TENANT_PRISMA, type GuardedPrisma } from '../../prisma/prisma.service';
import { StrategyStoreService } from '../../telnyx/strategy-store.service';
import type {
  CreateSequenceInput,
  EnrollInput,
  LeadFilterInput,
  ReplaceStepsInput,
  UpdateSequenceInput,
} from './schemas';

/**
 * How each condition is named to a person. Used in conflict messages, so the
 * office reads "Cold reactivation already claims 'Nobody answered'" rather than
 * a constraint value it has never seen.
 */
export const TRIGGER_LABELS: Record<string, string> = {
  qualified_hot: 'Qualified as hot',
  qualified_warm: 'Qualified as warm',
  qualified_cold: 'Qualified as cold',
  call_failed: 'Every call failed to connect',
  no_answer: 'Nobody ever answered',
  answered_not_qualified: 'Answered, but never qualified',
  no_reply: 'Never replied to anything',
  strategy_completed: 'Finished the strategy without qualifying',
};

/** One lead that could not be added, and why — so a bulk add can explain itself. */
export interface EnrollSkip {
  leadId: string;
  leadName: string;
  reason: 'dnc' | 'already_enrolled' | 'not_found' | 'in_strategy';
}

export interface EnrollResult {
  matched: number;
  enrolled: number;
  skipped: EnrollSkip[];
  dryRun: boolean;
}

/** Enrolling more than this in one call is a mistake, not a campaign. */
const MAX_ENROLL_PER_CALL = 500;

/**
 * Statuses a lead still holds while the strategy engine is working it. It
 * leaves them the moment the strategy ends, by either route — exitStrategy()
 * moves new|contacted to 'nurture', and qualified() sets 'qualified' or
 * 'nurture'.
 */
const IN_STRATEGY_STATUSES = ['new', 'contacted'];

/**
 * Is the strategy engine still working this lead?
 *
 * Read from the two durable columns rather than from EngineService's in-memory
 * map: that map is per-process and empty after a restart, so a lead mid-strategy
 * would look idle to it and could be enrolled anyway. `first_contact_at` is the
 * engine's atomic claim — it is set by the one caller that wins the race — and
 * the status is how the lead leaves again.
 *
 * Both conditions are needed. `first_contact_at` alone stays set forever, so it
 * would bar a lead from nurture for the rest of its life; the status alone is
 * 'new' for a lead the engine has not reached yet, which is not in the strategy
 * and is a perfectly reasonable thing to enrol by hand.
 */
function isInStrategy(lead: {
  status: string;
  first_contact_at: Date | null;
  automation_paused: boolean;
}): boolean {
  // A paused lead is NOT in the strategy: fireStep re-reads this flag and stops
  // the moment it is set, which is what an inbound reply does. Such a lead sits
  // at 'contacted' with first_contact_at set forever, so without this clause the
  // guard would bar the exact leads a person has stepped in to handle by hand.
  if (lead.automation_paused) return false;
  return lead.first_contact_at !== null && IN_STRATEGY_STATUSES.includes(lead.status);
}

/**
 * Sequences and enrolment. The runner that fires the steps is
 * followup.runner.ts; this is everything around it.
 *
 * Nothing is seeded. An office starts with no sequences and authors its own,
 * so `sequenceForTemperature` returning undefined is an ordinary answer rather
 * than missing data — it means nobody has pointed a sequence at that
 * temperature yet, and nothing auto-enrols.
 *
 * The line between this and the strategy engine is the one doc 05 §0 drew and
 * is worth restating, because the two look similar and must not merge:
 * **strategies are engagement** — triggered by a lead arriving, cadence in
 * seconds to hours, over the moment the AI call returns a temperature.
 * **Sequences are nurture** — triggered by that temperature, cadence in days to
 * weeks, over when the lead books, converts, or runs out of steps. One hands to
 * the other and neither does the other's job.
 */
@Injectable()
export class FollowupService {
  private readonly logger = new Logger(FollowupService.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma,
    private readonly strategies: StrategyStoreService,
  ) {}

  /**
   * The org's quiet-hours window, read from the same guardrails the strategy
   * engine obeys. One setting, two schedulers — an office that sets its quiet
   * hours once should not discover that nurture ignores them.
   */
  async guardrailsFor(orgId: string): Promise<{ tz: string; quiet?: QuietHours }> {
    const [org, strategy] = await Promise.all([
      this.prisma.organizations.findUnique({
        where: { id: orgId },
        select: { timezone: true },
      }),
      this.strategies.getStrategy(orgId).catch(() => null),
    ]);
    const g = (strategy?.guardrails ?? {}) as Record<string, unknown>;
    const quiet = g.respectQuietHours === false ? undefined : (g.quietHours as QuietHours | undefined);
    return { tz: org?.timezone ?? 'America/Chicago', quiet };
  }

  /**
   * Which sequence a qualification of this temperature enrols into.
   *
   * Temperature is no longer special: it is three of the eight conditions a
   * sequence can claim. This wrapper exists so the engine's call site reads the
   * way it always did, and so the mapping from a temperature to its condition
   * name lives in exactly one place.
   */
  async sequenceForTemperature(orgId: string, temperature: string): Promise<string | undefined> {
    return this.sequenceForTrigger(orgId, `qualified_${temperature}`);
  }

  /**
   * Which sequence, if any, currently claims this condition.
   *
   * `sequence_enroll_triggers_one_per_active_trigger` guarantees at most one row
   * in force, so there is no tie to break. Nothing claiming it is an ordinary
   * answer meaning the office has not configured that path.
   */
  async sequenceForTrigger(orgId: string, trigger: string): Promise<string | undefined> {
    const row = await this.prisma.sequence_enroll_triggers.findFirst({
      // `active` is what makes this a claim rather than a remembered tick box:
      // an inactive sequence keeps its rows and must not receive leads.
      where: { organization_id: orgId, trigger, active: true },
      select: { followup_sequences: { select: { code: true, status: true } } },
    });
    // Belt and braces against the denormalisation drifting: `active` is meant
    // to mirror the sequence's status, and enrolling into a sequence that is
    // switched off would be worse than not enrolling at all.
    const seq = row?.followup_sequences;
    return seq && seq.status === 'active' ? seq.code : undefined;
  }

  /**
   * The first claimed condition that matches, most specific first.
   *
   * Order matters because several are true at once for the same lead: someone
   * who never picked up also never replied, and every lead reaching the end of
   * the strategy satisfies `strategy_completed`. Checking in order of how much
   * each one tells you means the office's most specific configured answer wins,
   * and `strategy_completed` behaves as the catch-all it reads as.
   */
  static readonly TRIGGER_PRIORITY = [
    'call_failed',
    'no_answer',
    'answered_not_qualified',
    'no_reply',
    'strategy_completed',
  ] as const;

  /**
   * Enrol a lead, scheduling step 1.
   *
   * Returns false when the lead is already enrolled, is on the do-not-contact
   * list, is still being worked by the strategy, or the sequence has no steps —
   * none of which is an error worth throwing at a webhook.
   *
   * Concurrency is handled by the database, not by a check: two callers can
   * reach this at once (a qualification webhook and its own retry), and the
   * partial unique index on `lead_id WHERE status = 'active'` means the second
   * INSERT fails rather than producing a lead that gets every message twice.
   * The same trick as `leads.first_contact_at` in the strategy engine.
   */
  async enroll(orgId: string, leadId: string, code: string): Promise<boolean> {
    const lead = await this.prisma.leads.findUnique({
      where: { id: leadId },
      select: {
        id: true,
        dnc_status: true,
        organization_id: true,
        status: true,
        first_contact_at: true,
        automation_paused: true,
      },
    });
    if (!lead || lead.organization_id !== orgId) return false;
    if (lead.dnc_status) {
      this.logger.log(`refused to enrol lead ${leadId}: do-not-contact`);
      return false;
    }
    if (isInStrategy(lead)) {
      // Strategies are engagement and sequences are nurture; a lead in both at
      // once gets two independent schedulers texting it, neither aware of the
      // other. Quiet hours would still be obeyed by each and the lead would
      // still be double-texted.
      this.logger.log(`refused to enrol lead ${leadId}: still in the strategy`);
      return false;
    }

    const sequence = await this.prisma.followup_sequences.findFirst({
      where: { organization_id: orgId, code, status: 'active' },
      include: { sequence_steps: { orderBy: { step_order: 'asc' }, take: 1 } },
    });
    const first = sequence?.sequence_steps[0];
    if (!sequence || !first) return false;

    const { tz, quiet } = await this.guardrailsFor(orgId);
    const due = nextAllowedAt(tz, quiet, new Date(Date.now() + first.delay_minutes * 60_000));

    try {
      await this.prisma.sequence_enrollments.create({
        data: {
          organization_id: orgId,
          lead_id: leadId,
          sequence_id: sequence.id,
          current_step: first.step_order,
          status: 'active',
          next_action_at: due,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        this.logger.log(`lead ${leadId} already has a live enrolment — left alone`);
        return false;
      }
      throw e;
    }

    this.logger.log(`enrolled lead ${leadId} into ${code}, first step due ${due.toISOString()}`);
    return true;
  }

  /**
   * End every live enrolment for a lead.
   *
   * `next_action_at` is nulled as well as the status changed, so a stopped
   * enrolment can never be claimed by the runner even if its status is later
   * hand-edited. One UPDATE cancels a lead's entire future — which is the whole
   * argument for keeping this in a table rather than in timers.
   */
  async stopForLead(orgId: string, leadId: string, reason: string): Promise<number> {
    const { count } = await this.prisma.sequence_enrollments.updateMany({
      where: { organization_id: orgId, lead_id: leadId, status: { in: ['active', 'paused'] } },
      data: {
        status: 'stopped',
        stopped_at: new Date(),
        stopped_reason: reason.slice(0, 100),
        next_action_at: null,
      },
    });
    if (count) this.logger.log(`stopped ${count} enrolment(s) for lead ${leadId}: ${reason}`);
    return count;
  }

  // ---------------------------------------------------------------- authoring

  /** Owned-by-this-org lookup, so an id from the client can never cross tenants. */
  private async ownedSequence(orgId: string, id: string) {
    const row = await this.prisma.followup_sequences.findFirst({
      where: { id, organization_id: orgId },
    });
    if (!row) throw new AppError('NOT_FOUND', 'No such sequence');
    return row;
  }

  /**
   * Turn the editor's step array into rows. Order is the array index — never a
   * client-supplied number, which would let a duplicate through to
   * `sequence_steps_order_unique` and surface as a 500 naming an index.
   */
  private stepRows(orgId: string, steps: ReplaceStepsInput['steps']) {
    return steps.map((st, i) => ({
      organization_id: orgId,
      step_order: i + 1,
      action_type: st.actionType,
      delay_minutes: st.delayMinutes,
      message_template: st.actionType === 'sms' ? (st.messageTemplate ?? null) : null,
      voice_prompt: st.actionType === 'voice' ? (st.voicePrompt ?? null) : null,
      max_attempts: st.maxAttempts,
    }));
  }

  /**
   * Refuse up front if another active sequence already claims this
   * temperature, naming the one that does.
   *
   * `followup_sequences_one_per_temperature` enforces this regardless, but it
   * is a PARTIAL unique index, which Prisma cannot model — so its P2002 comes
   * back with a `target` that does not identify it, and the error is
   * indistinguishable from a duplicate code. Checking first is what lets the
   * message say which sequence is in the way, which is the only version of
   * this error anybody can act on.
   *
   * The index stays as the backstop for the race between this read and the
   * write; rethrowSequenceConflict turns that rarer case into a truthful, if
   * vaguer, message.
   */
  private async assertTriggersFree(
    orgId: string,
    triggers: string[] | undefined,
    exceptId?: string,
  ): Promise<void> {
    if (!triggers?.length) return;
    const holder = await this.prisma.sequence_enroll_triggers.findFirst({
      where: {
        organization_id: orgId,
        trigger: { in: triggers },
        // Only a claim in force blocks another sequence. An inactive sequence
        // keeps its tick boxes and reserves nothing.
        active: true,
        ...(exceptId ? { NOT: { sequence_id: exceptId } } : {}),
      },
      select: { trigger: true, followup_sequences: { select: { name: true } } },
    });
    if (holder) {
      throw new AppError(
        'CONFLICT',
        `"${holder.followup_sequences.name}" already claims "${TRIGGER_LABELS[holder.trigger] ?? holder.trigger}". Clear it there first.`,
      );
    }
  }

  /**
   * Rewrite a sequence's claims to exactly `triggers`, in force only when the
   * sequence is active.
   *
   * Replace rather than diff, for the same reason replaceSteps does: the editor
   * sends the complete set of ticked boxes, so working out which individual
   * boxes changed would be reconstructing something the caller already knows.
   *
   * A box the office has UNticked is deleted; a box it kept is upserted with
   * the right `active`. The distinction matters — deleting everything and
   * reinserting would churn created_at and lose the record of when a condition
   * was first claimed.
   */
  private async writeTriggers(
    // Typed by the one delegate it touches rather than as
    // Prisma.TransactionClient: the tenancy-guarded client is an EXTENDED
    // client, and the callback it hands out is structurally incompatible with
    // the stock transaction type.
    tx: Pick<GuardedPrisma, 'sequence_enroll_triggers'>,
    orgId: string,
    sequenceId: string,
    triggers: string[],
    active: boolean,
  ): Promise<void> {
    await tx.sequence_enroll_triggers.deleteMany({
      where: {
        organization_id: orgId,
        sequence_id: sequenceId,
        ...(triggers.length ? { NOT: { trigger: { in: triggers } } } : {}),
      },
    });

    for (const trigger of triggers) {
      await tx.sequence_enroll_triggers.upsert({
        where: { sequence_id_trigger: { sequence_id: sequenceId, trigger } },
        create: { organization_id: orgId, sequence_id: sequenceId, trigger, active },
        update: { active },
      });
    }
  }

  /**
   * Two different unique indexes reach here and mean different things, but a
   * partial index's P2002 does not name itself (see assertTemperatureFree), so
   * this cannot reliably tell them apart. The common case is a duplicate code;
   * the temperature clash is caught before the write, so it only lands here on
   * a genuine race.
   */
  private rethrowSequenceConflict(e: unknown): never {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const target = String(e.meta?.['target'] ?? '');
      if (target.includes('temperature') || target.includes('one_per_temperature')) {
        throw new AppError(
          'CONFLICT',
          'Another active sequence already auto-enrols that temperature. Clear it there first.',
        );
      }
      throw new AppError(
        'CONFLICT',
        'That conflicts with an existing sequence — check the code and the auto-enrol temperature.',
      );
    }
    throw e;
  }

  /**
   * `followup_sequences_code_unique` IS modelled, so its P2002 would identify
   * itself — but checking first keeps both conflict messages specific and
   * means the generic fallback only ever fires on a real race.
   */
  private async assertCodeFree(orgId: string, code: string): Promise<void> {
    const existing = await this.prisma.followup_sequences.findFirst({
      where: { organization_id: orgId, code },
      select: { name: true, status: true },
    });
    if (existing) {
      throw new AppError(
        'CONFLICT',
        existing.status === 'archived'
          ? `The archived sequence "${existing.name}" already uses that code. Pick another.`
          : `"${existing.name}" already uses that code.`,
      );
    }
  }

  async createSequence(orgId: string, input: CreateSequenceInput) {
    await this.assertCodeFree(orgId, input.code);
    await this.assertTriggersFree(orgId, input.enrollTriggers);
    let createdId: string;
    try {
      // One transaction: a sequence that exists without the conditions it was
      // saved with is a sequence that silently enrols nobody, and the office
      // has no way to tell from looking at it.
      createdId = await this.prisma.$transaction(async (tx) => {
        const created = await tx.followup_sequences.create({
          data: {
            organization_id: orgId,
            code: input.code,
            name: input.name,
            description: input.description ?? null,
            status: input.status,
            sequence_steps: { create: this.stepRows(orgId, input.steps) },
          },
          select: { id: true },
        });
        await this.writeTriggers(
          tx,
          orgId,
          created.id,
          input.enrollTriggers,
          input.status === 'active',
        );
        return created.id;
      });
    } catch (e) {
      this.rethrowSequenceConflict(e);
    }
    this.logger.log(`created sequence ${input.code} for org ${orgId}`);
    return this.getSequence(orgId, createdId);
  }

  async updateSequence(orgId: string, id: string, input: UpdateSequenceInput) {
    const current = await this.ownedSequence(orgId, id);
    // Excluding this sequence: re-saving one that already claims 'no_answer'
    // must not collide with itself.
    await this.assertTriggersFree(orgId, input.enrollTriggers, id);

    // Deactivating releases every claim, so another sequence can take the
    // condition over — the same reason the old partial unique index was scoped
    // to active rows. Reactivating has to put them back, which is why the
    // claims are rewritten whenever EITHER the tick boxes or the status move.
    const nextStatus = input.status ?? current.status;
    const statusChanged = input.status !== undefined && input.status !== current.status;

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.followup_sequences.update({
          where: { id },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            updated_at: new Date(),
          },
        });

        if (input.enrollTriggers !== undefined || statusChanged) {
          // When only the status moved, the sequence keeps whatever it ticked —
          // the rows survive deactivation precisely so this read returns them,
          // and reactivating restores the configuration rather than clearing it.
          const triggers =
            input.enrollTriggers ??
            (
              await tx.sequence_enroll_triggers.findMany({
                where: { organization_id: orgId, sequence_id: id },
                select: { trigger: true },
              })
            ).map((t) => t.trigger);

          await this.writeTriggers(tx, orgId, id, triggers, nextStatus === 'active');
        }
      });
    } catch (e) {
      this.rethrowSequenceConflict(e);
    }
    return this.getSequence(orgId, id);
  }

  /**
   * Replace every step in one transaction.
   *
   * Delete-then-insert rather than a diff: the editor hands over the whole
   * list, and a diff would have to guess which edited step is "the same" as
   * which old one. The transaction is what stops a failure halfway leaving a
   * sequence with no steps at all.
   *
   * Live enrolments are clamped afterwards, because `current_step` may now
   * point past the end. Without that, shortening a sequence strands its leads
   * on a step that no longer exists and the runner completes them silently.
   */
  async replaceSteps(orgId: string, id: string, input: ReplaceStepsInput) {
    await this.ownedSequence(orgId, id);
    const rows = this.stepRows(orgId, input.steps);

    await this.prisma.$transaction([
      this.prisma.sequence_steps.deleteMany({ where: { organization_id: orgId, sequence_id: id } }),
      this.prisma.sequence_steps.createMany({
        data: rows.map((r) => ({ ...r, sequence_id: id })),
      }),
    ]);

    const clamped = await this.prisma.sequence_enrollments.updateMany({
      where: {
        organization_id: orgId,
        sequence_id: id,
        status: 'active',
        current_step: { gt: rows.length },
      },
      data: { current_step: rows.length },
    });
    if (clamped.count) {
      this.logger.log(`clamped ${clamped.count} enrolment(s) to the new last step of ${id}`);
    }

    return this.getSequence(orgId, id);
  }

  /**
   * Archive rather than delete.
   *
   * `sequence_enrollments.sequence_id` is ON DELETE CASCADE, so a real delete
   * would take the history of everyone who ever went through it — including
   * the record of why somebody stopped receiving texts, which is the one thing
   * worth keeping. Archiving also frees the auto-enrol temperature, because
   * that unique index only covers active rows.
   */
  async archiveSequence(orgId: string, id: string) {
    await this.ownedSequence(orgId, id);
    const stopped = await this.prisma.sequence_enrollments.updateMany({
      where: { organization_id: orgId, sequence_id: id, status: { in: ['active', 'paused'] } },
      data: {
        status: 'stopped',
        stopped_at: new Date(),
        stopped_reason: 'sequence_archived',
        next_action_at: null,
      },
    });
    await this.prisma.followup_sequences.update({
      where: { id },
      data: { status: 'archived', updated_at: new Date() },
    });
    // Release every condition this sequence held, so its replacement can claim
    // them. The rows stay, deactivated: an archived sequence still shows what
    // it used to enrol on, which is the first question asked when leads stop
    // arriving somewhere.
    await this.prisma.sequence_enroll_triggers.updateMany({
      where: { organization_id: orgId, sequence_id: id },
      data: { active: false },
    });
    this.logger.log(`archived sequence ${id}, stopping ${stopped.count} enrolment(s)`);
    return { archived: true, stoppedEnrollments: stopped.count };
  }

  // ------------------------------------------------------------ bulk enrolment

  /** The bulk conditions, as a `leads` where-clause. */
  private leadWhere(orgId: string, f: LeadFilterInput): Prisma.leadsWhereInput {
    return {
      organization_id: orgId,
      // Somebody who opted out is excluded from the MATCH rather than reported
      // as skipped, so the number the user confirms is the number that gets
      // added. Offering to text them at all is the wrong question to ask.
      dnc_status: false,
      ...(f.temperature ? { temperature: f.temperature } : {}),
      ...(f.status ? { status: f.status } : {}),
      ...(f.sourceId ? { lead_source_id: f.sourceId } : {}),
      ...(f.createdFrom || f.createdTo
        ? {
            created_at: {
              ...(f.createdFrom ? { gte: new Date(f.createdFrom) } : {}),
              ...(f.createdTo ? { lte: new Date(f.createdTo) } : {}),
            },
          }
        : {}),
      ...(f.noReply ? { first_response_at: null } : {}),
      ...(f.neverContacted ? { last_contact_at: null } : {}),
      ...(f.q
        ? {
            OR: [
              { first_name: { contains: f.q, mode: 'insensitive' as const } },
              { last_name: { contains: f.q, mode: 'insensitive' as const } },
              { phone: { contains: f.q } },
              { normalized_phone: { contains: f.q } },
            ],
          }
        : {}),
    };
  }

  /** Who a set of conditions would add, for the confirmation step. */
  async previewFilter(orgId: string, filter: LeadFilterInput) {
    const where = this.leadWhere(orgId, filter);
    const [total, rows] = await Promise.all([
      this.prisma.leads.count({ where }),
      this.prisma.leads.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: 25,
        select: {
          id: true,
          first_name: true,
          last_name: true,
          phone: true,
          temperature: true,
          status: true,
        },
      }),
    ]);
    return {
      total,
      cap: MAX_ENROLL_PER_CALL,
      sample: rows.map((l) => ({
        id: l.id,
        name: [l.first_name, l.last_name].filter(Boolean).join(' ').trim() || 'Unknown lead',
        phone: l.phone,
        temperature: l.temperature,
        status: l.status,
      })),
    };
  }

  /**
   * Add leads to a sequence, by hand or in bulk.
   *
   * Inserted one at a time rather than with createMany, deliberately: the
   * partial unique index is what stops a lead being enrolled twice, and
   * createMany fails the WHOLE batch on the first lead who is already in a
   * sequence — which in a bulk add is the common case, not the exception. One
   * insert each means the rest still go in and the user is told who was left
   * out and why.
   */
  async enrollLeads(
    orgId: string,
    sequenceId: string,
    input: EnrollInput,
    userId: string | null,
  ): Promise<EnrollResult> {
    const sequence = await this.ownedSequence(orgId, sequenceId);
    if (sequence.status !== 'active') {
      throw new AppError(
        'VALIDATION_ERROR',
        'That sequence is not active, so nothing can be added to it.',
      );
    }

    const first = await this.prisma.sequence_steps.findFirst({
      where: { organization_id: orgId, sequence_id: sequenceId },
      orderBy: { step_order: 'asc' },
    });
    if (!first) throw new AppError('VALIDATION_ERROR', 'That sequence has no steps yet.');

    const where: Prisma.leadsWhereInput = input.filter
      ? this.leadWhere(orgId, input.filter)
      : { organization_id: orgId, id: { in: input.leadIds ?? [] } };

    const matchedRows = await this.prisma.leads.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: MAX_ENROLL_PER_CALL,
      select: {
        id: true,
        first_name: true,
        last_name: true,
        dnc_status: true,
        status: true,
        first_contact_at: true,
        automation_paused: true,
      },
    });
    const matched = await this.prisma.leads.count({ where });

    const nameOf = (l: { first_name: string | null; last_name: string | null }) =>
      [l.first_name, l.last_name].filter(Boolean).join(' ').trim() || 'Unknown lead';

    const skipped: EnrollSkip[] = [];

    // A hand-picked id that matched nothing is worth reporting. A filter simply
    // did not select it, so there is nothing to say.
    if (input.leadIds) {
      const found = new Set(matchedRows.map((l) => l.id));
      for (const id of input.leadIds) {
        if (!found.has(id)) {
          skipped.push({ leadId: id, leadName: 'Unknown lead', reason: 'not_found' });
        }
      }
    }

    // Worked out before the dry run returns, so a preview and the real thing
    // give the same answer. Previously the preview counted leads the real run
    // would then silently refuse.
    const eligible = matchedRows.filter((lead) => {
      if (lead.dnc_status) {
        skipped.push({ leadId: lead.id, leadName: nameOf(lead), reason: 'dnc' });
        return false;
      }
      if (isInStrategy(lead)) {
        // The strategy engine is still contacting this lead. Adding it to a
        // sequence now would run two schedulers at it at once.
        skipped.push({ leadId: lead.id, leadName: nameOf(lead), reason: 'in_strategy' });
        return false;
      }
      return true;
    });

    if (input.dryRun) return { matched, enrolled: 0, skipped, dryRun: true };

    const { tz, quiet } = await this.guardrailsFor(orgId);
    const due = nextAllowedAt(tz, quiet, new Date(Date.now() + first.delay_minutes * 60_000));
    const enrolledBy = input.filter ? 'bulk' : 'manual';

    let enrolled = 0;
    for (const lead of eligible) {
      try {
        await this.prisma.sequence_enrollments.create({
          data: {
            organization_id: orgId,
            lead_id: lead.id,
            sequence_id: sequenceId,
            current_step: first.step_order,
            status: 'active',
            next_action_at: due,
            enrolled_by: enrolledBy,
            enrolled_by_user_id: userId,
          },
        });
        enrolled++;
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          skipped.push({ leadId: lead.id, leadName: nameOf(lead), reason: 'already_enrolled' });
          continue;
        }
        throw e;
      }
    }

    // A lead in a nurture sequence should read as 'nurture' in the pipeline
    // rather than still looking untouched. Only statuses that have not moved
    // past engagement are rewritten: a qualified or booked lead keeps its own.
    if (enrolled > 0) {
      await this.prisma.leads.updateMany({
        where: {
          organization_id: orgId,
          id: { in: matchedRows.map((l) => l.id) },
          status: { in: ['new', 'contacted'] },
        },
        data: { status: 'nurture' },
      });
    }

    this.logger.log(
      `${enrolledBy} enrolment into ${sequence.code}: ${enrolled} added, ${skipped.length} skipped`,
    );
    return { matched, enrolled, skipped, dryRun: false };
  }

  /** Take one lead back out. The counterpart to adding by hand. */
  async stopEnrollment(orgId: string, enrollmentId: string, reason = 'removed_by_user') {
    const { count } = await this.prisma.sequence_enrollments.updateMany({
      where: { organization_id: orgId, id: enrollmentId, status: { in: ['active', 'paused'] } },
      data: {
        status: 'stopped',
        stopped_at: new Date(),
        stopped_reason: reason.slice(0, 100),
        next_action_at: null,
        locked_by: null,
        locked_at: null,
      },
    });
    if (count === 0) throw new AppError('NOT_FOUND', 'No live enrolment with that id');
    return { stopped: true };
  }

  /** One sequence, shaped exactly as the list shapes them. */
  async getSequence(orgId: string, id: string) {
    const all = await this.listSequences(orgId);
    const one = all.find((s) => s.id === id);
    if (!one) throw new AppError('NOT_FOUND', 'No such sequence');
    return one;
  }

  /** The Follow-ups screen: every sequence with its steps and how many leads are in it. */
  async listSequences(orgId: string) {
    const rows = await this.prisma.followup_sequences.findMany({
      where: { organization_id: orgId },
      orderBy: { created_at: 'asc' },
      include: {
        sequence_steps: { orderBy: { step_order: 'asc' } },
        sequence_enroll_triggers: { orderBy: { trigger: 'asc' }, select: { trigger: true } },
      },
    });

    const counts = await this.prisma.sequence_enrollments.groupBy({
      by: ['sequence_id', 'status'],
      where: { organization_id: orgId },
      _count: { _all: true },
    });

    const byStatus = (id: string, status: string) =>
      counts.find((c) => c.sequence_id === id && c.status === status)?._count._all ?? 0;

    return rows.map((s) => ({
      id: s.id,
      code: s.code,
      name: s.name,
      description: s.description,
      status: s.status,
      // Every condition the office ticked, in force or not: an inactive
      // sequence must show its configuration rather than an empty checklist.
      enrollTriggers: s.sequence_enroll_triggers.map((t) => t.trigger),
      activeCount: byStatus(s.id, 'active'),
      pausedCount: byStatus(s.id, 'paused'),
      completedCount: byStatus(s.id, 'completed'),
      stoppedCount: byStatus(s.id, 'stopped'),
      createdAt: s.created_at.toISOString(),
      steps: s.sequence_steps.map((st) => ({
        stepOrder: st.step_order,
        actionType: st.action_type,
        delayMinutes: st.delay_minutes,
        messageTemplate: st.message_template,
        voicePrompt: st.voice_prompt,
        maxAttempts: st.max_attempts,
      })),
    }));
  }

  /** The enrolments themselves, so the screen can answer "who is in this, and what next". */
  async listEnrollments(orgId: string, limitRaw?: string) {
    const take = Math.min(Number(limitRaw ?? 100) || 100, 200);
    const rows = await this.prisma.sequence_enrollments.findMany({
      where: { organization_id: orgId },
      orderBy: [{ status: 'asc' }, { next_action_at: 'asc' }],
      take,
      include: {
        leads: { select: { id: true, first_name: true, last_name: true, phone: true, temperature: true } },
        followup_sequences: { select: { code: true, name: true } },
      },
    });

    return rows.map((e) => ({
      id: e.id,
      leadId: e.lead_id,
      leadName:
        [e.leads?.first_name, e.leads?.last_name].filter(Boolean).join(' ').trim() || 'Unknown lead',
      leadPhone: e.leads?.phone ?? null,
      temperature: e.leads?.temperature ?? null,
      sequenceCode: e.followup_sequences?.code ?? null,
      sequenceName: e.followup_sequences?.name ?? null,
      currentStep: e.current_step,
      status: e.status,
      nextActionAt: e.next_action_at ? e.next_action_at.toISOString() : null,
      enrolledAt: e.enrolled_at.toISOString(),
      stoppedReason: e.stopped_reason,
      lastError: e.last_error,
      enrolledBy: e.enrolled_by,
    }));
  }
}
