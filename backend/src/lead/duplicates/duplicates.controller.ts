import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { fullName, visibleLeads } from '../lead-scope';
import { DuplicateScannerService } from './duplicate-scanner.service';
import { LeadMergeService } from './lead-merge.service';
import { pickSurvivor } from './merge-rules';

class ListDuplicatesQuery {
  @IsOptional()
  @IsIn(['open', 'merged', 'dismissed'])
  status?: 'open' | 'merged' | 'dismissed';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  take?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number;
}

class MergePairDto {
  /** The lead to keep; the other one in the pair is merged into it. */
  @IsUUID()
  survivorId!: string;
}

class MergeLeadDto {
  /** The lead folded into the one in the path. */
  @IsUUID()
  mergeLeadId!: string;
}

const SUMMARY = {
  id: true,
  firstName: true,
  lastName: true,
  phone: true,
  email: true,
  status: true,
  temperature: true,
  location: true,
  timeline: true,
  minBudget: true,
  maxBudget: true,
  dncStatus: true,
  consentStatus: true,
  submissionCount: true,
  createdAt: true,
  lastContactAt: true,
  leadSource: { select: { id: true, name: true, provider: true } },
  assignedTo: { select: { id: true, firstName: true, lastName: true } },
  _count: { select: { calls: true, messages: true, meetings: true } },
} as const satisfies Prisma.LeadSelect;

type Summary = Prisma.LeadGetPayload<{ select: typeof SUMMARY }>;

/** The fields a reviewer compares side by side; ones that differ are highlighted. */
const COMPARED = ['firstName', 'lastName', 'phone', 'email', 'location', 'timeline', 'minBudget', 'maxBudget', 'status'] as const;

const toSummary = (l: Summary) => ({
  id: l.id,
  name: fullName(l.firstName, l.lastName, l.phone ?? l.email ?? 'Unknown'),
  firstName: l.firstName,
  lastName: l.lastName,
  phone: l.phone,
  email: l.email,
  status: l.status,
  temperature: l.temperature,
  location: l.location,
  timeline: l.timeline,
  minBudget: l.minBudget ? Number(l.minBudget) : null,
  maxBudget: l.maxBudget ? Number(l.maxBudget) : null,
  dncStatus: l.dncStatus,
  consentStatus: l.consentStatus,
  submissionCount: l.submissionCount,
  createdAt: l.createdAt,
  lastContactAt: l.lastContactAt,
  source: l.leadSource ? { id: l.leadSource.id, name: l.leadSource.name, provider: l.leadSource.provider } : null,
  assignedAgent: l.assignedTo ? { id: l.assignedTo.id, name: fullName(l.assignedTo.firstName, l.assignedTo.lastName) } : null,
  activity: { calls: l._count.calls, messages: l._count.messages, meetings: l._count.meetings },
});

const norm = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v).trim().toLowerCase());

/**
 * The duplicates review queue and merge/undo. Merging needs lead.read (it moves history between
 * leads an assigned-only agent may not see) and lead.update.
 */
@Controller('v1')
export class DuplicatesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly merges: LeadMergeService,
    private readonly scanner: DuplicateScannerService,
  ) {}

  /** Pairs to review, strongest first, with both leads side by side and the suggested lead to keep. */
  @Get('duplicates')
  @RequirePermissions(PERMISSIONS.LEAD_READ)
  async list(@CurrentAuth() auth: AuthContext, @Query() q: ListDuplicatesQuery) {
    const status = q.status ?? 'open';
    const where: Prisma.DuplicateCandidateWhereInput = {
      orgId: auth.organizationId,
      status,
      ...(status === 'open' ? { leadA: { mergedIntoId: null }, leadB: { mergedIntoId: null } } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.duplicateCandidate.count({ where }),
      this.prisma.duplicateCandidate.findMany({
        where,
        orderBy: status === 'open' ? [{ score: 'desc' }, { createdAt: 'desc' }] : [{ resolvedAt: 'desc' }],
        take: q.take ?? 25,
        skip: q.skip ?? 0,
        include: { leadA: { select: SUMMARY }, leadB: { select: SUMMARY } },
      }),
    ]);
    return {
      total,
      items: rows.map((c) => {
        const a = toSummary(c.leadA);
        const b = toSummary(c.leadB);
        const suggested = pickSurvivor(
          { id: a.id, status: c.leadA.status, createdAt: c.leadA.createdAt, activity: a.activity.calls + a.activity.messages },
          { id: b.id, status: c.leadB.status, createdAt: c.leadB.createdAt, activity: b.activity.calls + b.activity.messages },
        );
        return {
          id: c.id,
          score: c.score,
          reasons: c.reasons,
          status: c.status,
          createdAt: c.createdAt,
          resolvedAt: c.resolvedAt,
          leadA: a,
          leadB: b,
          suggestedSurvivorId: suggested.survivor,
          differences: COMPARED.filter((f) => norm((a as Record<string, unknown>)[f]) !== norm((b as Record<string, unknown>)[f])),
        };
      }),
    };
  }

  /** Just the count, for the nav badge. */
  @Get('duplicates/count')
  @RequirePermissions(PERMISSIONS.LEAD_READ)
  async count(@CurrentAuth() auth: AuthContext) {
    const open = await this.prisma.duplicateCandidate.count({
      where: { orgId: auth.organizationId, status: 'open', leadA: { mergedIntoId: null }, leadB: { mergedIntoId: null } },
    });
    return { open };
  }

  /** Look for duplicates across the whole organization now, instead of waiting for the nightly scan. */
  @Post('duplicates/scan')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.LEAD_READ, PERMISSIONS.LEAD_UPDATE)
  scan(@CurrentAuth() auth: AuthContext) {
    return this.scanner.scanOrg(auth.organizationId);
  }

  /** Two different people: the pair is never suggested again. */
  @Post('duplicates/:id/dismiss')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.LEAD_READ, PERMISSIONS.LEAD_UPDATE)
  async dismiss(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    const r = await this.prisma.duplicateCandidate.updateMany({
      where: { id, orgId: auth.organizationId, status: 'open' },
      data: { status: 'dismissed', resolvedById: auth.userId, resolvedAt: new Date() },
    });
    if (r.count === 0) throw new AppError('NOT_FOUND', 'No such open duplicate suggestion.');
    return { dismissed: true };
  }

  /** Merge the pair, keeping `survivorId`. */
  @Post('duplicates/:id/merge')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.LEAD_READ, PERMISSIONS.LEAD_UPDATE)
  async mergePair(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: MergePairDto) {
    const pair = await this.prisma.duplicateCandidate.findFirst({ where: { id, orgId: auth.organizationId, status: 'open' } });
    if (!pair) throw new AppError('NOT_FOUND', 'No such open duplicate suggestion.');
    if (body.survivorId !== pair.leadAId && body.survivorId !== pair.leadBId) {
      throw new AppError('VALIDATION_ERROR', 'The lead to keep must be one of the pair.');
    }
    const mergedId = body.survivorId === pair.leadAId ? pair.leadBId : pair.leadAId;
    return this.merges.merge(auth.organizationId, body.survivorId, mergedId, { type: 'user', id: auth.userId }, pair.reasons);
  }

  /** Open suggestions involving one lead, for the banner on its detail screen. */
  @Get('leads/:leadId/duplicates')
  @RequirePermissions(PERMISSIONS.LEAD_READ)
  async forLead(@CurrentAuth() auth: AuthContext, @Param('leadId', ParseUUIDPipe) leadId: string) {
    const rows = await this.prisma.duplicateCandidate.findMany({
      where: {
        orgId: auth.organizationId,
        status: 'open',
        OR: [{ leadAId: leadId }, { leadBId: leadId }],
        leadA: { mergedIntoId: null },
        leadB: { mergedIntoId: null },
      },
      orderBy: { score: 'desc' },
      include: { leadA: { select: SUMMARY }, leadB: { select: SUMMARY } },
    });
    return rows.map((c) => ({
      id: c.id,
      score: c.score,
      reasons: c.reasons,
      other: toSummary(c.leadAId === leadId ? c.leadB : c.leadA),
    }));
  }

  /** Every time the person reached the org, from which source; the original first. */
  @Get('leads/:leadId/submissions')
  async submissions(@CurrentAuth() auth: AuthContext, @Param('leadId', ParseUUIDPipe) leadId: string) {
    await this.visible(auth, leadId);
    const rows = await this.prisma.leadSubmission.findMany({
      where: { orgId: auth.organizationId, leadId },
      orderBy: [{ isOriginal: 'desc' }, { submittedAt: 'asc' }],
      include: { leadSource: { select: { id: true, name: true, provider: true } } },
      take: 200,
    });
    return rows.map((s) => ({
      id: s.id,
      channel: s.channel,
      isOriginal: s.isOriginal,
      matchedBy: s.matchedBy,
      submittedAt: s.submittedAt,
      source: s.leadSource ? { id: s.leadSource.id, name: s.leadSource.name, provider: s.leadSource.provider } : null,
      values: s.values,
    }));
  }

  /** Merges into this lead, newest first; the latest one not yet undone can be undone. */
  @Get('leads/:leadId/merges')
  async mergeHistory(@CurrentAuth() auth: AuthContext, @Param('leadId', ParseUUIDPipe) leadId: string) {
    await this.visible(auth, leadId);
    const rows = await this.prisma.leadMerge.findMany({
      where: { orgId: auth.organizationId, survivorId: leadId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const merged = await this.prisma.lead.findMany({
      where: { id: { in: rows.map((r) => r.mergedId) } },
      select: { id: true, firstName: true, lastName: true, phone: true, email: true },
    });
    const byId = new Map(merged.map((m) => [m.id, m]));
    const latestLive = rows.find((r) => !r.undoneAt)?.id;
    return rows.map((r) => {
      const m = byId.get(r.mergedId);
      const moved = (r.movedRows ?? {}) as Record<string, string[] | undefined>;
      return {
        id: r.id,
        mergedLead: m ? { id: m.id, name: fullName(m.firstName, m.lastName, m.phone ?? m.email ?? 'Unknown'), phone: m.phone, email: m.email } : null,
        reasons: r.reasons,
        createdAt: r.createdAt,
        undoneAt: r.undoneAt,
        canUndo: r.id === latestLive,
        moved: { messages: moved.message?.length ?? 0, calls: moved.call?.length ?? 0, meetings: moved.calendarMeeting?.length ?? 0 },
      };
    });
  }

  /** Merge any lead into this one (from the lead's own screen). */
  @Post('leads/:leadId/merge')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.LEAD_READ, PERMISSIONS.LEAD_UPDATE)
  merge(@CurrentAuth() auth: AuthContext, @Param('leadId', ParseUUIDPipe) leadId: string, @Body() body: MergeLeadDto) {
    return this.merges.merge(auth.organizationId, leadId, body.mergeLeadId, { type: 'user', id: auth.userId }, ['Merged by hand']);
  }

  @Post('merges/:mergeId/undo')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.LEAD_READ, PERMISSIONS.LEAD_UPDATE)
  undo(@CurrentAuth() auth: AuthContext, @Param('mergeId', ParseUUIDPipe) mergeId: string) {
    return this.merges.unmerge(auth.organizationId, mergeId, { type: 'user', id: auth.userId });
  }

  private async visible(auth: AuthContext, leadId: string): Promise<void> {
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, ...visibleLeads(auth) }, select: { id: true } });
    if (!lead) throw new AppError('NOT_FOUND', 'No such lead');
  }
}
