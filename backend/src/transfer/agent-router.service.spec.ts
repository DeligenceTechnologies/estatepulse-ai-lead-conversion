import { describe, expect, it, vi } from 'vitest';
import { AgentRouterService } from './agent-router.service';

const NOW = new Date('2026-06-01T15:00:00Z'); // Monday, 10:00 in Chicago
const OPEN = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, isAvailable: dayOfWeek >= 1 && dayOfWeek <= 5, startTime: '09:00', endTime: '18:00' }));

const agent = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  firstName: id,
  lastName: 'Agent',
  phone: '+1 (512) 555-0100',
  timezone: 'America/Chicago',
  workingHours: OPEN,
  serviceAreas: [] as string[],
  maxActiveLeads: 10,
  lastTransferOfferedAt: null as Date | null,
  ...over,
});

function setup(users: ReturnType<typeof agent>[], extra: { meetings?: string[]; onCall?: string[]; held?: Record<string, number> } = {}) {
  const tx = {
    $executeRaw: vi.fn(async () => 0),
    user: { findMany: vi.fn(async () => users), update: vi.fn(async () => ({})) },
    calendarMeeting: { findMany: vi.fn(async () => (extra.meetings ?? []).map((hostUserId) => ({ hostUserId }))) },
    transferAttempt: {
      findMany: vi.fn(async () => (extra.onCall ?? []).map((userId) => ({ userId }))),
      create: vi.fn(async () => ({ id: 'attempt-1' })),
    },
    lead: { count: vi.fn(async ({ where }: { where: { assignedToId: string } }) => extra.held?.[where.assignedToId] ?? 0) },
  };
  const prisma = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const router = new AgentRouterService(prisma as any);
  const pick = (over: Record<string, unknown> = {}) =>
    router.claimNext({ orgId: 'org-1', transferId: 'xfer-1', position: 1, leadLocation: 'Austin, TX 78704', exclude: [], ...over }, NOW);
  return { tx, pick };
}

describe('picking the agent to ring', () => {
  it('rings whoever has waited longest since their last transfer, never-rung first, and moves their turn on', async () => {
    const s = setup([
      agent('recent', { lastTransferOfferedAt: new Date('2026-06-01T14:00:00Z') }),
      agent('older', { lastTransferOfferedAt: new Date('2026-05-30T14:00:00Z') }),
      agent('never'),
    ]);
    await expect(s.pick()).resolves.toMatchObject({ userId: 'never', phone: '+15125550100', attemptId: 'attempt-1' });
    expect(s.tx.$executeRaw).toHaveBeenCalled();
    expect(s.tx.user.update).toHaveBeenCalledWith({ where: { id: 'never' }, data: { lastTransferOfferedAt: NOW } });
    expect(s.tx.transferAttempt.create).toHaveBeenCalledWith({
      data: { orgId: 'org-1', transferId: 'xfer-1', userId: 'never', position: 1, phone: '+15125550100', dialedAt: NOW },
      select: { id: true },
    });
  });

  it('passes over agents off shift, outside the lead’s area, in a meeting, on another transfer or at their cap', async () => {
    const s = setup(
      [
        agent('off-shift', { timezone: 'America/Los_Angeles' }), // 08:00 there
        agent('elsewhere', { serviceAreas: ['houston'] }),
        agent('meeting'),
        agent('on-call'),
        agent('full', { maxActiveLeads: 3 }),
        agent('free', { serviceAreas: ['78704'], lastTransferOfferedAt: new Date('2026-06-01T14:59:00Z') }),
      ],
      { meetings: ['meeting'], onCall: ['on-call'], held: { full: 3 } },
    );
    await expect(s.pick()).resolves.toMatchObject({ userId: 'free' });
  });

  it('rings the lead’s own agent first when they can take it, and nobody when nobody can', async () => {
    const s = setup([agent('a'), agent('mine', { lastTransferOfferedAt: NOW })]);
    await expect(s.pick({ preferUserId: 'mine' })).resolves.toMatchObject({ userId: 'mine' });
    const none = setup([agent('no-phone', { phone: '12' })]);
    await expect(none.pick()).resolves.toBeNull();
    expect(none.tx.transferAttempt.create).not.toHaveBeenCalled();
  });
});
