import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '@/auth/auth.types';
import { AppError } from '@/common/errors/app-error';
import type { AssistantEvent } from './assistant-orchestrator.service';
import { AssistantService } from './assistant.service';

const auth: AuthContext = { userId: 'user-1', organizationId: 'org-1', sessionId: 's', roleIds: [], permissions: [] };

function setup(opts: { awaitingResults?: boolean; abortWith?: 'timeout' | 'stopped'; officeEnabled?: boolean } = {}) {
  const controller = new AbortController();
  const lock = { release: vi.fn(async () => undefined) };
  const turn = { signal: controller.signal, dispose: vi.fn() };
  const limits = {
    consume: vi.fn(async () => undefined),
    lockThread: vi.fn(async () => lock),
    turnSignal: vi.fn(async () => turn),
    requestStop: vi.fn(async () => undefined),
  };
  const threads = {
    create: vi.fn(async () => ({ id: 'thread-1', title: 'Hot leads', messageCount: 0 })),
    require: vi.fn(async (a: AuthContext, id: string) => {
      if (a.userId !== 'user-1') throw new AppError('NOT_FOUND', 'No such chat.');
      return { id, title: 'Hot leads', messageCount: 4 };
    }),
    append: vi.fn(async () => ({ id: 'msg-1' })),
  };
  const actions = {
    closeOpenCalls: vi.fn(async () => false),
    awaitingResults: vi.fn(async () => opts.awaitingResults ?? false),
  };
  const orchestrator = {
    run: vi.fn(async () => {
      if (opts.abortWith) controller.abort(opts.abortWith);
    }),
  };
  const service = new AssistantService(
    { enabled: true } as any,
    { user: { findFirst: vi.fn(async () => ({ firstName: 'Sarah', lastName: 'Owens', email: 's@x.test', timezone: 'America/Chicago' })) } } as any,
    { assertFeature: vi.fn(async () => undefined) } as any,
    limits as any,
    { assertWithinBudget: vi.fn(async () => undefined) } as any,
    threads as any,
    actions as any,
    orchestrator as any,
    { forThread: () => ({ issue: vi.fn(async (_kind: string, ids: string[]) => new Map(ids.map((id) => [id, 'U1']))) }) } as any,
    { get: vi.fn(async () => ({ enabled: opts.officeEnabled ?? true, monthlyLimitUsd: null, voiceEnabled: true })) } as any,
  );
  const events: AssistantEvent[] = [];
  const stream = { send: (e: AssistantEvent) => events.push(e) };
  return { service, limits, lock, turn, threads, actions, orchestrator, events, stream };
}

describe('AssistantService: the office switch', () => {
  it('refuses a new message once an owner has turned the assistant off for the office', async () => {
    const s = setup({ officeEnabled: false });
    await expect(s.service.send(auth, { text: 'Hi' } as any, s.stream as any)).rejects.toMatchObject({ code: 'ASSISTANT_OFF_FOR_OFFICE' });
    expect(s.threads.create).not.toHaveBeenCalled();
  });
});

describe('AssistantService.send', () => {
  it('stores the message with its context block and runs the turn', async () => {
    const s = setup();
    await s.service.send(auth, { text: 'Which hot leads came in today?', threadId: 'thread-1' } as any, s.stream as any);
    expect(s.threads.append).toHaveBeenCalledWith('org-1', 'thread-1', expect.objectContaining({ role: 'user', text: 'Which hot leads came in today?' }));
    const content = (s.threads.append.mock.calls[0] as any[])[2].content;
    expect(content[0].text).toContain("user's time zone: America/Chicago");
    // The model knows the user by their ref in this chat, never by their id.
    expect(content[0].text).toContain('User: Sarah Owens (U1)');
    expect(content[0].text).not.toContain('user-1');
    expect(s.orchestrator.run).toHaveBeenCalledWith(auth, 'thread-1', expect.any(Function), s.turn.signal);
    expect(s.lock.release).toHaveBeenCalled();
    expect(s.turn.dispose).toHaveBeenCalled();
  });

  it('refuses a new message while the chat still ends in a step with no result, instead of breaking the history', async () => {
    const s = setup({ awaitingResults: true });
    await expect(s.service.send(auth, { text: 'hello', threadId: 'thread-1' } as any, s.stream as any)).rejects.toMatchObject({
      code: 'ASSISTANT_BUSY',
    });
    expect(s.threads.append).not.toHaveBeenCalled();
    expect(s.orchestrator.run).not.toHaveBeenCalled();
    // The chat is not left locked.
    expect(s.lock.release).toHaveBeenCalled();
    expect(s.turn.dispose).toHaveBeenCalled();
  });

  it('tells the user when the turn hit the time limit', async () => {
    const s = setup({ abortWith: 'timeout' });
    await s.service.send(auth, { text: 'hello', threadId: 'thread-1' } as any, s.stream as any);
    expect(s.events).toContainEqual(expect.objectContaining({ type: 'error', code: 'ASSISTANT_TIMEOUT' }));
    expect(s.events.at(-1)).toEqual({ type: 'done', awaitingConfirmation: false });
  });

  it('closes the stream without an error when the user pressed Stop', async () => {
    const s = setup({ abortWith: 'stopped' });
    await s.service.send(auth, { text: 'hello', threadId: 'thread-1' } as any, s.stream as any);
    expect(s.events.some((e) => e.type === 'error')).toBe(false);
    expect(s.events.at(-1)).toEqual({ type: 'done', awaitingConfirmation: false });
  });
});

describe('AssistantService.stop', () => {
  it("asks the running turn to stop in the user's own chat", async () => {
    const s = setup();
    await s.service.stop(auth, 'thread-1');
    expect(s.limits.requestStop).toHaveBeenCalledWith('thread-1');
  });

  it("cannot stop someone else's chat", async () => {
    const s = setup();
    await expect(s.service.stop({ ...auth, userId: 'user-2' }, 'thread-1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(s.limits.requestStop).not.toHaveBeenCalled();
  });
});
