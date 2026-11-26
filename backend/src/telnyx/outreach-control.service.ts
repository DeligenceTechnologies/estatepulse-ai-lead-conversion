import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { ConsentStatus, EnrollmentStatus, LeadStatus, type Prisma } from '@prisma/client';
import { AuditService } from '@/audit/audit.service';
import type { AuthContext } from '@/auth/auth.types';
import { spoken } from '@/calendar/booking/booking-time';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { contactZone, leadZone } from '@/common/utils/lead-timezone';
import { EventsBus } from '@/events/events.bus';
import { FollowupService } from '@/followup/followup.service';
import { LeadStateService } from '@/lead/lead-state.service';
import { IN_STRATEGY_STATUSES, OUTCOME_STATUSES } from '@/lead/lead-status';
import { OUTSIDE_IMPORT_REVIEW, fullName, visibleLeads } from '@/lead/lead-scope';
import { liveReviewReasons } from '@/lead/review-reasons';
import { PERMISSIONS } from '@/role/permissions';
import { EngineService } from './engine.service';
import { TextBackService } from './tools/text-back.service';
import { mayContact } from '@/lead/consent';

const PAUSED = 'outreach_paused';
const RESUMED = 'outreach_resumed';

/** Who paused or resumed: a person on the lead's page, or a person through Ask EstatePulse. */
export type ControlSource = 'agent' | 'assistant';

const LEAD = {
  id: true,
  orgId: true,
  firstName: true,
  lastName: true,
  status: true,
  dncStatus: true,
  consentStatus: true,
  automationPaused: true,
  firstContactAt: true,
  callbackAt: true,
  textBackAt: true,
  needsReview: true,
  reviewReasons: true,
  phone: true,
  phoneValid: true,
  timezone: true,
  normalizedPhone: true,
  updatedAt: true,
} satisfies Prisma.LeadSelect;

export type ControlledLead = Prisma.LeadGetPayload<{ select: typeof LEAD }>;

export interface OutreachState {
  paused: boolean;
  /** When a person paused it, who and why; null when it was paused by the system (a reply, a takeover) or not at all. */
  pausedAt: string | null;
  pausedBy: string | null;
  reason: string | null;
  /** Whether this user may pause or resume this lead. */
  canControl: boolean;
  /** Pausing would hold something (a strategy step, a sequence, a promised text or callback, or a strategy not yet started). */
  canPause: boolean;
  /** Resuming would restart something, or lets outreach start once a pending consent is recorded. */
  canResume: boolean;
  /** Why neither applies, in words for the lead's page ("No outreach is running to pause: the lead is appointment booked."). */
  note: string | null;
}

export interface ControlPlan {
  lead: ControlledLead;
  /** What changes, one line each, for the confirmation. */
  lines: string[];
  /** What the person should know but that does not change. */
  notes: string[];
}

export interface ResumeResult {
  strategy: 'started' | 'continued' | 'after_callback' | 'waiting' | 'none';
  sequences: number;
  textBackRestored: boolean;
}

interface PauseSnapshot {
  textBackAt: string | null;
}

const ahead = (at: Date | null | undefined, now = Date.now()): at is Date => !!at && at.getTime() > now;

/**
 * Pausing and resuming a lead's AI outreach by hand: an agent on their own leads, an admin on any
 * lead (whoever may see the lead and has lead.update), from the lead's page or Ask EstatePulse.
 *
 * A pause holds everything we would start: the strategy's next steps (it is not left, so it goes
 * on from there), the follow-up sequences (paused, not stopped) and a text the AI promised, whose
 * time is kept for the resume. A promised callback stays set; the call worker does not dial a
 * paused lead, so it only happens if the pause is lifted in time. If the lead texts, the AI still
 * answers. A resume lifts the pause and carries each of them on where it was.
 */
@Injectable()
export class OutreachControlService {
  private readonly logger = new Logger(OutreachControlService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: EngineService,
    @Inject(forwardRef(() => FollowupService)) private readonly followup: FollowupService,
    private readonly textBack: TextBackService,
    private readonly leadState: LeadStateService,
    private readonly audit: AuditService,
    private readonly events: EventsBus,
  ) {}

  async state(auth: AuthContext, leadId: string): Promise<OutreachState> {
    const lead = await this.lead(auth, leadId);
    const last = lead.automationPaused ? await this.lastControl(leadId) : null;
    const byPerson = last?.type === PAUSED ? last : null;
    const who = byPerson?.actorId
      ? await this.prisma.user.findFirst({ where: { id: byPerson.actorId, orgId: auth.organizationId }, select: { firstName: true, lastName: true, email: true } })
      : null;
    const control = await this.controls(auth, lead);
    return {
      paused: lead.automationPaused,
      pausedAt: byPerson ? byPerson.createdAt.toISOString() : null,
      pausedBy: who ? fullName(who.firstName, who.lastName, who.email) : null,
      reason: byPerson?.reason ?? null,
      canControl: auth.permissions.includes(PERMISSIONS.LEAD_UPDATE),
      ...control,
    };
  }

  /**
   * Which button the lead's page offers, from the same plans the buttons open, so a button is only
   * shown when it would do something: Pause while something would hold, Resume while something would
   * restart (or start once a pending consent is recorded). Otherwise the page says why.
   */
  private async controls(auth: AuthContext, lead: ControlledLead): Promise<Pick<OutreachState, 'canPause' | 'canResume' | 'note'>> {
    const why = (error: unknown) => (error instanceof AppError ? error.message : null);
    if (!lead.automationPaused) {
      try {
        await this.pausePlan(auth, lead.id);
        return { canPause: true, canResume: false, note: null };
      } catch (error) {
        return { canPause: false, canResume: false, note: why(error) };
      }
    }
    try {
      const plan = await this.resumePlan(auth, lead.id);
      if (plan.lines.length > 0 || !mayContact(lead)) return { canPause: false, canResume: true, note: null };
      return { canPause: false, canResume: false, note: plan.notes[0] ?? null };
    } catch (error) {
      return { canPause: false, canResume: false, note: why(error) };
    }
  }

  /** What a pause would hold, or why there is nothing to pause. */
  async pausePlan(auth: AuthContext, leadId: string): Promise<ControlPlan> {
    const lead = await this.lead(auth, leadId);
    if (lead.automationPaused) throw new AppError('CONFLICT', 'Outreach is already paused for this lead.');
    if (lead.dncStatus) throw new AppError('CONFLICT', 'This lead asked not to be contacted, so no outreach is running.');
    if (lead.consentStatus === ConsentStatus.revoked) throw new AppError('CONFLICT', 'This lead withdrew consent to be contacted, so no outreach is running.');
    const [zone, sequences] = await Promise.all([this.clock(lead), this.liveSequences(lead, EnrollmentStatus.active)]);
    const fresh = lead.status === LeadStatus.new && !lead.firstContactAt;
    const inStrategy = this.engine.isRunning(lead.id) || (await this.engine.canResume(lead.orgId, lead.id));
    const lines = [
      ...(fresh ? ['Outreach does not start for this new lead'] : []),
      ...(inStrategy ? ['The outreach strategy, from its next step'] : []),
      ...sequences.map((s) => `Sequence "${s.sequence.name}", at step ${s.currentStep}`),
      ...(ahead(lead.textBackAt) ? [`The text the AI promised for ${spoken(lead.textBackAt, zone)}`] : []),
      ...(ahead(lead.callbackAt) ? [`The callback the AI promised for ${spoken(lead.callbackAt, zone)}, unless resumed before it`] : []),
    ];
    if (lines.length === 0) {
      const why = OUTCOME_STATUSES.includes(lead.status) ? `the lead is ${lead.status.replace(/_/g, ' ')}` : 'its strategy has ended and it is in no sequence';
      throw new AppError('CONFLICT', `No outreach is running to pause: ${why}.`);
    }
    return { lead, lines, notes: ['If the lead texts, the AI still answers.'] };
  }

  async pause(auth: AuthContext, leadId: string, opts: { source: ControlSource; reason?: string }): Promise<{ paused: true; sequences: number }> {
    const { lead } = await this.pausePlan(auth, leadId);
    const orgId = auth.organizationId;
    const reason = opts.reason?.trim() || 'Paused by hand';
    const sequences = await this.prisma.$transaction(async (tx) => {
      const claim = await tx.lead.updateMany({ where: { id: lead.id, orgId, automationPaused: false }, data: { automationPaused: true, textBackAt: null } });
      if (claim.count === 0) throw new AppError('CONFLICT', 'Outreach is already paused for this lead.');
      const paused = await this.followup.pauseForLead(orgId, lead.id, tx);
      const snapshot: PauseSnapshot = { textBackAt: lead.textBackAt?.toISOString() ?? null };
      await this.leadState.record(
        { orgId, leadId: lead.id, type: PAUSED, source: opts.source, actor: { type: 'user', id: auth.userId }, reason, payload: { ...snapshot, sequences: paused } },
        tx,
      );
      await this.audit.record({ orgId, actorType: 'user', actorId: auth.userId, action: 'lead.outreach_paused', entityType: 'lead', entityId: lead.id, payload: { reason, source: opts.source } }, tx);
      return paused;
    });
    this.engine.pauseStrategy(lead.id);
    this.changed(orgId, lead.id);
    return { paused: true, sequences };
  }

  /** What a resume would carry on, and what it cannot bring back. */
  async resumePlan(auth: AuthContext, leadId: string): Promise<ControlPlan & { snapshot: PauseSnapshot | null }> {
    const lead = await this.lead(auth, leadId);
    if (!lead.automationPaused) throw new AppError('CONFLICT', 'Outreach is not paused for this lead.');
    if (lead.dncStatus) throw new AppError('CONFLICT', 'This lead asked not to be contacted.');
    if (lead.consentStatus === ConsentStatus.revoked) throw new AppError('CONFLICT', 'This lead withdrew consent to be contacted.');
    const reasons = lead.needsReview ? liveReviewReasons(lead) : [];
    if (reasons.length > 0) throw new AppError('CONFLICT', `The lead is waiting for review (${reasons.join(', ')}). Approve the review first.`);
    const [zone, sequences, snapshot, canReach] = await Promise.all([
      this.clock(lead),
      this.liveSequences(lead, EnrollmentStatus.paused),
      this.snapshot(lead.id),
      this.engine.canReachLeads(lead.orgId),
    ]);
    const lines: string[] = [];
    const notes: string[] = [];
    // Without consent the pause still lifts, but nothing reaches the lead until consent is recorded; then it starts or goes on by itself.
    const consented = mayContact(lead);
    if (!consented) notes.push("This lead has not given consent to be contacted: outreach starts or goes on by itself once it is recorded.");
    if (lead.status === LeadStatus.new && !lead.firstContactAt) {
      if (consented) lines.push('The outreach strategy starts from its first step');
      if (consented && !canReach) notes.push('No phone number is connected in AI Settings, so it starts once one is.');
    } else if (await this.engine.canResume(lead.orgId, lead.id)) {
      lines.push(ahead(lead.callbackAt) ? `The outreach strategy goes on after the callback on ${spoken(lead.callbackAt, zone)}` : 'The outreach strategy goes on from its next step');
    } else if (ahead(lead.callbackAt)) {
      lines.push(`The callback the AI promised for ${spoken(lead.callbackAt, zone)}`);
    }
    for (const s of sequences) lines.push(consented ? `Sequence "${s.sequence.name}" goes on from step ${s.currentStep}` : `Sequence "${s.sequence.name}" waits for the lead's consent`);
    const promised = snapshot?.textBackAt ? new Date(snapshot.textBackAt) : null;
    if (ahead(promised)) lines.push(`The text the AI promised for ${spoken(promised, zone)}`);
    else if (promised) notes.push(`The text the AI promised for ${spoken(promised, zone)} passed during the pause and is not sent.`);
    if (lead.callbackAt && !ahead(lead.callbackAt)) notes.push(`The callback the AI promised for ${spoken(lead.callbackAt, zone)} passed during the pause.`);
    if (lines.length === 0 && consented) {
      notes.push(
        OUTCOME_STATUSES.includes(lead.status)
          ? `Nothing restarts by itself: the lead is ${lead.status.replace(/_/g, ' ')}. Change its status or add it to a sequence.`
          : 'Nothing restarts by itself: its strategy has ended. It can be added to a sequence.',
      );
    }
    return { lead, lines, notes, snapshot };
  }

  async resume(auth: AuthContext, leadId: string, opts: { source: ControlSource }): Promise<ResumeResult> {
    const { lead, snapshot } = await this.resumePlan(auth, leadId);
    const orgId = auth.organizationId;
    const due = await this.followup.dueAt(orgId, 0);
    const sequences = await this.prisma.$transaction(async (tx) => {
      const claim = await tx.lead.updateMany({
        where: { id: lead.id, orgId, automationPaused: true },
        // A callback whose time passed during the pause is dropped, so it holds nothing back.
        data: { automationPaused: false, ...(lead.callbackAt && !ahead(lead.callbackAt) ? { callbackAt: null } : {}) },
      });
      if (claim.count === 0) throw new AppError('CONFLICT', 'Outreach is not paused for this lead.');
      const resumed = await this.followup.resumeForLead(orgId, lead.id, due, tx);
      await this.leadState.record({ orgId, leadId: lead.id, type: RESUMED, source: opts.source, actor: { type: 'user', id: auth.userId }, payload: { sequences: resumed } }, tx);
      await this.audit.record({ orgId, actorType: 'user', actorId: auth.userId, action: 'lead.outreach_resumed', entityType: 'lead', entityId: lead.id, payload: { source: opts.source } }, tx);
      return resumed;
    });

    let textBackRestored = false;
    const promised = snapshot?.textBackAt ? new Date(snapshot.textBackAt) : null;
    if (ahead(promised)) {
      try {
        await this.textBack.restore(orgId, lead.id, promised);
        textBackRestored = true;
      } catch (error) {
        this.logger.warn(`lead ${lead.id}: putting back the promised text after a resume failed: ${(error as Error).message}`);
      }
    }

    let strategy: ResumeResult['strategy'] = 'none';
    if (lead.status === LeadStatus.new && !lead.firstContactAt) {
      await this.engine.enroll(orgId, lead.id);
      const now = await this.prisma.lead.findFirst({ where: { id: lead.id, orgId }, select: { firstContactAt: true } });
      strategy = now?.firstContactAt ? 'started' : 'waiting';
    } else if (IN_STRATEGY_STATUSES.includes(lead.status) && (await this.engine.canResume(orgId, lead.id))) {
      strategy = (await this.engine.resume(orgId, lead.id)) ? 'continued' : ahead(lead.callbackAt) ? 'after_callback' : 'waiting';
    }
    this.changed(orgId, lead.id);
    return { strategy, sequences, textBackRestored };
  }

  /** The lead, if this user may see it and it is not still waiting in import or consent review. */
  private async lead(auth: AuthContext, leadId: string): Promise<ControlledLead> {
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, ...visibleLeads(auth), ...OUTSIDE_IMPORT_REVIEW }, select: LEAD });
    if (!lead) throw new AppError('NOT_FOUND', 'Lead not found');
    return lead;
  }

  private liveSequences(lead: ControlledLead, status: EnrollmentStatus) {
    return this.prisma.sequenceEnrollment.findMany({
      where: { orgId: lead.orgId, leadId: lead.id, status },
      select: { currentStep: true, sequence: { select: { name: true } } },
    });
  }

  /** The latest pause or resume a person made. */
  private lastControl(leadId: string) {
    return this.prisma.leadEvent.findFirst({
      where: { leadId, type: { in: [PAUSED, RESUMED] } },
      orderBy: { createdAt: 'desc' },
      select: { type: true, actorId: true, reason: true, createdAt: true, payload: true },
    });
  }

  /** What the pause being lifted held, when a person made it. */
  private async snapshot(leadId: string): Promise<PauseSnapshot | null> {
    const last = await this.lastControl(leadId);
    if (last?.type !== PAUSED) return null;
    const payload = (last.payload ?? {}) as { textBackAt?: unknown };
    return { textBackAt: typeof payload.textBackAt === 'string' ? payload.textBackAt : null };
  }

  /** Times are shown on the lead's clock when there is one, else the office's. */
  private async clock(lead: ControlledLead): Promise<string> {
    const own = contactZone(leadZone(lead));
    if (own) return own;
    const settings = await this.prisma.organizationSetting.findUnique({ where: { orgId: lead.orgId }, select: { timezone: true } });
    return settings?.timezone || 'UTC';
  }

  private changed(orgId: string, leadId: string): void {
    this.events.publish({ organizationId: orgId, type: 'lead.updated', leadSourceId: null, leadId });
  }
}
