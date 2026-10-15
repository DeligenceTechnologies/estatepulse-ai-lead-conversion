import { Injectable, Logger } from '@nestjs/common';
import type { ActorType, Prisma } from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';

export interface AuditEntry {
  orgId: string | null;
  actorType: ActorType;
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  payload?: Prisma.InputJsonValue;
  durationMs?: number;
}

type Db = Pick<PrismaService, 'auditLog'> | Prisma.TransactionClient;

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Writes inside `db` when given, so the entry commits or rolls back with the change it records. */
  async record(entry: AuditEntry, db: Db = this.prisma): Promise<void> {
    await db.auditLog.create({ data: toRow(entry) });
  }

  async recordMany(entries: AuditEntry[], db: Db = this.prisma): Promise<void> {
    if (entries.length) await db.auditLog.createMany({ data: entries.map(toRow) });
  }

  /** For bookkeeping that must never fail the request it describes. */
  quietly(entry: AuditEntry): void {
    this.record(entry).catch((error) => this.logger.warn(`audit ${entry.action}: ${(error as Error).message}`));
  }
}

function toRow(entry: AuditEntry): Prisma.AuditLogCreateManyInput {
  return {
    orgId: entry.orgId,
    actorType: entry.actorType,
    actorId: entry.actorId ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    payload: entry.payload,
    durationMs: entry.durationMs,
  };
}
