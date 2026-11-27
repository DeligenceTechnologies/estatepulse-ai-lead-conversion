import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '@/auth/auth.types';
import { AssistantThreadService } from './assistant-thread.service';

const ORG = 'org-1';
const me: AuthContext = { userId: 'user-1', organizationId: ORG, sessionId: 's', roleIds: [], permissions: ['assistant.use'] };
const someoneElse: AuthContext = { ...me, userId: 'user-2' };

/** One chat of user-1 with a question (msg-q) and an answer (msg-a). */
function setup() {
  const messages = [
    { id: 'msg-q', threadId: 'thread-1', role: 'user', content: [], text: 'Which leads are hot?', createdAt: new Date() },
    { id: 'msg-a', threadId: 'thread-1', role: 'assistant', content: [{ type: 'text', text: 'Maria Lopez [L1].' }], text: null, createdAt: new Date() },
  ];
  let stored: Record<string, unknown> | null = null;
  const prisma = {
    assistantThread: {
      findFirst: vi.fn(async ({ where }: any) => (where.id === 'thread-1' && where.userId === 'user-1' ? { id: 'thread-1', title: 'Hot leads' } : null)),
    },
    assistantMessage: {
      findFirst: vi.fn(async ({ where }: any) => messages.find((m) => m.id === where.id && m.role === where.role) ?? null),
      findMany: vi.fn(async () => messages),
    },
    assistantAction: { findMany: vi.fn(async () => []) },
    assistantFeedback: {
      upsert: vi.fn(async ({ create, update }: any) => (stored = { ...(stored ?? create), ...update })),
      deleteMany: vi.fn(async () => ((stored = null), { count: 1 })),
      findMany: vi.fn(async () => (stored ? [{ messageId: 'msg-a', ...stored }] : [])),
    },
  };
  const refs = { inspect: vi.fn(async () => ({ links: {}, madeUp: [] })) };
  return { prisma, service: new AssistantThreadService(prisma as any, refs as any) };
}

describe('rating an answer', () => {
  it('a thumbs down keeps its reason and comment, and shows on the answer in the chat', async () => {
    const s = setup();
    expect(await s.service.rate(me, 'msg-a', { rating: 'down', reason: 'wrong', comment: '  Maria is cold, not hot. ' })).toEqual({
      rating: 'down',
      reason: 'wrong',
      comment: 'Maria is cold, not hot.',
    });
    expect(s.prisma.assistantFeedback.upsert).toHaveBeenCalledWith({
      where: { messageId: 'msg-a' },
      create: { orgId: ORG, threadId: 'thread-1', messageId: 'msg-a', rating: 'down', reason: 'wrong', comment: 'Maria is cold, not hot.' },
      update: { rating: 'down', reason: 'wrong', comment: 'Maria is cold, not hot.' },
    });
    const view = await s.service.view(me, 'thread-1');
    expect(view.messages.find((m) => m.id === 'msg-a')?.feedback).toEqual({ rating: 'down', reason: 'wrong', comment: 'Maria is cold, not hot.' });
    expect(view.messages.find((m) => m.id === 'msg-q')?.feedback).toBeUndefined();
  });

  it('changing to a thumbs up drops the reason and comment; null takes the rating back', async () => {
    const s = setup();
    await s.service.rate(me, 'msg-a', { rating: 'down', reason: 'other', comment: 'meh' });
    expect(await s.service.rate(me, 'msg-a', { rating: 'up', reason: 'wrong', comment: 'ignored' })).toEqual({ rating: 'up', reason: null, comment: null });
    expect(await s.service.rate(me, 'msg-a', { rating: null })).toBeNull();
    expect(s.prisma.assistantFeedback.deleteMany).toHaveBeenCalledWith({ where: { messageId: 'msg-a' } });
  });

  it("only the chat's own person can rate, and only answers", async () => {
    const s = setup();
    await expect(s.service.rate(someoneElse, 'msg-a', { rating: 'up' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(s.service.rate(me, 'msg-q', { rating: 'up' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(s.prisma.assistantFeedback.upsert).not.toHaveBeenCalled();
  });
});
