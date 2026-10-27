import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { FollowUpReason, LeadStatus, type Prisma } from '@prisma/client';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { LeadOutcomeDto, LeadQualifiedDto, SetLeadStatusDto } from '@/lead/dto/lead-status.dto';
import { OUTCOME_STATUSES } from '@/lead/lead-status';
import { OUTSIDE_IMPORT_REVIEW, visibleLeads } from '@/lead/lead-scope';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { AssistantService } from './assistant.service';
import { SetToolsDto, StrategyDto, TestToolDto, ThresholdsDto } from './dto/telnyx.dto';
import { EngineService } from './engine.service';
import { LeadScoringService } from './lead-scoring.service';
import { SAFETY_RULES } from '@/outreach/safety-rules';
import { StrategyStoreService, toTwoStep, type Strategy } from './strategy-store.service';
import { callResult } from '@/outreach/step-guard.service';
import { strategyFlowSteps } from '@/outreach/strategy-flow';
import { nextAllowedAt, type QuietHours } from '@/common/utils/quiet-hours';

const OUTCOME_LABELS: Partial<Record<LeadStatus, string>> = {
  interested: 'Interested',
  appointment_requested: 'Appointment requested',
  appointment_booked: 'Appointment booked',
  follow_up: 'Exited strategy — follow-up needed',
  not_interested: 'Not interested',
  invalid: 'Invalid number',
  closed: 'Closed',
};

const PORTAL_LEAD_FIELDS = {
  id: true,
  orgId: true,
  assignedToId: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  status: true,
  followUpReason: true,
  dncStatus: true,
  location: true,
  minBudget: true,
  maxBudget: true,
  bedrooms: true,
  timeline: true,
  financingStatus: true,
  score: true,
  temperature: true,
  consentStatus: true,
  automationPaused: true,
  createdAt: true,
  updatedAt: true,
  lastContactAt: true,
  motivation: true,
  leadSource: { select: { provider: true, connectionMethod: true } },
} satisfies Prisma.LeadSelect;

type PortalLeadRow = Prisma.LeadGetPayload<{ select: typeof PORTAL_LEAD_FIELDS }>;

function sourceLabel(source: PortalLeadRow['leadSource']): string {
  if (!source) return 'manual';
  if (source.connectionMethod === 'MANUAL') return 'webhook';
  return source.provider.toLowerCase().replace(/_/g, ' ');
}

function toPortalLead(r: PortalLeadRow) {
  return {
    id: r.id,
    organizationId: r.orgId,
    assignedAgentId: r.assignedToId ?? '',
    firstName: r.firstName ?? '',
    lastName: r.lastName ?? '',
    email: r.email ?? '',
    phone: r.phone ?? '',
    source: sourceLabel(r.leadSource),
    status: r.status,
    followUpReason: r.status === LeadStatus.follow_up ? (r.followUpReason ?? FollowUpReason.other) : null,
    leadType: 'buyer',
    preferredLocation: r.location ?? '',
    budgetMin: r.minBudget != null ? Number(r.minBudget) : 0,
    budgetMax: r.maxBudget != null ? Number(r.maxBudget) : 0,
    propertyType: '',
    bedrooms: r.bedrooms ?? 0,
    timeline: r.timeline ?? '',
    financingStatus: r.financingStatus ?? '',
    preapprovalStatus: false,
    score: r.score != null ? Number(r.score) : 0,
    temperature: r.temperature ?? 'cold',
    consentStatus: r.consentStatus,
    dncStatus: r.dncStatus,
    automationPaused: r.automationPaused,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    lastContactedAt: r.lastContactAt?.toISOString(),
    notes: r.motivation ?? undefined,
  };
}

@Controller('assistant')
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.AUTOMATION_READ)
  async get(@CurrentAuth() auth: AuthContext) {
    const assistant = await this.assistant.getAssistant(auth.organizationId);
    if (!assistant) throw new AppError('NOT_FOUND', 'No AI agent configured');
    return { assistant };
  }

  /** The assistant's settings pass through to Telnyx; the service forwards only the keys it knows. */
  @Patch()
  @RequirePermissions(PERMISSIONS.AUTOMATION_UPDATE)
  async update(@CurrentAuth() auth: AuthContext, @Body() body: Record<string, unknown>) {
    return { assistant: await this.assistant.updateAssistant(auth.organizationId, body ?? {}) };
  }

  @Get('models')
  @RequirePermissions(PERMISSIONS.AUTOMATION_READ)
  async models(@CurrentAuth() auth: AuthContext) {
    return { models: await this.assistant.listModels(auth.organizationId) };
  }

  @Put('tools')
  @RequirePermissions(PERMISSIONS.AUTOMATION_UPDATE)
  async setTools(@CurrentAuth() auth: AuthContext, @Body() body: SetToolsDto) {
    return { assistant: await this.assistant.setTools(auth.organizationId, body.tools) };
  }

  @Delete('tools/:toolId')
  @RequirePermissions(PERMISSIONS.AUTOMATION_UPDATE)
  async detachTool(@CurrentAuth() auth: AuthContext, @Param('toolId') toolId: string) {
    return { assistant: await this.assistant.detachTool(auth.organizationId, encodeURIComponent(toolId)) };
  }

  @Post('tools/:toolId/test')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.AUTOMATION_UPDATE)
  async testTool(@CurrentAuth() auth: AuthContext, @Param('toolId') toolId: string, @Body() body: TestToolDto) {
    return { result: await this.assistant.testTool(auth.organizationId, encodeURIComponent(toolId), body.arguments, body.dynamic_variables) };
  }
}

/**
 * The saved strategy as it runs and, with conditional outreach on, its two-step form for the editor
 * (converted from an older one without saving it). Without `editor` the app shows the older editor.
 */
const withEditor = (strategy: Strategy, conditional: boolean) =>
  conditional
    ? {
        strategy,
        editor: toTwoStep(strategy),
        // The built-in rules, from the one list the engine and the sequence runner enforce.
        safetyRules: SAFETY_RULES,
      }
    : { strategy };

@Controller('strategy')
export class StrategyController {
  constructor(private readonly strategies: StrategyStoreService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.AUTOMATION_READ)
  async get(@CurrentAuth() auth: AuthContext) {
    return withEditor(await this.strategies.getStrategy(auth.organizationId), this.strategies.conditional);
  }

  @Put()
  @RequirePermissions(PERMISSIONS.AUTOMATION_UPDATE)
  async save(@CurrentAuth() auth: AuthContext, @Body() body: StrategyDto) {
    return withEditor(await this.strategies.saveStrategy(auth.organizationId, body as Partial<Strategy>), this.strategies.conditional);
  }
}

@Controller('lead-scoring')
export class LeadScoringController {
  constructor(private readonly scoring: LeadScoringService) {}

  @Get('settings')
  @RequirePermissions(PERMISSIONS.AUTOMATION_READ)
  async settings(@CurrentAuth() auth: AuthContext) {
    const t = await this.scoring.getThresholds(auth.organizationId);
    return { hotThreshold: t.hot, warmThreshold: t.warm };
  }

  @Put('settings')
  @RequirePermissions(PERMISSIONS.AUTOMATION_UPDATE)
  async saveSettings(@CurrentAuth() auth: AuthContext, @Body() body: ThresholdsDto) {
    if (body.warmThreshold >= body.hotThreshold) {
      throw new AppError('VALIDATION_ERROR', 'The warm threshold must be lower than the hot threshold', [
        { path: 'warmThreshold', message: 'The warm threshold must be lower than the hot threshold' },
      ]);
    }
    const t = await this.scoring.setThresholds(auth.organizationId, body);
    return { hotThreshold: t.hot, warmThreshold: t.warm };
  }
}

/** The lead list and outreach controls on the Leads page. */
@Controller('leads')
export class PortalLeadsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: EngineService,
    private readonly strategies: StrategyStoreService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.LEAD_READ)
  async list(@CurrentAuth() auth: AuthContext) {
    const rows = await this.prisma.lead.findMany({
      where: { orgId: auth.organizationId, ...OUTSIDE_IMPORT_REVIEW },
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: PORTAL_LEAD_FIELDS,
    });
    return { leads: rows.map(toPortalLead) };
  }

  @Post(':id/enroll')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermissions(PERMISSIONS.LEAD_UPDATE)
  async enroll(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    const lead = await this.prisma.lead.findFirst({ where: { id, orgId: auth.organizationId }, select: { id: true } });
    if (!lead) throw new AppError('NOT_FOUND', 'No such lead in this organization');
    await this.engine.enroll(auth.organizationId, id);
    return { ok: true };
  }

  /** Where the lead is in the outreach strategy, step by step, as far as the calls and texts on record show. */
  @Get(':id/flow')
  async flow(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) leadId: string) {
    const orgId = auth.organizationId;
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, ...visibleLeads(auth) } });
    if (!lead) throw new AppError('NOT_FOUND', 'Lead not found');
    const [strategy, settings, calls, messages, runs] = await Promise.all([
      this.strategies.getStrategy(orgId),
      this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { timezone: true } }),
      this.prisma.call.findMany({
        where: { orgId, leadId },
        orderBy: { createdAt: 'asc' },
        select: { status: true, createdAt: true, startedAt: true, answeredAt: true, endedAt: true, durationSeconds: true, extractedIntel: true, id: true },
      }),
      this.prisma.message.findMany({
        where: { orgId, leadId, direction: 'outbound', channel: 'sms' },
        orderBy: { createdAt: 'asc' },
        select: { deliveryStatus: true },
      }),
      lead.firstContactAt
        ? this.prisma.outreachStepRun.findMany({
            where: { orgId, leadId, runKey: { startsWith: `strategy:${lead.firstContactAt.getTime()}:` } },
            orderBy: { createdAt: 'asc' },
            select: { stepNumber: true, outcome: true, reason: true, detail: true, createdAt: true },
          })
        : [],
    ]);

    const steps = strategy.steps ?? [];
    const callOutcome = (s: string) =>
      s === 'no_answer'
        ? { state: 'failed', label: 'No answer' }
        : s === 'failed'
          ? { state: 'failed', label: 'Call failed' }
          : s === 'completed' || s === 'in_progress'
            ? { state: 'done', label: 'Answered' }
            : { state: 'current', label: 'Ringing' };
    const smsOutcome = (s: string) => (s === 'failed' ? { state: 'failed', label: 'SMS failed' } : { state: 'done', label: 'SMS sent' });

    let ci = 0;
    let mi = 0;
    // A lead run before step runs were recorded is matched to its calls and texts in order, as it always was.
    const stepsOut = runs.length
      ? strategyFlowSteps(steps, runs, calls)
      : steps.map((s, index) => {
          let outcome: string | null = null;
          let state = 'pending';
          const o = s.channel === 'voice' ? (ci < calls.length ? callOutcome(calls[ci++].status) : null) : mi < messages.length ? smsOutcome(messages[mi++].deliveryStatus) : null;
          if (o) ({ state, label: outcome } = o);
          return { index, channel: s.channel, action: s.action ?? s.channel, after: s.after, state, outcome };
        });
    const nextIndex = stepsOut.findIndex((s) => s.outcome === null);
    if (nextIndex >= 0) stepsOut[nextIndex].state = 'current';

    const fired = runs.length ? runs.filter((r) => r.outcome !== 'skipped').length : calls.length + messages.length;
    const status = lead.status;
    const phase = OUTCOME_STATUSES.includes(status) ? 'done' : status === LeadStatus.follow_up ? 'exited' : lead.firstContactAt ? 'strategy' : 'not_started';
    const answered = calls.some((c) => callResult(c) === 'answered' || c.status === 'in_progress');
    const outcome =
      OUTCOME_LABELS[status] ??
      (answered
        ? 'Call answered'
        : messages.some((m) => m.deliveryStatus === 'sent')
          ? 'SMS sent'
          : fired > 0
            ? 'Attempted — no success yet'
            : phase === 'not_started'
              ? 'Not started'
              : 'In strategy');

    const currentStep = phase === 'strategy' && nextIndex >= 0 ? stepsOut[nextIndex] : null;
    // The engine holds a step that comes due inside the contact window's quiet hours (fireStep); this says so on the lead.
    const guard = (strategy.guardrails ?? {}) as { respectQuietHours?: boolean; quietHours?: QuietHours };
    const now = new Date();
    const opensAt = currentStep ? nextAllowedAt(settings?.timezone ?? 'UTC', guard.respectQuietHours === false ? undefined : guard.quietHours, now) : now;

    return {
      phase,
      leadStatus: status,
      outcome,
      strategyName: strategy.name,
      stepsTotal: steps.length,
      completed: Math.min(runs.length || fired, steps.length),
      currentStep,
      heldUntil: opensAt > now ? opensAt.toISOString() : null,
      steps: stepsOut,
      reason: lead.aiSummary ?? null,
      // For the quick actions: read here, fresh, rather than from a copy of the lead the page may hold.
      automationPaused: lead.automationPaused,
      dncStatus: lead.dncStatus,
    };
  }

  @Patch(':id/status')
  @RequirePermissions(PERMISSIONS.LEAD_UPDATE)
  async setStatus(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: SetLeadStatusDto) {
    await this.engine.setStatus(auth.organizationId, id, body.status, body.reason, { followUpReason: body.followUpReason });
    return { ok: true, status: body.status };
  }

  @Post(':id/outcome')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.LEAD_UPDATE)
  async outcome(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: LeadOutcomeDto) {
    const optOut = body.outcome === 'dnc';
    await this.engine.setStatus(auth.organizationId, id, optOut ? LeadStatus.not_interested : (body.outcome as LeadStatus), body.summary, {
      followUpReason: body.followUpReason ?? FollowUpReason.callback_requested,
      optOut,
    });
    return { ok: true };
  }

  @Post(':id/qualified')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.LEAD_UPDATE)
  async qualified(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: LeadQualifiedDto) {
    await this.engine.qualified(auth.organizationId, id, body.temperature, body.summary);
    return { ok: true };
  }
}
