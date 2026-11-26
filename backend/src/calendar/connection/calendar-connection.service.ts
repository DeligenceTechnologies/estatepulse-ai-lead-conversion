import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';
import { CalendarAccessService, USAGE_FIELDS } from './calendar-access.service';
import { connectionHealth, inUse } from './connection-state';

const SUMMARY_FIELDS = {
  provider: true,
  status: true,
  accountEmail: true,
  accountName: true,
  workspaceType: true,
  workspaceName: true,
  workspaceRole: true,
  lastError: true,
  connectedAt: true,
  syncedAt: true,
} as const satisfies Prisma.CalendarConnectionSelect;

/**
 * The organization's one calendar (Calendly or Cal.com): its status and
 * disconnecting. Never reads members, meetings or availability.
 */
@Injectable()
export class CalendarConnectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CalendarAccessService,
  ) {}

  /** The connection in use, or null. */
  async status(orgId: string) {
    const connection = await this.prisma.calendarConnection.findFirst({ where: inUse(orgId), select: SUMMARY_FIELDS });
    return {
      provider: connection?.provider ?? null,
      connection: connection
        ? {
            status: connectionHealth(connection),
            accountEmail: connection.accountEmail,
            accountName: connection.accountName,
            workspaceType: connection.workspaceType,
            workspaceName: connection.workspaceName,
            workspaceRole: connection.workspaceRole,
            connectedAt: connection.connectedAt,
            syncedAt: connection.syncedAt,
            lastError: connection.lastError,
          }
        : null,
    };
  }

  /** Removes the active connection and everything synced from it. Idempotent. */
  async disconnect(orgId: string): Promise<void> {
    const connection = await this.prisma.calendarConnection.findFirst({ where: inUse(orgId), select: USAGE_FIELDS });
    if (!connection) return;
    await this.access.removeWebhook(connection);
    await this.prisma.calendarConnection.deleteMany({ where: { id: connection.id } });
  }
}
