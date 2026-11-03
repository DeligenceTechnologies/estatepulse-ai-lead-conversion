import { Injectable, Logger } from '@nestjs/common';
import {
  EnrollmentStatus,
  FollowUpReason,
  LeadStatus,
  Prisma,
  SequenceStatus,
  SequenceTrigger,
  type EnrolledBy,
  type Sequence,
} from '@prisma/client';
import { lockOrganization } from '@/calendar/connection/calendar-access.service';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { minutesOfDay, nextContactAt, nextLocalMidnight, type QuietHours } from '@/common/utils/quiet-hours';
import { LeadStateService } from '@/lead/lead-state.service';
import { IN_STRATEGY_STATUSES, callbackPending, isLeadStatus } from '@/lead/lead-status';
import { fullName } from '@/lead/lead-scope';
import { StrategyStoreService } from '@/telnyx/strategy-store.service';
import type { CreateSequenceDto, EnrollLeadsDto, LeadFilterDto, ReplaceStepsDto, UpdateSequenceDto } from './dto/sequence.dto';
import { fitConditions, limitSlot, limitsOf, skipDaysOf, type ContactLimits, type StepConditions, type StepVoicemail } from './journey';

export const TRIGGER_LABELS: Record<SequenceTrigger, string> = {
  qualified_hot: 'Qualified as hot',
  qualified_warm: 'Qualified as warm',
  qualified_cold: 'Qualified as cold',
  follow_up_no_answer: 'Follow-up: No answer',
  follow_up_not_ready: 'Follow-up: Not ready',
  follow_up_callback_requested: 'Follow-up: Callback requested',
  follow_up_needs_time: 'Follow-up: Needs time',
  follow_up_other: 'Follow-up: Other',
};

export interface SequenceStep {
  actionType: 'sms' | 'voice';
  delayMinutes: number;
  messageTemplate: string | null;
  /** A call step: why the AI is calling, given to it as {{call_context}}. */
  voicePrompt: string | null;
  maxAttempts: number;
  onlyIf?: StepConditions;
  voicemail?: StepVoicemail;
}

/** The organization's contact window and limits, shared by the strategy, every sequence and the call worker. */
export interface Guardrails {
  timeZone: string;
  quiet?: QuietHours;
  skipDays: number[];
  limits: ContactLimits;
}

export interface EnrollSkip {
  leadId: string;
  leadName: string;
  reason: 'dnc' | 'already_enrolled' | 'not_found' | 'in_strategy';
}

const MAX_ENROLL_PER_CALL = 500;
const LIVE: EnrollmentStatus[] = [EnrollmentStatus.active, EnrollmentStatus.paused];

/** A hot lead goes straight to an agent (interested ends automation), so a sequence on this trigger never sends. */
export const HOT_TRIGGER_NOTE = 'Hot leads go straight to an agent, so a sequence for "Qualified as hot" never sends anything.';

/** Refuses the hot trigger when it is newly added; a sequence that already carries it may keep it. */
function assertNoNewHotTrigger(triggers: SequenceTrigger[], had: SequenceTrigger[] = []): void {
  if (triggers.includes(SequenceTrigger.qualified_hot) && !had.includes(SequenceTrigger.qualified_hot)) {
    throw new AppError('VALIDATION_ERROR', HOT_TRIGGER_NOTE, [{ path: 'enrollTriggers', message: HOT_TRIGGER_NOTE }]);
  }
}

export const stepsOf = (sequence: Pick<Sequence, 'steps'>): SequenceStep[] =>
  Array.isArray(sequence.steps) ? (sequence.steps as unknown as SequenceStep[]) : [];

const isInStrategy = (lead: { status: LeadStatus; firstContactAt: Date | null; automationPaused: boolean }) =>
  !lead.automationPaused && lead.firstContactAt !== null && IN_STRATEGY_STATUSES.includes(lead.status);

/**
 * Nurture sequences: timed SMS and AI-call steps a lead is enrolled in when
 * the strategy parks them, when a call scores them, or by hand. Each
 * enrolment condition belongs to at most one active sequence per organization.
 */
@Injectable()
export class FollowupService {
  private readonly logger = new Logger(FollowupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly strategies: StrategyStoreService,
    private readonly state: LeadStateService,
  ) {}

  async guardrailsFor(orgId: string): Promise<Guardrails> {
    const [settings, strategy] = await Promise.all([
      this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { timezone: true } }),
      this.strategies.getStrategy(orgId).catch(() => null),
    ]);
    const g = (strategy?.guardrails ?? {}) as { respectQuietHours?: boolean; quietHours?: QuietHours; skipDays?: unknown; limits?: unknown };
    return {
      timeZone: settings?.timezone ?? 'UTC',
      quiet: g.respectQuietHours === false ? undefined : g.quietHours,
      skipDays: skipDaysOf(g.skipDays),
      limits: limitsOf(g.limits),
    };
  }

  /**
   * When our next call or text to the lead may go: now, once the gap since the
   * last one on that channel has passed, or in the next day's contact window
   * when today's limit is used. Texts count the journey's own (strategy and
   * sequence steps), not the AI's chat replies; calls count every call placed.
   */
  async contactSlot(orgId: string, leadId: string, channel: 'sms' | 'voice', now = new Date()): Promise<{ at: Date; reason: string | null }> {
    const g = await this.guardrailsFor(orgId);
    if (!(channel === 'voice' ? g.limits.callsPerDay : g.limits.smsPerDay) && !g.limits.minGapMinutes) return { at: now, reason: null };
    const dayStart = new Date(now.getTime() - minutesOfDay(g.timeZone, now) * 60_000 - (now.getTime() % 60_000));
    const [sentToday, last] =
      channel === 'voice'
        ? await Promise.all([
            this.prisma.call.count({ where: { leadId, providerCallId: { not: null }, createdAt: { gte: dayStart } } }),
            this.prisma.call.findFirst({ where: { leadId, providerCallId: { not: null } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
          ])
        : await Promise.all([
            this.prisma.leadEvent.count({ where: { leadId, type: 'step_sent', channel: 'sms', createdAt: { gte: dayStart } } }),
            this.prisma.leadEvent.findFirst({ where: { leadId, type: 'step_sent', channel: 'sms' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
          ]);
    const tomorrow = nextContactAt(g.timeZone, g.quiet, g.skipDays, nextLocalMidnight(g.timeZone, now));
    return limitSlot({ channel, now, limits: g.limits, sentToday, lastAt: last?.createdAt ?? null, tomorrow });
  }

  /** Not every follow-up reason has a trigger (a canceled meeting has none yet); those find no sequence. */
  async sequenceForTrigger(orgId: string, trigger: SequenceTrigger): Promise<string | undefined> {
    if (!(Object.values(SequenceTrigger) as string[]).includes(trigger)) return undefined;
    const sequence = await this.prisma.sequence.findFirst({
      where: { orgId, status: SequenceStatus.active, triggers: { has: trigger } },
      select: { code: true },
    });
    return sequence?.code;
  }

  /** Enrols one lead, unless it is do-not-contact, still in the strategy, or already in a sequence. */
  async enroll(orgId: string, leadId: string, code: string): Promise<boolean> {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, orgId },
      select: { dncStatus: true, status: true, firstContactAt: true, automationPaused: true, callbackAt: true },
    });
    if (!lead || lead.dncStatus || isInStrategy(lead)) return false;
    // The lead asked to be called at a set time: nothing else contacts them before it.
    if (callbackPending(lead)) {
      this.logger.log(`lead ${leadId} not enrolled into ${code}: a callback is due ${lead.callbackAt?.toISOString()}`);
      return false;
    }
    const sequence = await this.prisma.sequence.findFirst({ where: { orgId, code, status: SequenceStatus.active } });
    const first = sequence ? stepsOf(sequence)[0] : undefined;
    if (!sequence || !first) return false;

    const due = await this.dueAt(orgId, first.delayMinutes);
    try {
      await this.prisma.sequenceEnrollment.create({
        data: { orgId, leadId, sequenceId: sequence.id, currentStep: 1, status: EnrollmentStatus.active, nextActionAt: due },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return false;
      throw error;
    }
    this.logger.log(`enrolled lead ${leadId} into ${code}, first step due ${due.toISOString()}`);
    return true;
  }

  async stopForLead(
    orgId: string,
    leadId: string,
    reason: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<number> {
    const { count } = await db.sequenceEnrollment.updateMany({
      where: { orgId, leadId, status: { in: LIVE } },
      data: { status: EnrollmentStatus.stopped, stoppedAt: new Date(), stoppedReason: reason.slice(0, 100), nextActionAt: null },
    });
    return count;
  }

  async pauseForLead(orgId: string, leadId: string): Promise<void> {
    await this.prisma.sequenceEnrollment.updateMany({
      where: { orgId, leadId, status: EnrollmentStatus.active },
      data: { status: EnrollmentStatus.paused, nextActionAt: null },
    });
  }

  async createSequence(orgId: string, input: CreateSequenceDto) {
    const status = input.status ?? SequenceStatus.active;
    const triggers = input.enrollTriggers ?? [];
    assertNoNewHotTrigger(triggers);
    const created = await this.prisma.$transaction(async (tx) => {
      await lockOrganization(tx, orgId);
      const existing = await tx.sequence.findFirst({ where: { orgId, code: input.code }, select: { name: true, status: true } });
      if (existing) {
        throw new AppError(
          'CONFLICT',
          existing.status === SequenceStatus.archived
            ? `The archived sequence "${existing.name}" already uses that code. Pick another.`
            : `"${existing.name}" already uses that code.`,
        );
      }
      if (status === SequenceStatus.active) await this.assertTriggersFree(tx, orgId, triggers);
      return tx.sequence.create({
        data: {
          orgId,
          code: input.code,
          name: input.name,
          description: input.description ?? null,
          status,
          triggers,
          steps: toSteps(input.steps) as unknown as Prisma.InputJsonArray,
          ...(input.closeOutHours !== undefined ? { closeOutHours: input.closeOutHours } : {}),
          ...(input.closeOutUnresponsive !== undefined ? { closeOutUnresponsive: input.closeOutUnresponsive } : {}),
        },
        select: { id: true },
      });
    });
    return this.getSequence(orgId, created.id);
  }

  async updateSequence(orgId: string, id: string, input: UpdateSequenceDto) {
    await this.prisma.$transaction(async (tx) => {
      await lockOrganization(tx, orgId);
      const current = await this.owned(orgId, id, tx);
      const status = input.status ?? current.status;
      const triggers = input.enrollTriggers ?? current.triggers;
      assertNoNewHotTrigger(triggers, current.triggers);
      if (status === SequenceStatus.active) await this.assertTriggersFree(tx, orgId, triggers, id);
      await tx.sequence.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.enrollTriggers !== undefined ? { triggers: input.enrollTriggers } : {}),
          ...(input.closeOutHours !== undefined ? { closeOutHours: input.closeOutHours } : {}),
          ...(input.closeOutUnresponsive !== undefined ? { closeOutUnresponsive: input.closeOutUnresponsive } : {}),
        },
      });
    });
    return this.getSequence(orgId, id);
  }

  /**
   * Live enrolments past the new last step are moved onto it rather than dropped.
   * Those already waiting out the close-out after the old last step stay in that
   * wait when the sequence got shorter, so their last step is not sent again;
   * when it got longer they go on to the new steps.
   */
  async replaceSteps(orgId: string, id: string, input: ReplaceStepsDto) {
    const before = stepsOf(await this.owned(orgId, id)).length;
    const steps = toSteps(input.steps);
    const live = { orgId, sequenceId: id, status: EnrollmentStatus.active };
    await this.prisma.$transaction([
      this.prisma.sequence.update({ where: { id }, data: { steps: steps as unknown as Prisma.InputJsonArray } }),
      this.prisma.sequenceEnrollment.updateMany({
        where: { ...live, currentStep: { gt: steps.length, lte: before } },
        data: { currentStep: steps.length },
      }),
      ...(steps.length < before
        ? [this.prisma.sequenceEnrollment.updateMany({ where: { ...live, currentStep: { gt: before } }, data: { currentStep: steps.length + 1 } })]
        : []),
    ]);
    return this.getSequence(orgId, id);
  }

  async archiveSequence(orgId: string, id: string) {
    await this.owned(orgId, id);
    const [stopped] = await this.prisma.$transaction([
      this.prisma.sequenceEnrollment.updateMany({
        where: { orgId, sequenceId: id, status: { in: LIVE } },
        data: { status: EnrollmentStatus.stopped, stoppedAt: new Date(), stoppedReason: 'sequence_archived', nextActionAt: null },
      }),
      this.prisma.sequence.update({ where: { id }, data: { status: SequenceStatus.archived } }),
    ]);
    return { archived: true, stoppedEnrollments: stopped.count };
  }

  async previewFilter(orgId: string, filter: LeadFilterDto) {
    const where = this.leadWhere(orgId, filter);
    const [total, rows] = await Promise.all([
      this.prisma.lead.count({ where }),
      this.prisma.lead.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 25,
        select: { id: true, firstName: true, lastName: true, phone: true, temperature: true, status: true },
      }),
    ]);
    return {
      total,
      cap: MAX_ENROLL_PER_CALL,
      sample: rows.map((l) => ({
        id: l.id,
        name: fullName(l.firstName, l.lastName, 'Unknown lead'),
        phone: l.phone,
        temperature: l.temperature,
        status: l.status,
      })),
    };
  }

  async enrollLeads(orgId: string, sequenceId: string, input: EnrollLeadsDto, userId: string | null) {
    const sequence = await this.owned(orgId, sequenceId);
    if (sequence.status !== SequenceStatus.active) {
      throw new AppError('VALIDATION_ERROR', 'That sequence is not active, so nothing can be added to it.');
    }
    const first = stepsOf(sequence)[0];
    if (!first) throw new AppError('VALIDATION_ERROR', 'That sequence has no steps yet.');

    const where: Prisma.LeadWhereInput = input.filter ? this.leadWhere(orgId, input.filter) : { orgId, id: { in: input.leadIds ?? [] } };
    const [matchedRows, matched] = await Promise.all([
      this.prisma.lead.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: MAX_ENROLL_PER_CALL,
        select: { id: true, firstName: true, lastName: true, dncStatus: true, status: true, firstContactAt: true, automationPaused: true },
      }),
      this.prisma.lead.count({ where }),
    ]);
    const nameOf = (l: { firstName: string | null; lastName: string | null }) => fullName(l.firstName, l.lastName, 'Unknown lead');
    const skipped: EnrollSkip[] = [];
    if (input.leadIds) {
      const found = new Set(matchedRows.map((l) => l.id));
      for (const id of input.leadIds) if (!found.has(id)) skipped.push({ leadId: id, leadName: 'Unknown lead', reason: 'not_found' });
    }
    const eligible = matchedRows.filter((lead) => {
      if (lead.dncStatus) skipped.push({ leadId: lead.id, leadName: nameOf(lead), reason: 'dnc' });
      else if (isInStrategy(lead)) skipped.push({ leadId: lead.id, leadName: nameOf(lead), reason: 'in_strategy' });
      else return true;
      return false;
    });
    if (input.dryRun) return { matched, enrolled: 0, skipped, dryRun: true };

    const due = await this.dueAt(orgId, first.delayMinutes);
    const enrolledBy: EnrolledBy = input.filter ? 'bulk' : 'manual';
    const inserted = eligible.length
      ? await this.prisma.sequenceEnrollment.createManyAndReturn({
          data: eligible.map((lead) => ({
            orgId,
            leadId: lead.id,
            sequenceId,
            currentStep: 1,
            status: EnrollmentStatus.active,
            nextActionAt: due,
            enrolledBy,
            enrolledByUserId: userId,
          })),
          skipDuplicates: true,
          select: { leadId: true },
        })
      : [];
    const insertedIds = new Set(inserted.map((r) => r.leadId));
    for (const lead of eligible) {
      if (!insertedIds.has(lead.id)) skipped.push({ leadId: lead.id, leadName: nameOf(lead), reason: 'already_enrolled' });
    }
    if (insertedIds.size > 0) {
      await this.state.moveMany([...insertedIds], LeadStatus.follow_up, {
        source: 'followup',
        reason: `Added to ${sequence.code} by hand`,
        onlyFrom: IN_STRATEGY_STATUSES,
        actor: { type: userId ? 'user' : 'system', id: userId },
        data: { followUpReason: FollowUpReason.needs_time },
      });
    }
    this.logger.log(`${enrolledBy} enrolment into ${sequence.code}: ${insertedIds.size} added, ${skipped.length} skipped`);
    return { matched, enrolled: insertedIds.size, skipped, dryRun: false };
  }

  async stopEnrollment(orgId: string, enrollmentId: string) {
    const { count } = await this.prisma.sequenceEnrollment.updateMany({
      where: { orgId, id: enrollmentId, status: { in: LIVE } },
      data: { status: EnrollmentStatus.stopped, stoppedAt: new Date(), stoppedReason: 'removed_by_user', nextActionAt: null, lockedBy: null, lockedAt: null },
    });
    if (count === 0) throw new AppError('NOT_FOUND', 'No live enrolment with that id');
    return { stopped: true };
  }

  async getSequence(orgId: string, id: string) {
    const one = (await this.listSequences(orgId)).find((s) => s.id === id);
    if (!one) throw new AppError('NOT_FOUND', 'No such sequence');
    return one;
  }

  async listSequences(orgId: string) {
    const [sequences, counts] = await Promise.all([
      this.prisma.sequence.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.sequenceEnrollment.groupBy({ by: ['sequenceId', 'status'], where: { orgId }, _count: { _all: true } }),
    ]);
    const countOf = (sequenceId: string, status: EnrollmentStatus) =>
      counts.find((c) => c.sequenceId === sequenceId && c.status === status)?._count._all ?? 0;
    return sequences.map((s) => ({
      id: s.id,
      code: s.code,
      name: s.name,
      description: s.description,
      status: s.status,
      enrollTriggers: [...s.triggers].sort(),
      closeOutHours: s.closeOutHours,
      closeOutUnresponsive: s.closeOutUnresponsive,
      activeCount: countOf(s.id, EnrollmentStatus.active),
      pausedCount: countOf(s.id, EnrollmentStatus.paused),
      completedCount: countOf(s.id, EnrollmentStatus.completed),
      stoppedCount: countOf(s.id, EnrollmentStatus.stopped),
      createdAt: s.createdAt.toISOString(),
      steps: stepsOf(s).map((step, i) => ({ stepOrder: i + 1, ...step })),
    }));
  }

  async listEnrollments(orgId: string, limit = 100) {
    const rows = await this.prisma.sequenceEnrollment.findMany({
      where: { orgId },
      orderBy: [{ status: 'asc' }, { nextActionAt: 'asc' }],
      take: Math.min(Math.max(limit, 1), 200),
      include: {
        lead: { select: { firstName: true, lastName: true, phone: true, temperature: true } },
        sequence: { select: { code: true, name: true, steps: true } },
      },
    });
    return rows.map((e) => ({
      id: e.id,
      leadId: e.leadId,
      leadName: fullName(e.lead?.firstName, e.lead?.lastName, 'Unknown lead'),
      leadPhone: e.lead?.phone ?? null,
      temperature: e.lead?.temperature ?? null,
      sequenceCode: e.sequence?.code ?? null,
      sequenceName: e.sequence?.name ?? null,
      currentStep: e.currentStep,
      /** Every step has run; the lead has until nextActionAt to answer before the close-out. */
      awaitingReply: e.status === EnrollmentStatus.active && e.sequence !== null && e.currentStep > stepsOf(e.sequence).length,
      status: e.status,
      nextActionAt: e.nextActionAt?.toISOString() ?? null,
      enrolledAt: e.enrolledAt.toISOString(),
      stoppedReason: e.stoppedReason,
      lastError: e.lastError,
      enrolledBy: e.enrolledBy,
    }));
  }

  async dueAt(orgId: string, delayMinutes: number): Promise<Date> {
    const { timeZone, quiet, skipDays } = await this.guardrailsFor(orgId);
    return nextContactAt(timeZone, quiet, skipDays, new Date(Date.now() + delayMinutes * 60_000));
  }

  private async owned(orgId: string, id: string, db: Prisma.TransactionClient | PrismaService = this.prisma) {
    const row = await db.sequence.findFirst({ where: { id, orgId } });
    if (!row) throw new AppError('NOT_FOUND', 'No such sequence');
    return row;
  }

  /** Runs under the organization lock, so two saves cannot both claim one condition. */
  private async assertTriggersFree(tx: Prisma.TransactionClient, orgId: string, triggers: SequenceTrigger[], exceptId?: string) {
    if (!triggers.length) return;
    const holder = await tx.sequence.findFirst({
      where: { orgId, status: SequenceStatus.active, triggers: { hasSome: triggers }, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
      select: { name: true, triggers: true },
    });
    if (holder) {
      const taken = holder.triggers.find((t) => triggers.includes(t))!;
      throw new AppError('CONFLICT', `"${holder.name}" already claims "${TRIGGER_LABELS[taken]}". Clear it there first.`);
    }
  }

  private leadWhere(orgId: string, f: LeadFilterDto): Prisma.LeadWhereInput {
    return {
      orgId,
      dncStatus: false,
      ...(f.temperature ? { temperature: f.temperature } : {}),
      ...(f.status && isLeadStatus(f.status) ? { status: f.status } : {}),
      ...(f.sourceId ? { leadSourceId: f.sourceId } : {}),
      ...(f.createdFrom || f.createdTo
        ? { createdAt: { ...(f.createdFrom ? { gte: new Date(f.createdFrom) } : {}), ...(f.createdTo ? { lte: new Date(f.createdTo) } : {}) } }
        : {}),
      ...(f.noReply ? { firstResponseAt: null } : {}),
      ...(f.neverContacted ? { lastContactAt: null } : {}),
      ...(f.q
        ? {
            OR: [
              { firstName: { contains: f.q, mode: 'insensitive' as const } },
              { lastName: { contains: f.q, mode: 'insensitive' as const } },
              { phone: { contains: f.q } },
              { normalizedPhone: { contains: f.q } },
            ],
          }
        : {}),
    };
  }
}

function toSteps(steps: ReplaceStepsDto['steps']): SequenceStep[] {
  return steps.map((s, i) => {
    const onlyIf = fitConditions(s.onlyIf, steps[i - 1]?.actionType);
    return {
      actionType: s.actionType,
      delayMinutes: s.delayMinutes,
      messageTemplate: s.actionType === 'sms' ? (s.messageTemplate ?? null) : null,
      voicePrompt: s.actionType === 'voice' ? (s.voicePrompt ?? null) : null,
      maxAttempts: s.maxAttempts ?? 1,
      ...(onlyIf ? { onlyIf } : {}),
      ...(s.actionType === 'voice' && s.voicemail && s.voicemail !== 'default' ? { voicemail: s.voicemail } : {}),
    };
  });
}
