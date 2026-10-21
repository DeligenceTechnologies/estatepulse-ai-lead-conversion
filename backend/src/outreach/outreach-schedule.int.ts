import { randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '@/audit/audit.service';
import { PrismaService } from '@/common/prisma/prisma.service';
import type { IntegrationEnv } from '@/common/utils/interface';
import { EventsBus } from '@/events/events.bus';
import { FileImportService } from '@/file-import/file-import.service';
import { SheetImportService } from '@/google-sheets/sheet-import.service';
import { SheetReviewService } from '@/google-sheets/sheet-review.service';
import { FILE_IMPORT_REVIEW_REASON } from '@/google-sheets/sheet-rows';
import { LeadsController } from '@/lead/leads.controller';
import type { AuthContext } from '@/auth/auth.types';
import { StrategyStoreService, defaultStrategy } from '@/telnyx/strategy-store.service';
import type { CallSlots } from '@/telnyx/calls/call-slots';
import { OutreachRunner } from './outreach.runner';
import { OutreachService } from './outreach.service';

/**
 * test:outreach-schedule — "call now / schedule" for approved imports against
 * the real database. Services are built by hand (no Nest app, so no lead
 * watcher and nothing is ever dialled); the release runner is ticked with an
 * explicit clock. Every test makes its own organization, deleted at the end.
 */

const env = (scheduling: boolean) =>
  ({
    get: (key: string) =>
      (({
        OUTREACH_SCHEDULING_ENABLED: scheduling,
        OUTREACH_POLL_MS: 15_000,
        FILE_IMPORT_MAX_BYTES: 5 * 1024 * 1024,
        GOOGLE_SHEETS_ENABLED: false,
        SHEETS_SYNC: false,
      }) as Record<string, unknown>)[key],
  }) as unknown as ConfigService<IntegrationEnv, true>;

const prisma = new PrismaService({ get: () => undefined } as unknown as ConfigService);
const audit = new AuditService(prisma);
const strategies = new StrategyStoreService(prisma);
const reviewsOn = new SheetReviewService(prisma, audit, env(true));
const reviewsOff = new SheetReviewService(prisma, audit, env(false));
const outreach = new OutreachService(prisma, strategies, audit);
/** Live calls per org, as the call worker's Redis slots would report them; a test sets them directly. */
const live = new Map<string, number>();
const slots = { inUse: async (orgId: string) => live.get(orgId) ?? 0 } as unknown as CallSlots;
const newRunner = () => new OutreachRunner(prisma, env(true), strategies, audit, slots);
const runner = newRunner();

const orgs: string[] = [];

const fileImports = () =>
  new FileImportService(prisma, new SheetImportService(prisma, {} as never, {} as never, new EventsBus(), audit, env(true)), reviewsOn, new EventsBus(), audit, env(true));
const csvFile = (rows: string[]) => {
  const buffer = Buffer.from(['First Name,Last Name,Phone', ...rows].join('\n') + '\n');
  return { originalname: 'leads.csv', size: buffer.length, buffer };
};
const HOUR = 3_600_000;

/** The error code an HttpException carries, or null if the call succeeded. */
async function codeOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    const r = (e as { getResponse?: () => unknown }).getResponse?.() as { error?: { code?: string }; message?: string } | undefined;
    return r?.error?.code ?? r?.message ?? (e as Error).message;
  }
}

const hhmm = (d: Date) => d.toISOString().slice(11, 16);
const wall = (d: Date) => ({ date: d.toISOString().slice(0, 10), time: hhmm(d), timeZone: 'UTC' });
/** A scheduled start whole minutes ahead, as the API takes it (UTC wall clock). */
const ahead = (ms: number) => new Date(Math.ceil((Date.now() + ms) / 60_000) * 60_000);

async function setupOrg(opts: { max?: number; reserved?: number; quiet?: { start: string; end: string } } = {}) {
  const org = await prisma.organization.create({ data: { name: `outreach-int ${randomUUID().slice(0, 8)}` } });
  orgs.push(org.id);
  const strategy = defaultStrategy();
  await prisma.organizationSetting.create({
    data: {
      orgId: org.id,
      timezone: 'UTC',
      maxConcurrentCalls: opts.max ?? 5,
      reservedCallSlots: opts.reserved ?? 1,
      outreachStrategy: {
        ...strategy,
        guardrails: { ...strategy.guardrails, respectQuietHours: Boolean(opts.quiet), quietHours: opts.quiet ?? { start: '21:00', end: '08:00' } },
      } as unknown as Prisma.InputJsonValue,
    },
  });
  const user = await prisma.user.create({
    data: { orgId: org.id, firstName: 'Test', lastName: 'Owner', email: `outreach-${randomUUID()}@example.test`, password: 'not-a-real-hash' },
  });
  const source = await prisma.leadSource.create({
    data: { orgId: org.id, name: 'leads.csv', code: `upload-${randomUUID()}`.slice(0, 50), provider: 'FILE_UPLOAD', connectionMethod: 'UPLOAD' },
  });
  return { orgId: org.id, sourceId: source.id, who: { organizationId: org.id, userId: user.id, sessionId: randomUUID() } };
}
type Org = Awaited<ReturnType<typeof setupOrg>>;

/** Leads as an import leaves them: new, paused, waiting for review, one tracked row each. */
async function imported(o: Org, n: number, over: { dncStatus?: boolean } = {}) {
  const leadIds: string[] = [];
  const rowIds: string[] = [];
  for (let i = 0; i < n; i++) {
    const phone = `+1415555${String(1000 + Math.floor(Math.random() * 8999)).slice(0, 4)}`;
    const lead = await prisma.lead.create({
      data: {
        orgId: o.orgId,
        leadSourceId: o.sourceId,
        firstName: `Lead${i}`,
        phone,
        normalizedPhone: phone,
        phoneValid: true,
        automationPaused: true,
        needsReview: true,
        reviewReasons: [FILE_IMPORT_REVIEW_REASON],
        dncStatus: over.dncStatus ?? false,
      },
      select: { id: true },
    });
    const row = await prisma.sheetImportRow.create({
      data: { orgId: o.orgId, leadSourceId: o.sourceId, rowKey: randomUUID().replace(/-/g, ''), leadId: lead.id, contentHash: 'h', rowNumber: i + 2 },
      select: { id: true },
    });
    leadIds.push(lead.id);
    rowIds.push(row.id);
  }
  return { leadIds, rowIds };
}

const leadsOf = (ids: string[]) =>
  prisma.lead.findMany({ where: { id: { in: ids } }, select: { id: true, automationPaused: true }, orderBy: { id: 'asc' } });
const unpaused = async (ids: string[]) => (await leadsOf(ids)).filter((l) => !l.automationPaused).length;
const batchOf = (id: string) => prisma.outreachBatch.findUniqueOrThrow({ where: { id } });
const itemsOf = (batchId: string) => prisma.outreachBatchLead.findMany({ where: { batchId } });

/** A call on record for a lead, made after its release (so it no longer waits for a slot). */
const callFor = (o: Org, leadId: string, status: 'ringing' | 'in_progress' | 'completed' | 'failed') =>
  prisma.call.create({ data: { orgId: o.orgId, leadId, status, createdAt: new Date(Date.now() + 1000) } });

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  if (orgs.length) await prisma.organization.deleteMany({ where: { id: { in: orgs } } });
  await prisma.$disconnect();
});

describe('outreach scheduling switched off', () => {
  it('approving releases leads at once and makes no batch, exactly as before', async () => {
    const o = await setupOrg();
    const { leadIds, rowIds } = await imported(o, 3);
    const r = await reviewsOff.approve(o.who, rowIds, { mode: 'scheduled', ...wall(ahead(HOUR)) });
    expect(r).toMatchObject({ approved: 3, released: 3, held: [], skipped: [] });
    expect(r.outreach).toBeUndefined();
    expect(await unpaused(leadIds)).toBe(3);
    expect(await prisma.outreachBatch.count({ where: { orgId: o.orgId } })).toBe(0);
  });
});

describe('call now', () => {
  it('approves without releasing, then the runner releases on its next tick', async () => {
    const o = await setupOrg();
    const { leadIds, rowIds } = await imported(o, 3);
    const r = await reviewsOn.approve(o.who, rowIds, { mode: 'now' });
    expect(r).toMatchObject({ approved: 3, released: 0, outreach: { mode: 'now', queued: 3, timeZone: 'UTC' } });
    expect(await unpaused(leadIds)).toBe(0);
    const rows = await prisma.sheetImportRow.findMany({ where: { id: { in: rowIds } }, select: { reviewState: true } });
    expect(rows.every((x) => x.reviewState === 'approved')).toBe(true);

    await runner.tick(new Date());
    expect(await unpaused(leadIds)).toBe(3);
    const batch = await batchOf(r.outreach!.batchId);
    expect(batch.status).toBe('completed');
    expect(batch.startedAt).not.toBeNull();
    const actions = await prisma.auditLog.findMany({ where: { orgId: o.orgId, entityId: batch.id }, select: { action: true } });
    expect(actions.map((a) => a.action).sort()).toEqual(['outreach_batch.completed', 'outreach_batch.created', 'outreach_batch.started']);
  });

  it('is the default with scheduling on, even when the client sends no choice', async () => {
    const o = await setupOrg();
    const { rowIds } = await imported(o, 1);
    const r = await reviewsOn.approve(o.who, rowIds);
    expect(r.outreach).toMatchObject({ mode: 'now', queued: 1 });
  });

  it('turns the rows ticked in a file upload into a call-now batch', async () => {
    const o = await setupOrg();
    const files = fileImports();
    const file = csvFile(['Asha,Rao,+14155552671', 'Ravi,Kumar,+14155552672']);
    const preview = await files.preview(o.orgId, file, null, null);
    const done = await files.commit(o.who, file, preview.mapping.columns, randomUUID(), null, [], true);
    expect(done.approval).toMatchObject({ approved: 2, released: 0, outreach: { mode: 'now', queued: 2 } });
    const batch = await batchOf(done.approval!.outreach!.batchId);
    expect(batch).toMatchObject({ status: 'pending', total: 2 });
  });
});

describe('launch choice made at upload', () => {
  it('schedules the rows an upload approves, for the time picked in the upload', async () => {
    const o = await setupOrg();
    const files = fileImports();
    const file = csvFile(['Asha,Rao,+14155552673', 'Ravi,Kumar,+14155552674', 'Meera,Das,+14155552675']);
    const preview = await files.preview(o.orgId, file, null, null);
    const start = ahead(HOUR);
    const done = await files.commit(o.who, file, preview.mapping.columns, randomUUID(), null, [2, 3], false, { mode: 'scheduled', ...wall(start) });
    expect(done.approval).toMatchObject({ approved: 2, outreach: { mode: 'scheduled', startAt: start.toISOString(), queued: 2 } });
    expect(done.review.pending).toBe(1);
    await runner.tick(new Date());
    expect(await prisma.lead.count({ where: { orgId: o.orgId, automationPaused: false } })).toBe(0);
    await runner.tick(new Date(start.getTime() + 1000));
    expect(await prisma.lead.count({ where: { orgId: o.orgId, automationPaused: false } })).toBe(2);
  });

  it('refuses an upload scheduled in the past and imports nothing', async () => {
    const o = await setupOrg();
    const files = fileImports();
    const file = csvFile(['Asha,Rao,+14155552676']);
    const preview = await files.preview(o.orgId, file, null, null);
    const past = { mode: 'scheduled' as const, ...wall(new Date(Date.now() - HOUR)) };
    expect(await codeOf(files.commit(o.who, file, preview.mapping.columns, randomUUID(), null, [2], false, past))).toBe('SCHEDULE_IN_PAST');
    expect(await prisma.lead.count({ where: { orgId: o.orgId } })).toBe(0);
  });

  it('ignores the choice when the upload approves nothing: every row waits for review', async () => {
    const o = await setupOrg();
    const files = fileImports();
    const file = csvFile(['Asha,Rao,+14155552677']);
    const preview = await files.preview(o.orgId, file, null, null);
    const past = { mode: 'scheduled' as const, ...wall(new Date(Date.now() - HOUR)) };
    const done = await files.commit(o.who, file, preview.mapping.columns, randomUUID(), null, [], false, past);
    expect(done.review.pending).toBe(1);
    expect(await prisma.outreachBatch.count({ where: { orgId: o.orgId } })).toBe(0);
  });
});

describe('scheduled', () => {
  it('holds the leads until the start time, then releases them', async () => {
    const o = await setupOrg();
    const { leadIds, rowIds } = await imported(o, 2);
    const start = ahead(2 * HOUR);
    const r = await reviewsOn.approve(o.who, rowIds, { mode: 'scheduled', ...wall(start) });
    expect(r.outreach).toMatchObject({ mode: 'scheduled', startAt: start.toISOString(), queued: 2 });

    await runner.tick(new Date());
    await runner.tick(new Date(start.getTime() - 1000));
    expect(await unpaused(leadIds)).toBe(0);
    expect((await batchOf(r.outreach!.batchId)).status).toBe('pending');

    await runner.tick(new Date(start.getTime() + 1000));
    expect(await unpaused(leadIds)).toBe(2);
    expect((await batchOf(r.outreach!.batchId)).status).toBe('completed');
  });

  it('refuses a time already past, and decides nothing', async () => {
    const o = await setupOrg();
    const { leadIds, rowIds } = await imported(o, 1);
    expect(await codeOf(reviewsOn.approve(o.who, rowIds, { mode: 'scheduled', ...wall(new Date(Date.now() - HOUR)) }))).toBe('SCHEDULE_IN_PAST');
    const row = await prisma.sheetImportRow.findUniqueOrThrow({ where: { id: rowIds[0] } });
    expect(row.reviewState).toBe('pending');
    expect(await unpaused(leadIds)).toBe(0);
    expect(await prisma.outreachBatch.count({ where: { orgId: o.orgId } })).toBe(0);
  });

  it('survives a restart: a new runner instance releases what the old one left', async () => {
    const o = await setupOrg({ max: 3, reserved: 1 });
    const { leadIds, rowIds } = await imported(o, 4);
    const r = await reviewsOn.approve(o.who, rowIds, { mode: 'now' });
    const before = newRunner();
    await before.tick(new Date());
    expect(await unpaused(leadIds)).toBe(2);
    before.onModuleDestroy();

    for (const l of (await leadsOf(leadIds)).filter((x) => !x.automationPaused)) await callFor(o, l.id, 'completed');
    const after = newRunner();
    await after.tick(new Date());
    expect(await unpaused(leadIds)).toBe(4);
    expect((await batchOf(r.outreach!.batchId)).status).toBe('completed');
  });
});

describe('pacing', () => {
  it('keeps live calls plus waiting releases within the limit minus the reserve', async () => {
    const o = await setupOrg({ max: 3, reserved: 1 });
    const { leadIds, rowIds } = await imported(o, 5);
    const r = await reviewsOn.approve(o.who, rowIds, { mode: 'now' });

    await runner.tick(new Date());
    expect(await unpaused(leadIds)).toBe(2);
    await runner.tick(new Date()); // both released leads still wait for their first call
    expect(await unpaused(leadIds)).toBe(2);
    expect((await batchOf(r.outreach!.batchId)).status).toBe('running');

    for (const l of (await leadsOf(leadIds)).filter((x) => !x.automationPaused)) await callFor(o, l.id, 'completed');
    await runner.tick(new Date());
    expect(await unpaused(leadIds)).toBe(4);

    // One of the two new ones is on a live call, the other's call is over: one slot left.
    const released = (await itemsOf(r.outreach!.batchId)).filter((i) => i.state === 'released');
    const fresh = released.filter((i) => i.releasedAt && i.releasedAt.getTime() >= released.reduce((m, x) => Math.max(m, x.releasedAt!.getTime()), 0));
    await callFor(o, fresh[0].leadId, 'ringing');
    await callFor(o, fresh[1].leadId, 'completed');
    live.set(o.orgId, 1);
    await runner.tick(new Date());
    expect(await unpaused(leadIds)).toBe(5);
    expect((await batchOf(r.outreach!.batchId)).status).toBe('completed');
  });

  it('two runners ticking at once still share one budget', async () => {
    const o = await setupOrg({ max: 3, reserved: 1 });
    const { leadIds, rowIds } = await imported(o, 6);
    await reviewsOn.approve(o.who, rowIds.slice(0, 3), { mode: 'now' });
    await reviewsOn.approve(o.who, rowIds.slice(3), { mode: 'now' });
    await Promise.all([newRunner().tick(new Date()), newRunner().tick(new Date())]);
    expect(await unpaused(leadIds)).toBe(2);
  });

  it('another org’s live calls do not count', async () => {
    const a = await setupOrg({ max: 3, reserved: 1 });
    const b = await setupOrg({ max: 3, reserved: 1 });
    live.set(b.orgId, 3);
    const { leadIds, rowIds } = await imported(a, 2);
    await reviewsOn.approve(a.who, rowIds, { mode: 'now' });
    await runner.tick(new Date());
    expect(await unpaused(leadIds)).toBe(2);
  });
});

describe('guardrails at release', () => {
  it('skips leads that opted out or were taken over since approval, and counts those held at approval', async () => {
    const o = await setupOrg();
    const optedOutAtImport = await imported(o, 1, { dncStatus: true });
    const { leadIds, rowIds } = await imported(o, 3);
    const r = await reviewsOn.approve(o.who, [...optedOutAtImport.rowIds, ...rowIds], { mode: 'now' });
    expect(r.held).toHaveLength(1);
    expect(r.outreach?.queued).toBe(3);

    await prisma.lead.update({ where: { id: leadIds[0] }, data: { dncStatus: true } });
    await prisma.lead.update({ where: { id: leadIds[1] }, data: { status: 'contacting' } });
    await runner.tick(new Date());

    const items = await itemsOf(r.outreach!.batchId);
    const reason = (id: string) => items.find((i) => i.leadId === id);
    expect(reason(leadIds[0])).toMatchObject({ state: 'skipped', skipReason: 'DO_NOT_CONTACT' });
    expect(reason(leadIds[1])).toMatchObject({ state: 'skipped', skipReason: 'STATUS_CHANGED' });
    expect(reason(leadIds[2])).toMatchObject({ state: 'released' });
    expect(await unpaused([...leadIds, ...optedOutAtImport.leadIds])).toBe(1);

    const [listed] = (await outreach.list(o.orgId)).items;
    expect(listed).toMatchObject({ status: 'completed', total: 3, progress: { skipped: 3, pending: 1, called: 0, failed: 0 } });
  });

  it('respects the contact window: nothing is released inside quiet hours', async () => {
    const now = new Date();
    const o = await setupOrg({ quiet: { start: hhmm(new Date(now.getTime() - HOUR)), end: hhmm(new Date(now.getTime() + HOUR)) } });
    const { leadIds, rowIds } = await imported(o, 2);
    const r = await reviewsOn.approve(o.who, rowIds, { mode: 'now' });
    await runner.tick(new Date()); // the batch is due now, and now is inside the quiet window
    expect(await unpaused(leadIds)).toBe(0);
    expect((await batchOf(r.outreach!.batchId)).status).toBe('pending');

    await runner.tick(new Date(now.getTime() + 2 * HOUR));
    expect(await unpaused(leadIds)).toBe(2);
  });
});

describe('cancel and reschedule', () => {
  it('cancels a scheduled batch: nobody is released, ever', async () => {
    const o = await setupOrg();
    const { leadIds, rowIds } = await imported(o, 3);
    const start = ahead(HOUR);
    const r = await reviewsOn.approve(o.who, rowIds, { mode: 'scheduled', ...wall(start) });
    expect(await outreach.cancel(o.who, r.outreach!.batchId)).toEqual({ cancelled: true, notStarted: 3, repaused: 0 });
    await runner.tick(new Date(start.getTime() + 1000));
    expect(await unpaused(leadIds)).toBe(0);
    expect((await batchOf(r.outreach!.batchId)).status).toBe('cancelled');
    expect(await codeOf(outreach.cancel(o.who, r.outreach!.batchId))).toBe('BATCH_NOT_CANCELLABLE');
  });

  it('cancels a running batch: the rest stay paused, released-but-uncalled leads are paused again', async () => {
    const o = await setupOrg({ max: 4, reserved: 1 });
    const { leadIds, rowIds } = await imported(o, 5);
    const r = await reviewsOn.approve(o.who, rowIds, { mode: 'now' });
    await runner.tick(new Date());
    const released = (await leadsOf(leadIds)).filter((l) => !l.automationPaused);
    expect(released).toHaveLength(3);
    await callFor(o, released[0].id, 'in_progress');

    expect(await outreach.cancel(o.who, r.outreach!.batchId)).toEqual({ cancelled: true, notStarted: 2, repaused: 2 });
    expect(await unpaused(leadIds)).toBe(1); // the one already on a call keeps its conversation
    const action = await prisma.auditLog.findFirst({ where: { entityId: r.outreach!.batchId, action: 'outreach_batch.cancelled' } });
    expect(action).toMatchObject({ actorId: o.who.userId, payload: { from: 'running', notStarted: 2, repaused: 2 } });
  });

  it('reschedules a pending batch to a new time, and only a pending one', async () => {
    const o = await setupOrg();
    const { leadIds, rowIds } = await imported(o, 1);
    const first = ahead(HOUR);
    const r = await reviewsOn.approve(o.who, rowIds, { mode: 'scheduled', ...wall(first) });
    const later = ahead(3 * HOUR);
    const moved = await outreach.reschedule(o.who, r.outreach!.batchId, wall(later));
    expect(moved.startAt.toISOString()).toBe(later.toISOString());

    await runner.tick(new Date(first.getTime() + 1000));
    expect(await unpaused(leadIds)).toBe(0);
    expect(await codeOf(outreach.reschedule(o.who, r.outreach!.batchId, wall(new Date(Date.now() - HOUR))))).toBe('SCHEDULE_IN_PAST');

    await runner.tick(new Date(later.getTime() + 1000));
    expect(await unpaused(leadIds)).toBe(1);
    expect(await codeOf(outreach.reschedule(o.who, r.outreach!.batchId, wall(ahead(4 * HOUR))))).toBe('BATCH_NOT_PENDING');
  });
});

describe('batch progress', () => {
  it('counts leads deleted since launch as removed, not as pending', async () => {
    const o = await setupOrg();
    const { leadIds, rowIds } = await imported(o, 3);
    await reviewsOn.approve(o.who, rowIds, { mode: 'scheduled', ...wall(ahead(HOUR)) });
    await prisma.lead.delete({ where: { id: leadIds[0] } });
    const [batch] = (await outreach.list(o.orgId)).items;
    expect(batch).toMatchObject({ total: 3, progress: { pending: 2, removed: 1, called: 0, skipped: 0 } });
  });
});

describe('leads list', () => {
  it('says where each lead stands with outreach: scheduled, waiting, released, skipped, paused', async () => {
    const o = await setupOrg({ max: 2, reserved: 1 });
    const leads = new LeadsController(prisma, {} as never, {} as never);
    const later = await imported(o, 1);
    const start = ahead(HOUR);
    await reviewsOn.approve(o.who, later.rowIds, { mode: 'scheduled', ...wall(start) });

    const now = await imported(o, 4);
    const [dialA, dialB, noPhone, optsOut] = now.leadIds;
    await prisma.lead.update({ where: { id: noPhone }, data: { normalizedPhone: null } });
    const r = await reviewsOn.approve(o.who, now.rowIds, { mode: 'now' });
    expect(r.held).toHaveLength(1);
    await prisma.lead.update({ where: { id: optsOut }, data: { dncStatus: true } });
    await runner.tick(new Date()); // one slot: one released, one still queued in a running batch

    const { data: listed } = await leads.list({ organizationId: o.orgId, userId: o.who.userId } as AuthContext, {} as never);
    const of = (id: string) => listed.find((l) => l.id === id)?.outreach;
    expect(of(later.leadIds[0])).toEqual({ state: 'scheduled', startAt: start, timeZone: 'UTC' });
    expect([of(dialA)?.state, of(dialB)?.state].sort()).toEqual(['released', 'waiting']);
    expect(of(optsOut)).toEqual({ state: 'skipped', reason: 'DO_NOT_CONTACT' });
    expect(of(noPhone)).toEqual({ state: 'paused' });
  });
});

describe('tenant isolation', () => {
  it('another organization can neither see, cancel nor move a batch, nor approve its rows', async () => {
    const a = await setupOrg();
    const b = await setupOrg();
    const { leadIds, rowIds } = await imported(a, 2);
    const r = await reviewsOn.approve(a.who, rowIds, { mode: 'scheduled', ...wall(ahead(HOUR)) });
    const id = r.outreach!.batchId;

    expect((await outreach.list(b.orgId)).items.map((x) => x.id)).not.toContain(id);
    expect(await codeOf(outreach.cancel(b.who, id))).toBe('BATCH_NOT_FOUND');
    expect(await codeOf(outreach.reschedule(b.who, id, wall(ahead(2 * HOUR))))).toBe('BATCH_NOT_FOUND');
    expect((await batchOf(id)).status).toBe('pending');

    const other = await imported(a, 1);
    const stolen = await reviewsOn.approve(b.who, other.rowIds, { mode: 'now' });
    expect(stolen).toMatchObject({ approved: 0, skipped: other.rowIds });
    expect(stolen.outreach).toBeUndefined();
    expect(await unpaused([...leadIds, ...other.leadIds])).toBe(0);
  });
});
