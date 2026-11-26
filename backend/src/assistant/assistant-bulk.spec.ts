import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '@/auth/auth.types';
import { AppError } from '@/common/errors/app-error';
import { AssistantActionService } from './assistant-action.service';
import { AssistantBulkRunner } from './assistant-bulk.runner';

const ORG = 'org-1';
const OWNER = 'owner-1';
const owner: AuthContext = { userId: OWNER, organizationId: ORG, sessionId: 's', roleIds: [], permissions: ['lead.update', 'assistant.bulk'] };

interface Item {
  id: string;
  actionId: string;
  leadId: string;
  position: number;
  status: string;
  reason: string | null;
}

/** An action and its items in memory, enough for the job and the card. */
function store(opts: { total?: number; bulkStatus?: string | null; status?: string; hidden?: string[]; roles?: { isSystem: boolean; permissions: string[] }[] | null } = {}) {
  const total = opts.total ?? 3;
  const action: any = {
    id: 'act-1',
    orgId: ORG,
    userId: OWNER,
    threadId: 'thread-1',
    messageId: 'msg-1',
    toolName: 'leads_outreach_pause',
    tier: 'write',
    status: opts.status ?? 'executed',
    input: { filter: {} },
    preview: { title: `Pause AI outreach to ${total} leads` },
    bulkTotal: total,
    bulkStatus: opts.bulkStatus === undefined ? 'queued' : opts.bulkStatus,
    expiresAt: new Date(Date.now() + 60_000),
  };
  const items: Item[] = Array.from({ length: total }, (_, i) => ({ id: `item-${i}`, actionId: 'act-1', leadId: `lead-${i}`, position: i, status: 'pending', reason: null }));
  const matches = (row: any, where: any) =>
    Object.entries(where).every(([k, v]: [string, any]) => (v && typeof v === 'object' && 'in' in v ? v.in.includes(row[k]) : row[k] === v));
  const db = {
    action,
    items,
    assistantAction: {
      findFirst: vi.fn(async () => ({ ...action })),
      updateMany: vi.fn(async ({ where, data }: any) => {
        if (!matches(action, where)) return { count: 0 };
        Object.assign(action, data);
        return { count: 1 };
      }),
      update: vi.fn(async ({ data }: any) => Object.assign(action, data)),
      create: vi.fn(async ({ data }: any) => Object.assign(action, { id: 'act-1', ...data })),
    },
    assistantActionItem: {
      findMany: vi.fn(async ({ where, take }: any) => items.filter((i) => matches(i, where)).sort((a, b) => a.position - b.position).slice(0, take ?? 1000)),
      update: vi.fn(async ({ where, data }: any) => Object.assign(items.find((i) => i.id === where.id)!, data)),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const hit = items.filter((i) => matches(i, where));
        hit.forEach((i) => Object.assign(i, data));
        return { count: hit.length };
      }),
      createMany: vi.fn(async () => ({ count: 0 })),
      groupBy: vi.fn(async () => {
        const by = new Map<string, number>();
        items.forEach((i) => by.set(i.status, (by.get(i.status) ?? 0) + 1));
        return [...by].map(([status, n]) => ({ status, _count: { _all: n } }));
      }),
    },
    lead: {
      findFirst: vi.fn(async ({ where }: any) => (opts.hidden?.includes(where.id) ? null : { id: where.id })),
      findMany: vi.fn(async ({ where }: any) => where.id.in.map((id: string) => ({ id, firstName: 'Lead', lastName: id.slice(5) }))),
    },
    user: {
      findFirst: vi.fn(async () =>
        opts.roles === null ? null : { roles: (opts.roles ?? [{ isSystem: true, permissions: [] }]).map((role, i) => ({ role: { id: `r${i}`, ...role } })) },
      ),
    },
  };
  return db;
}

function worker(db: ReturnType<typeof store>, runOne: (leadId: string) => Promise<unknown>) {
  const tool = { name: 'leads_outreach_pause', tier: 'write', permissions: ['lead.update'], input: { safeParse: (v: unknown) => ({ success: true, data: v }) }, bulk: { runOne: vi.fn((_c: unknown, _i: unknown, id: string) => runOne(id)) } };
  const registry = { get: () => tool, allows: (a: AuthContext, t: any) => t.permissions.every((p: string) => a.permissions.includes(p)) };
  return { tool, w: new AssistantBulkRunner(db as any, {} as any, registry as any, { forThread: () => ({}) } as any) };
}

describe('the bulk job', () => {
  it('runs every frozen lead once and ends done; a refusal for one lead skips only that lead', async () => {
    const db = store({ total: 30 });
    const { w, tool } = worker(db, async (id) => {
      if (id === 'lead-4') throw new AppError('CONFLICT', 'Outreach is already paused for this lead.');
      return id === 'lead-5' ? { skipped: 'nothing to pause' } : undefined;
    });
    await w.runAction(ORG, 'act-1');
    expect(tool.bulk.runOne).toHaveBeenCalledTimes(30);
    expect(db.items.filter((i) => i.status === 'succeeded')).toHaveLength(28);
    expect(db.items.find((i) => i.leadId === 'lead-4')).toMatchObject({ status: 'skipped', reason: 'Outreach is already paused for this lead.' });
    expect(db.items.find((i) => i.leadId === 'lead-5')).toMatchObject({ status: 'skipped', reason: 'nothing to pause' });
    expect(db.action.bulkStatus).toBe('done');
  });

  it('skips a lead the approver can no longer see, without running it', async () => {
    const db = store({ hidden: ['lead-1'] });
    const { w, tool } = worker(db, async () => undefined);
    await w.runAction(ORG, 'act-1');
    expect(tool.bulk.runOne).toHaveBeenCalledTimes(2);
    expect(db.items[1]).toMatchObject({ status: 'skipped', reason: expect.stringContaining('No longer visible') });
  });

  it('stops after three outside-service failures in a row and leaves the rest not attempted', async () => {
    const db = store({ total: 6 });
    const { w } = worker(db, async () => {
      throw new AppError('UPSTREAM_ERROR', 'Telnyx failed 503');
    });
    await w.runAction(ORG, 'act-1');
    expect(db.items.map((i) => i.status)).toEqual(['failed', 'failed', 'failed', 'not_attempted', 'not_attempted', 'not_attempted']);
    expect(db.action.bulkStatus).toBe('stopped');
  });

  it('honours Stop: nothing more runs and the card stays cancelled', async () => {
    const db = store({ bulkStatus: 'cancelled' });
    const { w, tool } = worker(db, async () => undefined);
    await w.runAction(ORG, 'act-1');
    expect(tool.bulk.runOne).not.toHaveBeenCalled();
    expect(db.items.every((i) => i.status === 'not_attempted' && i.reason?.includes('Stopped by the user'))).toBe(true);
    expect(db.action.bulkStatus).toBe('cancelled');
  });

  it('stops when the approver has lost the permission, or is gone', async () => {
    const lost = store({ total: 12, roles: [{ isSystem: false, permissions: ['lead.update'] }] });
    await worker(lost, async () => undefined).w.runAction(ORG, 'act-1');
    expect(lost.action.bulkStatus).toBe('stopped');
    expect(lost.items.every((i) => i.status === 'not_attempted')).toBe(true);
    const gone = store({ roles: null });
    await worker(gone, async () => undefined).w.runAction(ORG, 'act-1');
    expect(gone.action.bulkStatus).toBe('stopped');
  });

  it('does nothing for a job already finished, or one another server is running', async () => {
    for (const bulkStatus of ['done', 'running']) {
      const db = store({ bulkStatus });
      const { w, tool } = worker(db, async () => undefined);
      await w.runAction(ORG, 'act-1');
      expect(tool.bulk.runOne).not.toHaveBeenCalled();
    }
  });
});

describe('approving a bulk card', () => {
  function service(db: ReturnType<typeof store>) {
    const tool = { name: 'leads_outreach_pause', tier: 'write', permissions: ['lead.update'], input: { safeParse: (v: unknown) => ({ success: true, data: v }) }, bulk: { runOne: vi.fn() } };
    const registry = { get: () => tool, allows: () => true };
    const runner = { start: vi.fn() };
    const svc = new AssistantActionService(db as any, registry as any, {} as any, { quietly: vi.fn() } as any, { forThread: () => ({}) } as any, runner as any);
    return { svc, runner };
  }

  it('above ten leads, needs the typed count; then closes the card as started and starts the job once', async () => {
    const db = store({ total: 12, status: 'proposed', bulkStatus: null });
    const { svc, runner } = service(db);
    await expect(svc.confirm(owner, 'act-1', { count: 11 })).rejects.toMatchObject({ code: 'BULK_COUNT_MISMATCH' });
    expect(runner.start).not.toHaveBeenCalled();
    await svc.confirm(owner, 'act-1', { count: 12 });
    expect(db.action).toMatchObject({ status: 'executed', bulkStatus: 'queued', result: { started: true, total: 12 } });
    expect(runner.start).toHaveBeenCalledWith(ORG, 'act-1');
    // Approving again finds the card already handled.
    await expect(svc.confirm(owner, 'act-1', { count: 12 })).rejects.toMatchObject({ code: 'ACTION_DECIDED' });
    expect(runner.start).toHaveBeenCalledTimes(1);
  });

  it('above ten leads, refuses a user without assistant.bulk', async () => {
    const db = store({ total: 12, status: 'proposed', bulkStatus: null });
    const { svc } = service(db);
    await expect(svc.confirm({ ...owner, permissions: ['lead.update'] }, 'act-1', { count: 12 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('up to ten leads, approves like any card, without a count', async () => {
    const db = store({ total: 4, status: 'proposed', bulkStatus: null });
    const { svc, runner } = service(db);
    await svc.confirm(owner, 'act-1');
    expect(runner.start).toHaveBeenCalledTimes(1);
  });

  it('Stop cancels a running job, and progress counts each outcome', async () => {
    const db = store({ total: 4, bulkStatus: 'running' });
    db.items[0].status = 'succeeded';
    db.items[1].status = 'skipped';
    db.items[1].reason = 'already paused';
    const { svc } = service(db);
    const progress = await svc.stopBulk(owner, 'act-1');
    expect(db.action.bulkStatus).toBe('cancelled');
    expect(progress).toMatchObject({ status: 'cancelled', total: 4, done: 1, skipped: 1, pending: 2, problems: [{ leadId: 'lead-1', name: 'Lead 1', status: 'skipped', reason: 'already paused' }] });
  });

  it('building the card freezes the leads in order; above ten without assistant.bulk it fails instead', async () => {
    const bulk = { leadIds: Array.from({ length: 12 }, (_, i) => `lead-${i}`), skipped: { 'already paused': 2 }, sample: ['A', 'B'] };
    const make = (auth: AuthContext) => {
      const db = store({ total: 12, status: 'proposed', bulkStatus: null });
      const tool = { name: 'leads_outreach_pause', tier: 'write', permissions: ['lead.update'], input: { safeParse: (v: unknown) => ({ success: true, data: v }) }, preview: vi.fn(async () => ({ title: 'Pause AI outreach to 12 leads', bulk })), bulk: { runOne: vi.fn() } };
      const svc = new AssistantActionService(db as any, { get: () => tool, allows: () => true } as any, {} as any, { quietly: vi.fn() } as any, { forThread: () => ({}) } as any, { start: vi.fn() } as any);
      return { db, run: () => svc.handle(auth, 'thread-1', 'msg-1', { id: 'tu-1', name: 'leads_outreach_pause', input: { filter: {} } }) };
    };
    const ok = make(owner);
    await ok.run();
    expect(ok.db.assistantAction.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'proposed', bulkTotal: 12, preview: expect.objectContaining({ bulk: { total: 12, sample: ['A', 'B'], skipped: { 'already paused': 2 } } }) }) });
    const frozen = (ok.db.assistantActionItem.createMany.mock.calls[0] as any[])[0].data;
    expect(frozen.map((r: any) => [r.leadId, r.position])).toEqual(bulk.leadIds.map((id, i) => [id, i]));
    const refused = make({ ...owner, permissions: ['lead.update'] });
    await refused.run();
    expect(refused.db.assistantAction.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'failed', error: expect.stringContaining('assistant.bulk') }) });
    expect(refused.db.assistantActionItem.createMany).not.toHaveBeenCalled();
  });
});
