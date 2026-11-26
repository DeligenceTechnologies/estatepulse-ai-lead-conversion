import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AuthContext } from '@/auth/auth.types';
import { AssistantActionService } from './assistant-action.service';

const ORG = 'org-1';
const V1 = new Date('2026-11-25T10:00:00Z');
const V2 = new Date('2026-11-25T10:05:00Z');

const auth = (permissions: string[] = ['lead.update'], userId = 'user-1'): AuthContext => ({
  userId,
  organizationId: ORG,
  sessionId: 'sess-1',
  roleIds: [],
  permissions,
});

/** Just enough of Prisma's `where` for these queries: equality and `{ in: [...] }`. */
const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
  Object.entries(where).every(([k, v]) =>
    v !== null && typeof v === 'object' && !(v instanceof Date) && 'in' in v ? (v as { in: unknown[] }).in.includes(row[k]) : row[k] === v,
  );

function fakePrisma() {
  const rows: Record<string, any>[] = [];
  let n = 0;
  const find = (where: Record<string, unknown>) => rows.filter((r) => matches(r, where));
  return {
    rows,
    assistantAction: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `act-${++n}`,
          preview: null,
          result: null,
          error: null,
          expiresAt: null,
          decidedAt: null,
          entityType: null,
          entityId: null,
          entityVersion: null,
          createdAt: new Date(),
          ...data,
        };
        rows.push(row);
        return { ...row };
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const row = find(where)[0];
        return row ? { ...row } : null;
      }),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => find(where).map((r) => ({ ...r }))),
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => find(where).length),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hit = find(where);
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      }),
      update: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const row = find(where)[0];
        Object.assign(row, data);
        return { ...row };
      }),
    },
  };
}

function fakeThreads() {
  const messages: { id: string; role: 'user' | 'assistant'; content: any[] }[] = [];
  return {
    messages,
    lastMessage: vi.fn(async () => messages.at(-1) ?? null),
    append: vi.fn(async (_org: string, _thread: string, input: { role: 'user' | 'assistant'; content: any[] }) => {
      const m = { id: `msg-${messages.length + 1}`, role: input.role, content: input.content };
      messages.push(m);
      return { id: m.id };
    }),
  };
}

function setup() {
  const prisma = fakePrisma();
  const threads = fakeThreads();
  const audit = { quietly: vi.fn() };
  let currentVersion: Date | null = V1;

  const search = {
    name: 'lead_search',
    tier: 'read' as const,
    label: 'Searching leads',
    description: '',
    permissions: [],
    input: z.object({ query: z.string() }).strict(),
    run: vi.fn(async () => ({ total: 1 })),
  };
  const update = {
    name: 'lead_update',
    tier: 'write' as const,
    label: 'Preparing lead update',
    description: '',
    permissions: ['lead.update'],
    input: z.object({ leadId: z.string(), firstName: z.string() }).strict(),
    preview: vi.fn(async () => ({
      title: 'Update Maria Lopez',
      changes: [{ field: 'First name', from: 'Maria', to: 'Mariah' }],
      entity: { type: 'lead' as const, id: 'lead-1', version: currentVersion ?? V1 },
    })),
    run: vi.fn(async () => ({ updated: ['firstName'] })),
  };
  const tools: Record<string, any> = { lead_search: search, lead_update: update };
  const registry = {
    get: (name: string) => tools[name],
    allows: (a: AuthContext, t: { permissions: string[] }) => t.permissions.every((p) => a.permissions.includes(p)),
    entityVersion: vi.fn(async () => currentVersion),
  };
  /** Each chat gets its own ref table; the tool must be handed the one of the chat the call came from. */
  const refs = { forThread: vi.fn((_a: AuthContext, threadId: string) => ({ threadId, resolve: vi.fn(), issue: vi.fn() })) };
  const bulkRunner = { start: vi.fn() };
  const service = new AssistantActionService(prisma as any, registry as any, threads as any, audit as any, refs as any, bulkRunner as any);

  /** The model's message that asked for these tool calls, as the orchestrator stores it before calling handle(). */
  const modelAsked = async (calls: { id: string; name: string; input: unknown }[]) => {
    const saved = await threads.append(ORG, 'thread-1', { role: 'assistant', content: calls.map((c) => ({ type: 'tool_use', ...c })) });
    return saved.id;
  };
  const propose = async (a = auth()) => {
    const messageId = await modelAsked([{ id: 'tu-1', name: 'lead_update', input: { leadId: 'lead-1', firstName: 'Mariah' } }]);
    return service.handle(a, 'thread-1', messageId, { id: 'tu-1', name: 'lead_update', input: { leadId: 'lead-1', firstName: 'Mariah' } });
  };
  const setVersion = (v: Date | null) => {
    currentVersion = v;
  };
  return { service, prisma, threads, audit, refs, search, update, registry, modelAsked, propose, setVersion };
}

describe('AssistantActionService.handle', () => {
  it('runs a read at once and stores its result', async () => {
    const s = setup();
    const messageId = await s.modelAsked([{ id: 'tu-1', name: 'lead_search', input: { query: 'Maria' } }]);
    const action = await s.service.handle(auth(), 'thread-1', messageId, { id: 'tu-1', name: 'lead_search', input: { query: 'Maria' } });
    expect(action).toMatchObject({ tier: 'read', status: 'executed', result: { total: 1 } });
    expect(s.search.run).toHaveBeenCalledOnce();
  });

  it('turns a write into a proposal and does not run it', async () => {
    const s = setup();
    const action = await s.propose();
    expect(action).toMatchObject({ tier: 'write', status: 'proposed', entityType: 'lead', entityId: 'lead-1', entityVersion: V1 });
    expect(action.preview).toMatchObject({ title: 'Update Maria Lopez' });
    expect(action.expiresAt!.getTime() - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(s.update.run).not.toHaveBeenCalled();
  });

  it('refuses a tool the user lacks the permission for, without previewing or running it', async () => {
    const s = setup();
    const action = await s.propose(auth([]));
    expect(action).toMatchObject({ status: 'failed', error: 'This tool is not available to this user.' });
    expect(s.update.preview).not.toHaveBeenCalled();
    expect(s.update.run).not.toHaveBeenCalled();
  });

  it('refuses a tool that does not exist', async () => {
    const s = setup();
    const messageId = await s.modelAsked([{ id: 'tu-1', name: 'delete_everything', input: {} }]);
    const action = await s.service.handle(auth(), 'thread-1', messageId, { id: 'tu-1', name: 'delete_everything', input: {} });
    expect(action).toMatchObject({ status: 'failed', error: 'This tool is not available to this user.' });
  });

  it('refuses input that does not match the schema, including extra fields', async () => {
    const s = setup();
    const messageId = await s.modelAsked([{ id: 'tu-1', name: 'lead_search', input: { query: 'Maria', orgId: 'org-2' } }]);
    const action = await s.service.handle(auth(), 'thread-1', messageId, { id: 'tu-1', name: 'lead_search', input: { query: 'Maria', orgId: 'org-2' } });
    expect(action.status).toBe('failed');
    expect(action.error).toMatch(/^Invalid input/);
    expect(s.search.run).not.toHaveBeenCalled();
  });
});

describe('AssistantActionService: refs', () => {
  it("a read runs with the refs of its own chat", async () => {
    const s = setup();
    const messageId = await s.modelAsked([{ id: 'tu-1', name: 'lead_search', input: { query: 'Maria' } }]);
    await s.service.handle(auth(), 'thread-1', messageId, { id: 'tu-1', name: 'lead_search', input: { query: 'Maria' } });
    expect(s.search.run).toHaveBeenCalledWith(expect.objectContaining({ refs: expect.objectContaining({ threadId: 'thread-1' }) }), { query: 'Maria' });
  });

  it("a confirmed write resolves its refs in the chat that proposed it, as the user confirming", async () => {
    const s = setup();
    const proposed = await s.propose();
    await s.service.confirm(auth(), proposed.id);
    expect(s.refs.forThread).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 'user-1' }), 'thread-1');
    expect(s.update.run).toHaveBeenCalledWith(expect.objectContaining({ refs: expect.objectContaining({ threadId: 'thread-1' }) }), expect.anything());
  });

  it('a card whose input no longer fits the tool (changed by a deploy) is closed, not run', async () => {
    const s = setup();
    const proposed = await s.propose();
    s.prisma.rows[0].input = { leadId: 'lead-1', firstName: 'Mariah', extra: true };
    await expect(s.service.confirm(auth(), proposed.id)).rejects.toMatchObject({ code: 'ACTION_STALE' });
    expect(s.prisma.rows[0].status).toBe('failed');
    expect(s.update.run).not.toHaveBeenCalled();
  });
});

describe('AssistantActionService.confirm', () => {
  it('runs the write once, records it as done and writes an audit row as the AI on behalf of the user', async () => {
    const s = setup();
    const proposed = await s.propose();
    const done = await s.service.confirm(auth(), proposed.id);
    expect(done).toMatchObject({ status: 'executed', result: { updated: ['firstName'] } });
    expect(s.update.run).toHaveBeenCalledOnce();
    expect(s.audit.quietly).toHaveBeenCalledWith(expect.objectContaining({ actorType: 'ai', actorId: 'user-1', action: 'assistant.lead_update' }));
  });

  it('runs only once when two confirms race (double click, two tabs)', async () => {
    const s = setup();
    const proposed = await s.propose();
    const results = await Promise.allSettled([s.service.confirm(auth(), proposed.id), s.service.confirm(auth(), proposed.id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'ACTION_DECIDED' } });
    expect(s.update.run).toHaveBeenCalledOnce();
  });

  it('refuses a second confirm after the first finished', async () => {
    const s = setup();
    const proposed = await s.propose();
    await s.service.confirm(auth(), proposed.id);
    await expect(s.service.confirm(auth(), proposed.id)).rejects.toMatchObject({ code: 'ACTION_DECIDED' });
    expect(s.update.run).toHaveBeenCalledOnce();
  });

  it('refuses an expired card and marks it expired', async () => {
    const s = setup();
    const proposed = await s.propose();
    s.prisma.rows[0].expiresAt = new Date(Date.now() - 1000);
    await expect(s.service.confirm(auth(), proposed.id)).rejects.toMatchObject({ code: 'ACTION_EXPIRED' });
    expect(s.prisma.rows[0].status).toBe('expired');
    expect(s.update.run).not.toHaveBeenCalled();
  });

  it('refuses when the user lost the permission between the card and the click', async () => {
    const s = setup();
    const proposed = await s.propose();
    await expect(s.service.confirm(auth([]), proposed.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(s.prisma.rows[0].status).toBe('failed');
    expect(s.update.run).not.toHaveBeenCalled();
  });

  it('does not apply a card built on a lead that changed since; it refreshes the card instead', async () => {
    const s = setup();
    const proposed = await s.propose();
    s.setVersion(V2);
    await expect(s.service.confirm(auth(), proposed.id)).rejects.toMatchObject({ code: 'ACTION_STALE' });
    expect(s.prisma.rows[0]).toMatchObject({ status: 'proposed', entityVersion: V2 });
    expect(s.update.run).not.toHaveBeenCalled();
    // Confirming the refreshed card works.
    await s.service.confirm(auth(), proposed.id);
    expect(s.update.run).toHaveBeenCalledOnce();
  });

  it("does not let another user confirm someone's card", async () => {
    const s = setup();
    const proposed = await s.propose();
    await expect(s.service.confirm(auth(['lead.update'], 'user-2'), proposed.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(s.update.run).not.toHaveBeenCalled();
  });

  it('records a failure when the service refuses the write', async () => {
    const s = setup();
    s.update.run.mockRejectedValueOnce(new Error('boom'));
    const proposed = await s.propose();
    const failed = await s.service.confirm(auth(), proposed.id);
    expect(failed).toMatchObject({ status: 'failed', error: 'Something went wrong running this step.' });
  });
});

describe('AssistantActionService.reject', () => {
  it('declines an open card and nothing runs', async () => {
    const s = setup();
    const proposed = await s.propose();
    const rejected = await s.service.reject(auth(), proposed.id);
    expect(rejected.status).toBe('rejected');
    expect(s.update.run).not.toHaveBeenCalled();
  });

  it('cannot decline a card that already ran', async () => {
    const s = setup();
    const proposed = await s.propose();
    await s.service.confirm(auth(), proposed.id);
    await expect(s.service.reject(auth(), proposed.id)).rejects.toMatchObject({ code: 'ACTION_DECIDED' });
  });
});

describe('AssistantActionService.closeOpenCalls', () => {
  it('declines open cards when the user moves on, and gives every tool call a result', async () => {
    const s = setup();
    await s.propose();
    expect(await s.service.awaitingResults(ORG, 'thread-1')).toBe(true);

    expect(await s.service.closeOpenCalls(auth(), 'thread-1', true)).toBe(true);
    expect(s.prisma.rows[0].status).toBe('rejected');
    const last = s.threads.messages.at(-1)!;
    expect(last.role).toBe('user');
    expect(last.content).toEqual([expect.objectContaining({ type: 'tool_result', tool_use_id: 'tu-1', is_error: true })]);
    expect(await s.service.awaitingResults(ORG, 'thread-1')).toBe(false);
  });

  it('leaves an open card alone when the user has not moved on', async () => {
    const s = setup();
    await s.propose();
    expect(await s.service.closeOpenCalls(auth(), 'thread-1', false)).toBe(false);
    expect(s.prisma.rows[0].status).toBe('proposed');
    expect(s.threads.messages).toHaveLength(1);
  });

  it('waits on a write that is still running, so its result is not lost', async () => {
    const s = setup();
    await s.propose();
    Object.assign(s.prisma.rows[0], { status: 'executing', decidedAt: new Date() });
    expect(await s.service.closeOpenCalls(auth(), 'thread-1', true)).toBe(false);
    // The chat still ends in a call with no result, which is what makes send() refuse a new message.
    expect(await s.service.awaitingResults(ORG, 'thread-1')).toBe(true);
  });

  it('gives up on a write stuck running after a crash, and says its outcome is unknown', async () => {
    const s = setup();
    await s.propose();
    Object.assign(s.prisma.rows[0], { status: 'executing', decidedAt: new Date(Date.now() - 3 * 60_000) });
    expect(await s.service.closeOpenCalls(auth(), 'thread-1', true)).toBe(true);
    expect(s.prisma.rows[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('unknown') });
    expect(await s.service.awaitingResults(ORG, 'thread-1')).toBe(false);
  });

  it('answers a tool call that never got an action row, so the history stays valid', async () => {
    const s = setup();
    await s.modelAsked([{ id: 'tu-9', name: 'lead_search', input: { query: 'x' } }]);
    expect(await s.service.closeOpenCalls(auth(), 'thread-1', false)).toBe(true);
    expect(s.threads.messages.at(-1)!.content).toEqual([
      expect.objectContaining({ type: 'tool_result', tool_use_id: 'tu-9', is_error: true, content: 'This step did not run.' }),
    ]);
  });
});
