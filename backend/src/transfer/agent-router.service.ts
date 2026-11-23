import { Injectable } from '@nestjs/common';
import { CalendarMeetingStatus, Prisma, TransferAttemptStatus } from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';
import { AGENT_ROLE_WHERE, fullName } from '@/lead/lead-scope';
import { activeLeadsOf } from '@/lead/lead-assignment.service';
import { normalizePhone } from '@/telnyx/phone';
import { coversArea, withinWorkingHours } from './live-transfer';

export interface PickRequest {
  orgId: string;
  transferId: string;
  /** 1 for the first agent rung, 2 for the next… */
  position: number;
  leadLocation: string | null;
  /** Agents already rung for this transfer. */
  exclude: string[];
  /** The lead's own agent, rung first when they can take it. */
  preferUserId?: string | null;
}

export interface PickedAgent {
  attemptId: string;
  userId: string;
  name: string;
  phone: string;
}

/** An agent still ringing or deciding on another transfer, within this long, is busy. */
const RINGING_STALE_MS = 10 * 60_000;
/** An agent bridged to a lead is busy until that call ends; a hang-up we never heard of stops counting after this. */
const CONNECTED_STALE_MS = 2 * 60 * 60_000;

/**
 * Picks the next agent to ring, just before ringing them, so every check holds at dial time:
 * an agent who went off shift, into a meeting, onto another call or up to their lead cap
 * since the transfer began is passed over.
 *
 * Eligible agents are active users holding the Agent role, opted in to live transfers, with a
 * phone number, covering the lead's area, inside their working hours, not in a meeting on their
 * synced calendar, not ringing or talking on another transfer, and under their lead cap.
 *
 * Round robin: whoever has waited longest since their last transfer goes first (never rung
 * before is first of all). One organization's picks run one at a time, under a transaction-scoped
 * advisory lock, and the pick is stamped and its attempt row written in that same transaction,
 * so two leads transferring at the same moment ring different agents and the turn moves on fairly.
 */
@Injectable()
export class AgentRouterService {
  constructor(private readonly prisma: PrismaService) {}

  async claimNext(req: PickRequest, now = new Date()): Promise<PickedAgent | null> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`agent-round-robin:${req.orgId}`}))`;

        const candidates = await tx.user.findMany({
          where: {
            orgId: req.orgId,
            status: 'active',
            acceptsLiveTransfers: true,
            phone: { not: null },
            id: { notIn: req.exclude },
            roles: { some: { role: AGENT_ROLE_WHERE } },
          },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phone: true,
            timezone: true,
            workingHours: true,
            serviceAreas: true,
            maxActiveLeads: true,
            lastTransferOfferedAt: true,
          },
        });
        const fit = candidates.filter(
          (u) => normalizePhone(u.phone).length >= 8 && coversArea(u.serviceAreas, req.leadLocation) && withinWorkingHours(u.workingHours, u.timezone, now),
        );
        if (!fit.length) return null;
        const ids = fit.map((u) => u.id);

        const [inMeetings, onTransfers, held] = await Promise.all([
          tx.calendarMeeting.findMany({
            where: { hostUserId: { in: ids }, status: CalendarMeetingStatus.scheduled, startsAt: { lte: now }, endsAt: { gt: now } },
            select: { hostUserId: true },
          }),
          tx.transferAttempt.findMany({
            where: {
              userId: { in: ids },
              OR: [
                { status: { in: [TransferAttemptStatus.dialing, TransferAttemptStatus.answered] }, dialedAt: { gt: new Date(now.getTime() - RINGING_STALE_MS) } },
                { status: TransferAttemptStatus.accepted, endedAt: null, dialedAt: { gt: new Date(now.getTime() - CONNECTED_STALE_MS) } },
              ],
            },
            select: { userId: true },
          }),
          Promise.all(fit.map(async (u) => [u.id, await tx.lead.count({ where: activeLeadsOf(req.orgId, u.id) })] as const)),
        ]);
        const busy = new Set<string>([...inMeetings.map((m) => m.hostUserId!), ...onTransfers.map((a) => a.userId)]);
        const load = new Map(held);
        const free = fit.filter((u) => !busy.has(u.id) && (load.get(u.id) ?? 0) < u.maxActiveLeads);
        if (!free.length) return null;

        const waited = (t: Date | null) => t?.getTime() ?? 0;
        free.sort((a, b) => waited(a.lastTransferOfferedAt) - waited(b.lastTransferOfferedAt) || a.id.localeCompare(b.id));
        const pick = free.find((u) => u.id === req.preferUserId) ?? free[0];

        await tx.user.update({ where: { id: pick.id }, data: { lastTransferOfferedAt: now } });
        const phone = normalizePhone(pick.phone);
        const attempt = await tx.transferAttempt.create({
          data: { orgId: req.orgId, transferId: req.transferId, userId: pick.id, position: req.position, phone, dialedAt: now },
          select: { id: true },
        });
        return { attemptId: attempt.id, userId: pick.id, name: fullName(pick.firstName, pick.lastName), phone };
      },
      { maxWait: 10_000, timeout: 15_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }
}
