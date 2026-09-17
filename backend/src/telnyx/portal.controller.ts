import {
  Body,
  Controller,
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
import { AppError } from '../common/errors';
import { SessionGuard } from '../common/guards/session.guard';
import { UpstreamErrorInterceptor } from '../common/interceptors/upstream-error.interceptor';
import { PortalIngestService } from '../ingest/portal-ingest.service';
import { TENANT_PRISMA, type GuardedPrisma } from '../prisma/prisma.service';
import { AssistantService } from './assistant.service';
import { EngineService } from './engine.service';
import { StrategyStoreService, type Strategy } from './strategy-store.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

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
    status: r.status ?? 'new',
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

  /** Enroll a lead now, instead of waiting for the watcher's next poll. */
  @Post(':id/enroll')
  @HttpCode(HttpStatus.ACCEPTED)
  async enroll(@OrgId() orgId: string, @Param('id') id: string) {
    await this.engine.enroll(orgId, id);
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
