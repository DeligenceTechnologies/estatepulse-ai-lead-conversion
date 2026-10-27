import { Injectable, Logger } from '@nestjs/common';
import type { ActorType, LeadStatus, Prisma } from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';
import { canMove, type MoveRule } from './lead-state';

type Db = PrismaService | Prisma.TransactionClient;

export interface Actor {
  type: ActorType;
  id?: string | null;
}

export interface MoveOptions extends MoveRule {
  /** What decided it: strategy, followup, call, scoring, sms_reply, calendar, agent, import. */
  source: string;
  reason?: string | null;
  actor?: Actor;
  /** Other lead fields set together with the status (a reason, a summary, the temperature). */
  data?: Prisma.LeadUpdateManyMutationInput;
  channel?: 'sms' | 'voice';
  callId?: string | null;
  payload?: Prisma.InputJsonValue;
}

export interface MoveResult {
  /** The status changed, or was already the target and the extra fields were written. */
  moved: boolean;
  /** The status before; null when there is no such lead. */
  from: LeadStatus | null;
}

export interface LeadEventInput {
  orgId: string;
  leadId: string;
  type: string;
  source: string;
  reason?: string | null;
  actor?: Actor;
  channel?: 'sms' | 'voice';
  callId?: string | null;
  payload?: Prisma.InputJsonValue;
}

const SYSTEM: Actor = { type: 'system' };
/** A move that loses a race with another one re-reads the status this many times. */
const ATTEMPTS = 3;

/**
 * The one place a lead's status changes. Every move is checked against the
 * automation rules in lead-state.ts (a person changing it by hand is not),
 * applied only if the status is still what was read, and logged in
 * lead_events with what decided it and why.
 */
@Injectable()
export class LeadStateService {
  private readonly logger = new Logger(LeadStateService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Runs inside `db` when given, so the move commits or rolls back with the change around it. */
  async move(leadId: string, to: LeadStatus, opts: MoveOptions, db?: Db): Promise<MoveResult> {
    const run = async (tx: Db): Promise<MoveResult> => {
      for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        const lead = await tx.lead.findUnique({ where: { id: leadId }, select: { orgId: true, status: true } });
        if (!lead) return { moved: false, from: null };
        if (!canMove(lead.status, to, opts)) {
          // Already there (a first-contact move on every text) is not worth a line.
          if (lead.status !== to) this.logger.debug(`lead ${leadId}: ${lead.status} → ${to} refused (${opts.source})`);
          return { moved: false, from: lead.status };
        }
        const updated = await tx.lead.updateMany({ where: { id: leadId, status: lead.status }, data: { ...opts.data, status: to } });
        if (updated.count === 0) continue;
        if (lead.status !== to) {
          await tx.leadEvent.create({
            data: this.row({ ...opts, orgId: lead.orgId, leadId, type: 'status_changed' }, { from: lead.status, to }),
          });
        }
        return { moved: true, from: lead.status };
      }
      this.logger.warn(`lead ${leadId}: status kept changing under ${opts.source}'s move to ${to}; gave up`);
      return { moved: false, from: null };
    };
    return db ? run(db) : this.prisma.$transaction(run);
  }

  /** Moves several leads at once (a bulk enrolment); each one only if its own status allows it. Returns the ids moved. */
  async moveMany(leadIds: string[], to: LeadStatus, opts: MoveOptions, db: Db = this.prisma): Promise<string[]> {
    if (!leadIds.length) return [];
    const leads = await db.lead.findMany({ where: { id: { in: leadIds } }, select: { id: true, orgId: true, status: true } });
    const byStatus = new Map<LeadStatus, typeof leads>();
    for (const lead of leads.filter((l) => canMove(l.status, to, opts))) {
      byStatus.set(lead.status, [...(byStatus.get(lead.status) ?? []), lead]);
    }
    const moved: string[] = [];
    for (const [from, group] of byStatus) {
      const ids = group.map((l) => l.id);
      await db.lead.updateMany({ where: { id: { in: ids }, status: from }, data: { ...opts.data, status: to } });
      const now = await db.lead.findMany({ where: { id: { in: ids }, status: to }, select: { id: true } });
      const done = new Set(now.map((l) => l.id));
      const events = group
        .filter((l) => done.has(l.id) && from !== to)
        .map((l) => this.row({ ...opts, orgId: l.orgId, leadId: l.id, type: 'status_changed' }, { from, to }));
      if (events.length) await db.leadEvent.createMany({ data: events });
      moved.push(...done);
    }
    return moved;
  }

  /** Logs a decision that is not a status change: a step sent, held or skipped, a call ended. */
  async record(event: LeadEventInput, db: Db = this.prisma): Promise<void> {
    await db.leadEvent.create({ data: this.row(event) });
  }

  /** For bookkeeping that must never fail the work it describes. */
  quietly(event: LeadEventInput): void {
    this.record(event).catch((error) => this.logger.warn(`lead event ${event.type} for ${event.leadId}: ${(error as Error).message}`));
  }

  private row(e: LeadEventInput, status?: { from: LeadStatus; to: LeadStatus }): Prisma.LeadEventCreateManyInput {
    const actor = e.actor ?? SYSTEM;
    return {
      orgId: e.orgId,
      leadId: e.leadId,
      type: e.type,
      fromStatus: status?.from ?? null,
      toStatus: status?.to ?? null,
      reason: e.reason ? e.reason.slice(0, 2000) : null,
      channel: e.channel ?? null,
      source: e.source.slice(0, 30),
      actorType: actor.type,
      actorId: actor.id ?? null,
      callId: e.callId ?? null,
      payload: e.payload,
    };
  }
}
