import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { OrgId } from '../common/decorators/auth.decorators';
import {
  LEAD_STATUSES,
  LeadStatus,
  OUTCOME_STATUSES,
  normalizeLeadStatus,
} from '../common/domain';
import { AppError } from '../common/errors';
import { OwnerGuard } from '../common/guards/owner.guard';
import { SessionGuard } from '../common/guards/session.guard';
import { UpstreamErrorInterceptor } from '../common/interceptors/upstream-error.interceptor';
import { PortalIngestService } from '../ingest/portal-ingest.service';
import { TENANT_PRISMA, type GuardedPrisma } from '../prisma/prisma.service';
import { AssistantService } from './assistant.service';
import { EngineService } from './engine.service';
import { StrategyStoreService, type Strategy } from './strategy-store.service';



/* eslint-disable @typescript-eslint/no-explicit-any */

/** Outcomes the AI call may report through POST /api/leads/:id/outcome. */
const AI_OUTCOMES = [
  LeadStatus.APPOINTMENT_REQUESTED,
  LeadStatus.NOT_INTERESTED,
  LeadStatus.DNC,
  LeadStatus.FOLLOW_UP,
] as const;

/** The journey's one-line result for a status that settles it. */
const OUTCOME_LABELS: Partial<Record<string, string>> = {
  [LeadStatus.QUALIFIED]: 'Qualified',
  [LeadStatus.APPOINTMENT_REQUESTED]: 'Appointment requested',
  [LeadStatus.APPOINTMENT_BOOKED]: 'Appointment booked',
  [LeadStatus.FOLLOW_UP]: 'Exited strategy — follow-up needed',
  [LeadStatus.NURTURE]: 'Exited strategy — in nurture',
  [LeadStatus.NOT_INTERESTED]: 'Not interested',
  [LeadStatus.DNC]: 'Do not contact',
  [LeadStatus.INVALID]: 'Invalid number',
  [LeadStatus.CLOSED]: 'Closed',
};

/** Map a DB leads row to the frontend Lead shape. Enum-ish fields are cast client-side. */
function mapLead(r: any) {
  return {
    id: r.id,
    organizationId: r.organization_id,
    assignedAgentId: r.takeover_user_id ?? '',
    firstName: r.first_name ?? '',
    lastName: r.last_name ?? '',
    email: r.email ?? '',
    phone: r.phone ?? '',
    source: 'Website',
    status: normalizeLeadStatus(r.status, !!r.dnc_status),
    leadType: 'buyer',
    preferredLocation: r.location ?? '',
    budgetMin: r.min_budget != null ? Number(r.min_budget) : 0,
    budgetMax: r.max_budget != null ? Number(r.max_budget) : 0,
    propertyType: '',
    bedrooms: r.bedrooms ?? 0,
    timeline: r.timeline ?? '',
    financingStatus: r.financing_status ?? '',
    preapprovalStatus: false,
    score: r.score != null ? Number(r.score) : 0,
    temperature: r.temperature ?? 'cold',
    consentStatus: r.consent_status ?? 'pending',
    dncStatus: !!r.dnc_status,
    automationPaused: !!r.automation_paused,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : new Date().toISOString(),
    lastContactedAt: r.last_contact_at ? new Date(r.last_contact_at).toISOString() : undefined,
    notes: r.motivation ?? undefined,
  };
}

/** The org's AI agent configuration, read and written on the provider. */
@Controller('api/assistant')
@UseGuards(SessionGuard)
@UseInterceptors(UpstreamErrorInterceptor)
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  @Get()
  async get(@OrgId() orgId: string) {
    const a = await this.assistant.getAssistant(orgId);
    if (!a) throw new AppError('NOT_FOUND', 'No AI agent configured');
    return { assistant: a };
  }

  @Patch()
  async update(@OrgId() orgId: string, @Body() body: any) {
    return { assistant: await this.assistant.updateAssistant(orgId, body ?? {}) };
  }

  @Get('models')
  async models(@OrgId() orgId: string) {
    return { models: await this.assistant.listModels(orgId) };
  }

  /**
   * The assistant's own tools, replaced wholesale. Shared tools are not in this
   * array and are not touched by it — see AssistantService.setTools.
   */
  @Put('tools')
  async setTools(@OrgId() orgId: string, @Body() body: any) {
    return { assistant: await this.assistant.setTools(orgId, body?.tools ?? []) };
  }

  /** Detaches a shared tool from this assistant. The library keeps the tool. */
  @Delete('tools/:toolId')
  async detachTool(@OrgId() orgId: string, @Param('toolId') toolId: string) {
    return { assistant: await this.assistant.detachTool(orgId, toolId) };
  }

  /** Invokes a webhook tool for real and returns the request and response. */
  @Post('tools/:toolId/test')
  @HttpCode(HttpStatus.OK)
  async testTool(
    @OrgId() orgId: string,
    @Param('toolId') toolId: string,
    @Body() body: any,
  ) {
    return {
      result: await this.assistant.testTool(
        orgId,
        toolId,
        body?.arguments,
        body?.dynamic_variables,
      ),
    };
  }

}

/** The org's single editable outbound strategy. */
@Controller('api/strategy')
@UseGuards(SessionGuard)
@UseInterceptors(UpstreamErrorInterceptor)
export class StrategyController {
  constructor(private readonly strategies: StrategyStoreService) {}

  @Get()
  async get(@OrgId() orgId: string) {
    return { strategy: await this.strategies.getStrategy(orgId) };
  }

  @Put()
  async save(@OrgId() orgId: string, @Body() body: Partial<Strategy>) {
    return { strategy: await this.strategies.saveStrategy(orgId, body ?? {}) };
  }
}

/**
 * Leads as the portal's dashboard sees them, plus the two manual engine
 * triggers. The automatic path is LeadWatcherService.
 */
@Controller('api/leads')
@UseGuards(SessionGuard)
@UseInterceptors(UpstreamErrorInterceptor)
export class PortalLeadsController {
  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma,
    private readonly engine: EngineService,
    private readonly strategies: StrategyStoreService,
  ) {}

  @Get()
  async list(@OrgId() orgId: string) {
    const rows = await this.prisma.leads.findMany({
      where: { organization_id: orgId },
      orderBy: { created_at: 'desc' },
      take: 500,
    });
    return { leads: rows.map(mapLead) };
  }

  /** Where is this lead in the journey: which strategy step, with what real outcome? */
  /** Enroll a lead now, instead of waiting for the watcher's next poll. */
  @Post(':id/enroll')
  @HttpCode(HttpStatus.ACCEPTED)
  async enroll(@OrgId() orgId: string, @Param('id') id: string) {
    // Checked here rather than left to the engine, which returns silently on
    // an unknown lead (right for its background callers) and short-circuits on
    // its in-memory map before any lookup. Another tenant's lead is a 404.
    const lead = await this.prisma.leads.findFirst({
      where: { id, organization_id: orgId },
      select: { id: true },
    });
    if (!lead) throw new AppError('NOT_FOUND', 'No such lead in this organization');
    await this.engine.enroll(orgId, id);
    return { ok: true };
  }

  /**
   * Where is this lead in the journey?
   *
   * Reads the strategy's steps and walks them against what actually happened —
   * the voice_calls and outbound messages on record — so each step shows its
   * real outcome rather than a guess. Derived on read rather than stored,
   * because the engine's schedule lives in memory and a restart would make any
   * stored progress a lie.
   */
  @Get(':id/flow')
  async flow(@OrgId() orgId: string, @Param('id') leadId: string) {
    // The reads are independent, so they run together instead of one round trip
    // each. getStrategy can write a default strategy when the office has none,
    // so it still waits until the lead is known to exist, as it always did.
    const leadP = this.prisma.leads.findFirst({
      where: { id: leadId, organization_id: orgId },
    });
    const strategyP = leadP.then((l) => (l ? this.strategies.getStrategy(orgId) : null));
    // Real outcomes, in order, so each step shows what actually happened.
    const callsP = this.prisma.voice_calls.findMany({
      where: { organization_id: orgId, lead_id: leadId },
      orderBy: { created_at: 'asc' },
      select: { status: true },
    });
    // Outbound texts on this lead's SMS threads, in one query rather than
    // threads-then-messages. Both sides carry organization_id: messages is
    // tenant-scoped, and the relation alone must not stand in for that.
    const msgsP = this.prisma.messages.findMany({
      where: {
        organization_id: orgId,
        direction: 'outbound',
        conversations: { organization_id: orgId, lead_id: leadId, channel: 'sms' },
      },
      orderBy: { created_at: 'asc' },
      select: { delivery_status: true },
    });

    const [leadR, strategyR, callsR, msgsR] = await Promise.allSettled([leadP, strategyP, callsP, msgsP]);
    // A missing lead is reported as before, whatever the other reads did.
    if (leadR.status === 'rejected') throw leadR.reason;
    const lead = leadR.value;
    if (!lead) throw new AppError('NOT_FOUND', 'Lead not found');
    for (const r of [strategyR, callsR, msgsR]) if (r.status === 'rejected') throw r.reason;
    const strategy = (strategyR as PromiseFulfilledResult<Awaited<typeof strategyP>>).value!;
    const calls = (callsR as PromiseFulfilledResult<Awaited<typeof callsP>>).value;
    const msgs = (msgsR as PromiseFulfilledResult<Awaited<typeof msgsP>>).value;
    const steps = strategy.steps ?? [];

    const callOutcome = (s: string): { state: string; label: string } =>
      s === 'no_answer'
        ? { state: 'failed', label: 'No answer' }
        : s === 'failed'
          ? { state: 'failed', label: 'Call failed' }
          : s === 'completed' || s === 'in_progress'
            ? { state: 'done', label: 'Answered' }
            : { state: 'current', label: 'Ringing' };
    const smsOutcome = (s: string): { state: string; label: string } =>
      s === 'failed' ? { state: 'failed', label: 'SMS failed' } : { state: 'done', label: 'SMS sent' };

    // Walk the steps, consuming the matching activity per channel.
    let ci = 0;
    let mi = 0;
    const stepsOut = steps.map((s, i) => {
      let outcome: string | null = null;
      let state = 'pending';
      if (s.channel === 'voice') {
        if (ci < calls.length) {
          const o = callOutcome(calls[ci++]!.status ?? '');
          state = o.state;
          outcome = o.label;
        }
      } else if (mi < msgs.length) {
        const o = smsOutcome(msgs[mi++]!.delivery_status ?? '');
        state = o.state;
        outcome = o.label;
      }
      return { index: i, channel: s.channel, action: s.action ?? s.channel, after: s.after, state, outcome };
    });
    const nextIndex = stepsOut.findIndex((s) => s.outcome === null);
    if (nextIndex >= 0) stepsOut[nextIndex]!.state = 'current';
    const fired = calls.length + msgs.length;

    const status = normalizeLeadStatus(lead.status, !!lead.dnc_status);
    let phase: 'not_started' | 'strategy' | 'exited' | 'done';
    if (OUTCOME_STATUSES.includes(status)) phase = 'done';
    else if (status === LeadStatus.NURTURE || status === LeadStatus.FOLLOW_UP) phase = 'exited';
    else if (lead.first_contact_at) phase = 'strategy';
    else phase = 'not_started';

    // The best real-world result so far, as a sentence.
    const answered = calls.some((c) => c.status === 'completed' || c.status === 'in_progress');
    const smsSent = msgs.some((m) => m.delivery_status === 'sent');
    let outcome: string;
    if (OUTCOME_LABELS[status]) outcome = OUTCOME_LABELS[status]!;
    else if (status === LeadStatus.ENGAGED) outcome = 'Engaged — in conversation';
    else if (answered) outcome = 'Call answered';
    else if (smsSent) outcome = 'SMS sent';
    else if (fired > 0) outcome = 'Attempted — no success yet';
    else outcome = phase === 'not_started' ? 'Not started' : 'In strategy';

    return {
      phase,
      leadStatus: status,
      outcome,
      strategyName: strategy.name,
      stepsTotal: steps.length,
      completed: Math.min(fired, steps.length),
      currentStep: phase === 'strategy' && nextIndex >= 0 ? stepsOut[nextIndex] : null,
      steps: stepsOut,
      reason: lead.ai_summary ?? null,
    };
  }

  /**
   * Move a lead to any status by hand — the only way into 'closed', and the
   * correction path for everything automation decided. Owner-only: this can
   * take a lead out of the pipeline (or mark it do-not-contact) for good.
   */
  @Patch(':id/status')
  @UseGuards(OwnerGuard)
  @HttpCode(HttpStatus.OK)
  async setStatus(@OrgId() orgId: string, @Param('id') id: string, @Body() body: any) {
    const { status, reason } = body ?? {};
    if (!(LEAD_STATUSES as readonly string[]).includes(status)) {
      throw new AppError('VALIDATION_ERROR', `status must be one of ${LEAD_STATUSES.join('|')}`);
    }
    try {
      await this.engine.setStatus(orgId, id, status as LeadStatus, typeof reason === 'string' ? reason : undefined);
    } catch (e) {
      throw new AppError('NOT_FOUND', (e as Error).message);
    }
    return { ok: true, status };
  }

  /**
   * The AI call reports an outcome that is not a temperature: the lead asked
   * for an appointment, is not interested, asked not to be called, or wants a
   * call back. Same caller and auth as /qualified.
   */
  @Post(':id/outcome')
  @HttpCode(HttpStatus.OK)
  async outcome(@OrgId() orgId: string, @Param('id') id: string, @Body() body: any) {
    const { outcome, summary } = body ?? {};
    if (!(AI_OUTCOMES as readonly string[]).includes(outcome)) {
      throw new AppError('VALIDATION_ERROR', `outcome must be one of ${AI_OUTCOMES.join('|')}`);
    }
    try {
      await this.engine.setStatus(orgId, id, outcome as LeadStatus, typeof summary === 'string' ? summary : undefined);
    } catch (e) {
      throw new AppError('NOT_FOUND', (e as Error).message);
    }
    return { ok: true };
  }

  /** The AI call reports the qualification result -> stop the strategy, hand off. */
  @Post(':id/qualified')
  @HttpCode(HttpStatus.OK)
  async qualified(@OrgId() orgId: string, @Param('id') id: string, @Body() body: any) {
    const { temperature, summary } = body ?? {};
    if (!['hot', 'warm', 'cold'].includes(temperature)) {
      throw new AppError('VALIDATION_ERROR', 'temperature must be hot|warm|cold');
    }
    await this.engine.qualified(orgId, id, temperature, summary);
    return { ok: true };
  }
}

/** Dashboard management of the portal's own webhook tokens. */
@Controller('api/ingest/sources')
@UseGuards(SessionGuard)
@UseInterceptors(UpstreamErrorInterceptor)
export class IngestSourcesController {
  constructor(private readonly ingest: PortalIngestService) {}

  @Get()
  async list(@OrgId() orgId: string) {
    return { sources: await this.ingest.listSources(orgId) };
  }

  /** The plaintext token is returned ONCE here; only its hash is stored. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@OrgId() orgId: string, @Body() body: any) {
    const label = String(body?.label ?? '').trim();
    if (!label) throw new AppError('VALIDATION_ERROR', 'label is required');
    return this.ingest.createSource(orgId, label);
  }

  @Patch(':id')
  async setActive(@OrgId() orgId: string, @Param('id') id: string, @Body() body: any) {
    const active = Boolean(body?.active);
    const ok = await this.ingest.setSourceActive(orgId, id, active);
    if (!ok) throw new AppError('NOT_FOUND', 'Source not found');
    return { ok: true, active };
  }
}
