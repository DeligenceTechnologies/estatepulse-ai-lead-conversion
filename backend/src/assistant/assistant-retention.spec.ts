import { describe, expect, it, vi } from 'vitest';
import { AssistantRetentionService, CHAT_RETENTION_DAYS } from './assistant-retention.service';

const NOW = new Date('2026-11-26T12:00:00Z');
const CUTOFF = new Date(NOW.getTime() - CHAT_RETENTION_DAYS * 86_400_000);

function setup(batches: string[][]) {
  const queue = [...batches];
  const prisma = {
    assistantThread: {
      findMany: vi.fn(async () => (queue.shift() ?? []).map((id) => ({ id }))),
      deleteMany: vi.fn(async ({ where }: any) => ({ count: where.id.in.length })),
    },
  };
  return { prisma, service: new AssistantRetentionService(prisma as any) };
}

describe('chat retention', () => {
  it('deletes chats with no message for 90 days, except one whose bulk job is still running', async () => {
    const s = setup([['t-old-1', 't-old-2']]);
    expect(await s.service.sweep(NOW)).toBe(2);
    const expired = { lastMessageAt: { lt: CUTOFF }, actions: { none: { bulkStatus: { in: ['queued', 'running'] } } } };
    expect(s.prisma.assistantThread.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expired }));
    // The delete repeats the condition, so a chat that got a message in between is kept.
    expect(s.prisma.assistantThread.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['t-old-1', 't-old-2'] }, ...expired } });
  });

  it('works through a backlog in batches of 200, and does nothing when nothing is old', async () => {
    const full = Array.from({ length: 200 }, (_, i) => `t-${i}`);
    const s = setup([full, ['t-last']]);
    expect(await s.service.sweep(NOW)).toBe(201);
    expect(s.prisma.assistantThread.deleteMany).toHaveBeenCalledTimes(2);
    const none = setup([]);
    expect(await none.service.sweep(NOW)).toBe(0);
    expect(none.prisma.assistantThread.deleteMany).not.toHaveBeenCalled();
  });

  it('a database error is logged, not thrown, and the next sweep runs again', async () => {
    const s = setup([['t-1']]);
    s.prisma.assistantThread.findMany.mockRejectedValueOnce(new Error('db down'));
    expect(await s.service.sweep(NOW)).toBe(0);
    expect(await s.service.sweep(NOW)).toBe(1);
  });
});
