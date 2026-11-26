import { randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '@/auth/auth.types';
import { PrismaService } from '@/common/prisma/prisma.service';
import { TenantContext } from '@/common/prisma/tenant-context';
import { AssistantActionService } from './assistant-action.service';
import { AssistantBulkRunner } from './assistant-bulk.runner';
import { AssistantRefService } from './assistant-ref.service';
import { bulkTools } from './tools/bulk.tools';

/**
 * A bulk action on the real database (backend/.env), with the real tenant guard: the filter picks the
 * leads, the card freezes them, approving queues the job once, and the job records each lead's
 * outcome. The step run on each lead is a stand-in that records which leads it was given.
 * Run: npx vitest run -c vitest.integration.config.ts src/assistant/assistant-bulk.int.ts
 */

const prisma = new PrismaService({ get: () => undefined } as unknown as ConfigService);
const guarded = prisma.withTenancyGuard();
const refService = new AssistantRefService(guarded);
const ran: string[] = [];
const pause = vi.fn(async (_auth: AuthContext, leadId: string) => {
  ran.push(leadId);
});
const [pauseTool] = bulkTools({ prisma: guarded, assignments: {}, engine: {}, followup: {}, control: { pause, resume: vi.fn() } } as never).filter((t) => t.name === 'leads_outreach_pause');
const registry = { get: () => pauseTool, allows: () => true, entityVersion: async () => null, switchedOff: () => false };
const runner = { start: vi.fn() };
const actions = new AssistantActionService(guarded, registry as never, {} as never, { quietly: vi.fn() } as never, refService, runner as never);
const worker = new AssistantBulkRunner(guarded, prisma, registry as never, refService);

let orgId: string;
let owner: AuthContext;
let threadId: string;
let otherAgentLead: string;

const inOrg = <T>(fn: () => Promise<T>) => TenantContext.run(orgId, fn);

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `bulk-int ${randomUUID().slice(0, 8)}` } })).id;
  const user = (first: string) =>
    prisma.user.create({ data: { orgId, firstName: first, lastName: 'Test', email: `bulk-${randomUUID()}@example.test`, password: 'not-a-real-hash' } });
  const [o, a] = await Promise.all([user('Owner'), user('Agent')]);
  // The job looks the approver's permissions up again, as a request would: the owner holds the system role.
  const role = await prisma.role.create({ data: { orgId, name: 'Owner', isSystem: true } });
  await prisma.userRole.create({ data: { userId: o.id, roleId: role.id } });
  owner = { userId: o.id, organizationId: orgId, sessionId: randomUUID(), roleIds: [], permissions: ['lead.read', 'lead.update', 'assistant.bulk'] };
  // 12 warm leads in Austin (one already paused), 2 cold ones elsewhere.
  for (let i = 0; i < 12; i++) {
    await prisma.lead.create({ data: { orgId, firstName: 'Warm', lastName: `${i}`, temperature: 'warm', location: 'Austin, TX', automationPaused: i === 0, assignedToId: i === 1 ? a.id : null } });
  }
  for (let i = 0; i < 2; i++) await prisma.lead.create({ data: { orgId, firstName: 'Cold', lastName: `${i}`, temperature: 'cold', location: 'Dallas, TX' } });
  otherAgentLead = (await prisma.lead.findFirstOrThrow({ where: { orgId, assignedToId: a.id } })).id;
  threadId = (await prisma.assistantThread.create({ data: { orgId, userId: o.id, title: 'bulk' } })).id;
});

afterAll(async () => {
  // A role in use cannot be deleted, so the links go first.
  if (orgId) await prisma.userRole.deleteMany({ where: { role: { orgId } } });
  if (orgId) await prisma.organization.delete({ where: { id: orgId } });
  await prisma.$disconnect();
});

describe('a bulk action on the real database', () => {
  let actionId: string;

  it('the filter picks the matching leads and the card freezes them, leaving out the paused one', async () => {
    const message = await prisma.assistantMessage.create({ data: { orgId, threadId, position: 0, role: 'assistant', content: [] } });
    const action = await inOrg(() =>
      actions.handle(owner, threadId, message.id, { id: 'tu-1', name: 'leads_outreach_pause', input: { filter: { temperature: 'warm', location: 'austin' }, reason: 'Holiday' } }),
    );
    actionId = action.id;
    expect(action).toMatchObject({ status: 'proposed', bulkTotal: 11 });
    expect((action.preview as { bulk: unknown }).bulk).toMatchObject({ total: 11, skipped: { 'already paused': 1 } });
    expect(await prisma.assistantActionItem.count({ where: { actionId } })).toBe(11);
  });

  it('approving needs the count, then starts the job', async () => {
    await expect(inOrg(() => actions.confirm(owner, actionId, { count: 10 }))).rejects.toMatchObject({ code: 'BULK_COUNT_MISMATCH' });
    const approved = await inOrg(() => actions.confirm(owner, actionId, { count: 11 }));
    expect(approved).toMatchObject({ status: 'executed', bulkStatus: 'queued' });
    expect(runner.start).toHaveBeenCalledWith(orgId, actionId);
  });

  it('the job runs each frozen lead once and records it; a lead the approver can no longer see is skipped', async () => {
    // Merged away after the card was built: the approver can no longer reach it.
    await prisma.lead.update({ where: { id: otherAgentLead }, data: { mergedIntoId: otherAgentLead } });
    await inOrg(() => worker.runAction(orgId, actionId));
    const action = await prisma.assistantAction.findUniqueOrThrow({ where: { id: actionId } });
    expect(action.bulkStatus).toBe('done');
    const items = await prisma.assistantActionItem.findMany({ where: { actionId } });
    expect(items.filter((i) => i.status === 'succeeded')).toHaveLength(10);
    expect(items.find((i) => i.leadId === otherAgentLead)).toMatchObject({ status: 'skipped', reason: expect.stringContaining('No longer visible') });
    expect(new Set(ran).size).toBe(10);
    expect(ran).toHaveLength(10);
    const progress = await inOrg(() => actions.bulkProgress(owner, actionId));
    expect(progress).toMatchObject({ status: 'done', total: 11, done: 10, skipped: 1, failed: 0, pending: 0 });
  });

  it('running the job again changes nothing: every lead already has its outcome', async () => {
    await prisma.assistantAction.update({ where: { id: actionId }, data: { bulkStatus: 'queued' } });
    await inOrg(() => worker.runAction(orgId, actionId));
    expect(ran).toHaveLength(10);
  });

  it('the sweep picks up a job whose server stopped mid-way, and leaves a live one alone', async () => {
    const start = vi.spyOn(worker, 'start').mockImplementation(() => undefined);
    // Running, but the last lead finished an hour ago: its server is gone.
    await prisma.assistantAction.update({ where: { id: actionId }, data: { bulkStatus: 'running', decidedAt: new Date(Date.now() - 2 * 60 * 60_000) } });
    await prisma.assistantActionItem.updateMany({ where: { actionId }, data: { finishedAt: new Date(Date.now() - 60 * 60_000) } });
    await worker.sweep();
    expect(start).toHaveBeenCalledWith(orgId, actionId);
    expect((await prisma.assistantAction.findUniqueOrThrow({ where: { id: actionId } })).bulkStatus).toBe('queued');
    start.mockClear();
    // A lead finished a moment ago: someone is running it.
    await prisma.assistantAction.update({ where: { id: actionId }, data: { bulkStatus: 'running' } });
    await prisma.assistantActionItem.updateMany({ where: { actionId }, data: { finishedAt: new Date() } });
    await worker.sweep();
    expect(start).not.toHaveBeenCalledWith(orgId, actionId);
    await prisma.assistantAction.update({ where: { id: actionId }, data: { bulkStatus: 'done' } });
  });
});
