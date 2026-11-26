import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '@/auth/auth.types';
import { AssistantOrchestrator, type AssistantEvent } from './assistant-orchestrator.service';
import type { ModelTurn } from './providers/model-provider';

const auth: AuthContext = { userId: 'user-1', organizationId: 'org-1', sessionId: 's', roleIds: [], permissions: ['lead.update'] };
const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

const answer = (text: string): ModelTurn => ({ content: [{ type: 'text', text }], toolCalls: [], stop: 'end', model: 'test-model', usage });
const asks = (...calls: { id: string; name: string }[]): ModelTurn => ({
  content: calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: {} })),
  toolCalls: calls.map((c) => ({ ...c, input: {} })),
  stop: 'tool_use',
  model: 'test-model',
  usage,
});

function setup(turns: ModelTurn[], opts: { proposeWrites?: boolean; inspect?: { links: Record<string, unknown>; madeUp: string[] } } = {}) {
  const script = [...turns];
  const provider = {
    name: 'claude' as const,
    complete: vi.fn(async ({ onText }: { onText: (t: string) => void }) => {
      const turn = script.length > 1 ? script.shift()! : script[0];
      for (const b of turn.content) if (b.type === 'text') onText(b.text as string);
      return turn;
    }),
    describe: () => null,
  };
  const registry = {
    definitionsFor: vi.fn(() => []),
    get: (name: string) => ({ name, label: name === 'lead_update' ? 'Preparing lead update' : 'Searching leads' }),
  };
  const threads = {
    history: vi.fn(async () => []),
    append: vi.fn(async () => ({ id: 'msg-1' })),
  };
  const actions = {
    handle: vi.fn(async (_a: AuthContext, _t: string, messageId: string, call: { id: string; name: string }) => {
      const write = call.name === 'lead_update';
      return {
        id: `act-${call.id}`,
        messageId,
        toolName: call.name,
        tier: write ? 'write' : 'read',
        status: write && opts.proposeWrites !== false ? 'proposed' : 'executed',
        preview: write ? { title: 'Update lead' } : null,
        error: null,
        expiresAt: null,
        decidedAt: null,
      };
    }),
    closeOpenCalls: vi.fn(async () => true),
  };
  const usageService = { assertWithinBudget: vi.fn(async () => undefined), record: vi.fn(async () => undefined), countMadeUpRefs: vi.fn(async () => undefined) };
  const refs = { inspect: vi.fn(async () => opts.inspect ?? { links: {}, madeUp: [] }) };
  const orchestrator = new AssistantOrchestrator(provider as any, registry as any, threads as any, actions as any, usageService as any, refs as any);
  const events: AssistantEvent[] = [];
  const run = (signal = new AbortController().signal) => orchestrator.run(auth, 'thread-1', (e) => events.push(e), signal);
  return { orchestrator, provider, threads, actions, usageService, refs, events, run };
}

describe('AssistantOrchestrator', () => {
  it('streams a plain answer, stores it, records usage and finishes', async () => {
    const s = setup([answer('You have 3 hot leads.')]);
    await s.run();
    expect(s.events).toEqual([
      { type: 'text', text: 'You have 3 hot leads.' },
      { type: 'done', awaitingConfirmation: false },
    ]);
    expect(s.threads.append).toHaveBeenCalledOnce();
    expect(s.usageService.record).toHaveBeenCalledWith('org-1', 'test-model', usage);
  });

  it('runs a look-up, hands its result back and lets the model answer', async () => {
    const s = setup([asks({ id: 'tu-1', name: 'lead_search' }), answer('Found Maria.')]);
    await s.run();
    expect(s.provider.complete).toHaveBeenCalledTimes(2);
    expect(s.actions.closeOpenCalls).toHaveBeenCalledWith(auth, 'thread-1', false);
    expect(s.events.map((e) => e.type)).toEqual(['tool.started', 'tool.finished', 'text', 'done']);
    expect(s.events[0]).toMatchObject({ tool: 'lead_search', label: 'Searching leads' });
  });

  it('stops and waits for the user when a write needs confirming', async () => {
    const s = setup([asks({ id: 'tu-1', name: 'lead_search' }, { id: 'tu-2', name: 'lead_update' })]);
    await s.run();
    expect(s.provider.complete).toHaveBeenCalledOnce();
    expect(s.actions.handle).toHaveBeenCalledTimes(2); // both calls of the message are handled, not just the first
    expect(s.events.find((e) => e.type === 'action')).toMatchObject({ action: { tool: 'lead_update', status: 'proposed' } });
    expect(s.events.at(-1)).toEqual({ type: 'done', awaitingConfirmation: true });
    expect(s.actions.closeOpenCalls).not.toHaveBeenCalled();
  });

  it('says so when the model declines, and runs no tools', async () => {
    const s = setup([{ ...answer(''), stop: 'refusal' }]);
    await s.run();
    expect(s.events).toContainEqual(expect.objectContaining({ type: 'error', code: 'ASSISTANT_DECLINED' }));
    expect(s.actions.handle).not.toHaveBeenCalled();
  });

  it('gives up after 8 model calls instead of looping forever', async () => {
    const s = setup([asks({ id: 'tu-1', name: 'lead_search' })]);
    await s.run();
    expect(s.provider.complete).toHaveBeenCalledTimes(8);
    expect(s.events).toContainEqual(expect.objectContaining({ type: 'error', code: 'ASSISTANT_STEP_LIMIT' }));
  });

  it('checks the monthly budget before every model call', async () => {
    const s = setup([answer('ok')]);
    s.usageService.assertWithinBudget.mockRejectedValueOnce(Object.assign(new Error('over'), { code: 'ASSISTANT_BUDGET_EXCEEDED' }));
    await expect(s.run()).rejects.toMatchObject({ code: 'ASSISTANT_BUDGET_EXCEEDED' });
    expect(s.provider.complete).not.toHaveBeenCalled();
  });

  it('ends quietly when the turn was stopped while the model was answering', async () => {
    const s = setup([answer('never seen')]);
    const controller = new AbortController();
    s.provider.complete.mockImplementationOnce(async () => {
      controller.abort('stopped');
      throw new Error('aborted');
    });
    await expect(s.run(controller.signal)).resolves.toBeUndefined();
    expect(s.threads.append).not.toHaveBeenCalled();
  });

  it('refuses to run when no model is configured', async () => {
    const s = setup([answer('x')]);
    const off = new AssistantOrchestrator(null, {} as any, {} as any, {} as any, {} as any, {} as any);
    await expect(off.run(auth, 'thread-1', () => undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'ASSISTANT_DISABLED' });
    expect(s.provider.complete).not.toHaveBeenCalled();
  });
});

describe('leads named in an answer', () => {
  it('sends their links before the turn ends, and counts refs the model made up', async () => {
    const link = { kind: 'lead', id: 'lead-maria', name: 'Maria Lopez' };
    const t = setup([answer('Maria Lopez [L1] is warm. Also [L9].')], { inspect: { links: { L1: link }, madeUp: ['L9'] } });
    await t.run();
    expect(t.refs.inspect).toHaveBeenCalledWith(auth, 'thread-1', 'Maria Lopez [L1] is warm. Also [L9].');
    const types = t.events.map((e) => e.type);
    expect(types.indexOf('refs')).toBeLessThan(types.indexOf('done'));
    expect(t.events).toContainEqual({ type: 'refs', refs: { L1: link } });
    expect(t.usageService.countMadeUpRefs).toHaveBeenCalledWith('org-1', 1);
  });

  it('skips the look-up when the answer names nothing, and a failed look-up never fails the turn', async () => {
    const plain = setup([answer('You have 6 new leads.')]);
    await plain.run();
    expect(plain.refs.inspect).not.toHaveBeenCalled();
    const broken = setup([answer('Maria Lopez [L1].')]);
    broken.refs.inspect.mockRejectedValueOnce(new Error('db down'));
    await broken.run();
    expect(broken.events.at(-1)).toEqual({ type: 'done', awaitingConfirmation: false });
  });
});

