import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AuditService } from '@/audit/audit.service';
import type { AuthContext } from '@/auth/auth.types';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { fullName } from '@/lead/lead-scope';
import { PERMISSIONS } from '@/role/permissions';

/** What an owner sets for the whole office. */
export interface AssistantSettings {
  /** Off: nobody in the office can use the assistant. Chats are kept. */
  enabled: boolean;
  /** A monthly spending cap in US dollars below the plan's allowance; null uses the plan's allowance. */
  monthlyLimitUsd: number | null;
  /** The microphone in the chat box (the browser turns speech into text). */
  voiceEnabled: boolean;
}

export const DEFAULT_ASSISTANT_SETTINGS: AssistantSettings = { enabled: true, monthlyLimitUsd: null, voiceEnabled: true };

export const MAX_MONTHLY_LIMIT_USD = 100_000;

/** The stored setting with its defaults; a value of the wrong type counts as missing. */
export function assistantSettings(raw: unknown): AssistantSettings {
  const v = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const limit = typeof v.monthlyLimitUsd === 'number' && Number.isFinite(v.monthlyLimitUsd) && v.monthlyLimitUsd > 0 ? v.monthlyLimitUsd : null;
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : DEFAULT_ASSISTANT_SETTINGS.enabled,
    monthlyLimitUsd: limit,
    voiceEnabled: typeof v.voiceEnabled === 'boolean' ? v.voiceEnabled : DEFAULT_ASSISTANT_SETTINGS.voiceEnabled,
  };
}

export const usdToMicros = (usd: number): number => Math.round(usd * 1_000_000);

export interface AssistantLogEntry {
  id: string;
  at: string;
  /** Who asked; null when the user was deleted. */
  user: string | null;
  tool: string;
  /** What it did, from its card ("Text Maria Lopez") or the tool's own label ("Searching leads"). */
  what: string;
  tier: 'read' | 'write';
  status: string;
  error: string | null;
}

const LOG_PAGE = 50;

@Injectable()
export class AssistantSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(orgId: string): Promise<AssistantSettings> {
    const row = await this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { assistant: true } });
    return assistantSettings(row?.assistant);
  }

  /** Changes what the patch names; every change is in the audit log. */
  async update(auth: AuthContext, patch: Partial<AssistantSettings>): Promise<AssistantSettings> {
    const orgId = auth.organizationId;
    if (patch.monthlyLimitUsd !== undefined && patch.monthlyLimitUsd !== null && !(patch.monthlyLimitUsd > 0 && patch.monthlyLimitUsd <= MAX_MONTHLY_LIMIT_USD)) {
      throw new AppError('VALIDATION_ERROR', `The monthly limit must be between $1 and $${MAX_MONTHLY_LIMIT_USD.toLocaleString('en-US')}, or empty for the plan's allowance.`);
    }
    const before = await this.get(orgId);
    const next: AssistantSettings = {
      enabled: patch.enabled ?? before.enabled,
      monthlyLimitUsd: patch.monthlyLimitUsd === undefined ? before.monthlyLimitUsd : patch.monthlyLimitUsd,
      voiceEnabled: patch.voiceEnabled ?? before.voiceEnabled,
    };
    const stored = next as unknown as Prisma.InputJsonObject;
    await this.prisma.$transaction(async (tx) => {
      await tx.organizationSetting.upsert({ where: { orgId }, create: { orgId, assistant: stored }, update: { assistant: stored } });
      await this.audit.record(
        {
          orgId,
          actorType: 'user',
          actorId: auth.userId,
          action: 'organization.assistant_settings_updated',
          entityType: 'organization',
          entityId: orgId,
          payload: { before, after: next } as unknown as Prisma.InputJsonObject,
        },
        tx,
      );
    });
    return next;
  }

  /** Everything the assistant did in the office, newest first: each look-up and each card with how it ended. */
  async log(auth: AuthContext, labels: (tool: string) => string, before?: Date): Promise<{ entries: AssistantLogEntry[]; nextCursor: string | null }> {
    const rows = await this.prisma.assistantAction.findMany({
      where: { orgId: auth.organizationId, ...(before ? { createdAt: { lt: before } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: LOG_PAGE + 1,
      select: { id: true, createdAt: true, userId: true, toolName: true, tier: true, status: true, preview: true, error: true },
    });
    const page = rows.slice(0, LOG_PAGE);
    const users = await this.prisma.user.findMany({
      where: { orgId: auth.organizationId, id: { in: [...new Set(page.map((r) => r.userId))] } },
      select: { id: true, firstName: true, lastName: true, email: true },
    });
    const names = new Map(users.map((u) => [u.id, fullName(u.firstName, u.lastName, u.email)]));
    return {
      entries: page.map((r) => ({
        id: r.id,
        at: r.createdAt.toISOString(),
        user: names.get(r.userId) ?? null,
        tool: r.toolName,
        what: (r.preview as { title?: string } | null)?.title ?? labels(r.toolName),
        tier: r.tier,
        status: r.status,
        error: r.error,
      })),
      nextCursor: rows.length > LOG_PAGE ? page[page.length - 1].createdAt.toISOString() : null,
    };
  }

  canEdit(auth: AuthContext): boolean {
    return auth.permissions.includes(PERMISSIONS.ORGANIZATION_UPDATE);
  }
}
