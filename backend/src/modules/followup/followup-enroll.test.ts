import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { envSchema } from '../../app.module';
import { AuthModule } from '../../auth/auth.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { FollowupModule } from './followup.module';

/**
 * Integration suite for POST /api/v1/sequences/:id/enroll against the real
 * database. Run with `npm run test:followup-enroll`.
 *
 * Pins the whole answer — matched, enrolled, and every skip with its reason in
 * order — and the rows it leaves behind: who was enrolled, at which step, by
 * whom, and which lead statuses moved to nurture.
 */

// FollowupModule pulls in TelnyxModule. Nothing here may start the background
// pollers against the shared database, whatever the developer's .env says.
process.env['STRATEGY_ENGINE'] = '0';
process.env['CALENDAR_SYNC'] = '0';
process.env['WORKER_ENABLED'] = 'false';

const RUN = Date.now().toString(36);
const emailFor = (tag: string): string => `followup-enroll-${RUN}-${tag}@example.invalid`;
const PASSWORD = 'correct-horse-battery-staple';
const MISSING = '00000000-0000-4000-8000-000000000000';

let app: INestApplication;
let prisma: PrismaService;
let base: string;

const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function enroll(sequenceId: string, body: unknown, token?: string): Promise<{ status: number; body: any; text: string }> {
  const res = await fetch(`${base}/api/v1/sequences/${sequenceId}/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    // raw text is still in the assertion message
  }
  return { status: res.status, body: parsed, text };
}

async function signupOwner(tag: string) {
  const res = await fetch(`${base}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: emailFor(tag), password: PASSWORD, firstName: 'Owner', lastName: tag,
      organizationName: `FollowupEnroll ${tag} ${RUN}`, teamSize: 'team',
    }),
  });
  const b = await res.json();
  assert.equal(res.status, 201, JSON.stringify(b));
  createdUserIds.push(b.user.id);
  createdOrgIds.push(b.organization.id);
  return { token: b.token as string, orgId: b.organization.id as string, userId: b.user.id as string };
}

let A = { token: '', orgId: '', userId: '' };
let B = { token: '', orgId: '', userId: '' };
const seq: Record<string, string> = {};
const lead: Record<string, string> = {};
const t0 = Date.now() - 86400e3;

before(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, validate: (raw) => ({ ...raw, ...envSchema.parse(raw) }) }),
      PrismaModule,
      AuthModule,
      FollowupModule,
    ],
  }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  prisma = app.get(PrismaService);

  A = await signupOwner('a');
  B = await signupOwner('b');

  const sequence = async (orgId: string, code: string, status: string, steps: number[]) => {
    const s = await prisma.followup_sequences.create({
      data: { organization_id: orgId, code: `${code}-${RUN}`, name: code, status },
      select: { id: true },
    });
    if (steps.length > 0) {
      await prisma.sequence_steps.createMany({
        data: steps.map((order) => ({
          organization_id: orgId, sequence_id: s.id, step_order: order, action_type: 'sms',
          delay_minutes: order * 60, message_template: 'hi', max_attempts: 1,
        })),
      });
    }
    return s.id;
  };
  seq['main'] = await sequence(A.orgId, 'main', 'active', [2, 1]); // first step is order 1, 60 min
  seq['held'] = await sequence(A.orgId, 'held', 'active', [1]);
  seq['bulk'] = await sequence(A.orgId, 'bulk', 'active', [1]);
  seq['inactive'] = await sequence(A.orgId, 'inactive', 'inactive', [1]);
  seq['empty'] = await sequence(A.orgId, 'empty', 'active', []);
  seq['otherOrg'] = await sequence(B.orgId, 'other', 'active', [1]);

  // Created one minute apart, oldest first, so created_at order is known.
  let minute = 0;
  const mk = async (name: string, data: Record<string, unknown>, orgId = A.orgId) => {
    lead[name] = (
      await prisma.leads.create({
        data: { organization_id: orgId, first_name: name, created_at: new Date(t0 + (minute++) * 60e3), ...data },
        select: { id: true },
      })
    ).id;
  };
  await mk('fresh1', { status: 'new' });
  await mk('dnc', { status: 'new', dnc_status: true });
  await mk('held', { status: 'contacted' });
  await mk('inStrategy', { status: 'contacting', first_contact_at: new Date(t0) });
  await mk('paused', { status: 'contacting', first_contact_at: new Date(t0), automation_paused: true });
  await mk('qualified', { status: 'qualified' });
  await mk('fresh2', { status: 'engaged' });
  await mk('warm1', { status: 'new', temperature: 'warm' });
  await mk('warm2', { status: 'qualified', temperature: 'warm' });
  await mk('warmDnc', { status: 'new', temperature: 'warm', dnc_status: true });
  await mk('otherOrg', { status: 'new' }, B.orgId);

  // Already in a sequence: the one-active-per-lead index refuses a second.
  await prisma.sequence_enrollments.create({
    data: { organization_id: A.orgId, lead_id: lead['held']!, sequence_id: seq['held']!, status: 'active', enrolled_by: 'manual' },
  });
});

after(async () => {
  try {
    await prisma.leads.deleteMany({ where: { organization_id: { in: createdOrgIds } } });
    await prisma.followup_sequences.deleteMany({ where: { organization_id: { in: createdOrgIds } } });
    await prisma.users.deleteMany({ where: { id: { in: createdUserIds } } });
    // Orgs with audit rows cannot be deleted (immutable audit log) — see agent-me.test.ts.
    const audited = new Set(
      (
        await prisma.audit_logs.findMany({
          where: { organization_id: { in: createdOrgIds } },
          select: { organization_id: true },
          distinct: ['organization_id'],
        })
      ).map((r) => r.organization_id),
    );
    await prisma.organizations.deleteMany({ where: { id: { in: createdOrgIds.filter((o) => !audited.has(o)) } } });
  } finally {
    await app.close();
  }
});

/** Hand-picked, in this order: unknown and other-org ids among real ones. */
const picked = () => [
  MISSING, lead['fresh1'], lead['otherOrg'], lead['dnc'], lead['held'], lead['inStrategy'],
  lead['paused'], lead['qualified'], lead['fresh2'],
];
const statusOf = async (name: string) =>
  (await prisma.leads.findUniqueOrThrow({ where: { id: lead[name]! }, select: { status: true } })).status;
const enrolmentsIn = (sequenceId: string) =>
  prisma.sequence_enrollments.findMany({ where: { sequence_id: sequenceId }, orderBy: { lead_id: 'asc' } });

test('a dry run reports who would be added and writes nothing', async () => {
  const res = await enroll(seq['main']!, { leadIds: picked(), dryRun: true }, A.token);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body, {
    matched: 7,
    enrolled: 0,
    skipped: [
      { leadId: MISSING, leadName: 'Unknown lead', reason: 'not_found' },
      { leadId: lead['otherOrg'], leadName: 'Unknown lead', reason: 'not_found' },
      { leadId: lead['inStrategy'], leadName: 'inStrategy', reason: 'in_strategy' },
      { leadId: lead['dnc'], leadName: 'dnc', reason: 'dnc' },
    ],
    dryRun: true,
  });
  assert.equal((await enrolmentsIn(seq['main']!)).length, 0);
  assert.equal(await statusOf('fresh1'), 'new');
});

test('hand-picked leads: the eligible are enrolled; every skip is reported, in order', async () => {
  const before = Date.now();
  const res = await enroll(seq['main']!, { leadIds: picked() }, A.token);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body, {
    matched: 7,
    enrolled: 4,
    skipped: [
      { leadId: MISSING, leadName: 'Unknown lead', reason: 'not_found' },
      { leadId: lead['otherOrg'], leadName: 'Unknown lead', reason: 'not_found' },
      { leadId: lead['inStrategy'], leadName: 'inStrategy', reason: 'in_strategy' },
      { leadId: lead['dnc'], leadName: 'dnc', reason: 'dnc' },
      { leadId: lead['held'], leadName: 'held', reason: 'already_enrolled' },
    ],
    dryRun: false,
  });

  const rows = await enrolmentsIn(seq['main']!);
  assert.deepEqual(
    rows.map((r) => r.lead_id).sort(),
    [lead['fresh1'], lead['paused'], lead['qualified'], lead['fresh2']].sort(),
  );
  for (const r of rows) {
    assert.equal(r.organization_id, A.orgId);
    assert.equal(r.current_step, 1, 'the lowest step_order, whatever order the steps were written in');
    assert.equal(r.status, 'active');
    assert.equal(r.enrolled_by, 'manual');
    assert.equal(r.enrolled_by_user_id, A.userId);
    assert.equal(r.attempts, 0);
    assert.ok(r.next_action_at!.getTime() >= before + 60 * 60e3, 'due no sooner than the first step delay');
  }
  assert.equal(new Set(rows.map((r) => r.next_action_at!.getTime())).size, 1, 'one due time for the batch');

  // The already-enrolled lead keeps only the enrolment it had.
  const held = await prisma.sequence_enrollments.findMany({ where: { lead_id: lead['held']! } });
  assert.deepEqual(held.map((r) => r.sequence_id), [seq['held']]);
  // Nothing crossed into the other organization.
  assert.equal(await prisma.sequence_enrollments.count({ where: { lead_id: lead['otherOrg']! } }), 0);
  assert.equal(await statusOf('otherOrg'), 'new');
});

test('statuses: every matched lead still in an early status moves to nurture; later statuses keep theirs', async () => {
  // Matched leads in new|contacting|contacted|engaged become nurture — the
  // skipped ones included, as the rewrite runs over everything matched.
  for (const name of ['fresh1', 'fresh2', 'paused', 'dnc', 'held', 'inStrategy']) {
    assert.equal(await statusOf(name), 'nurture', name);
  }
  assert.equal(await statusOf('qualified'), 'qualified');
});

test('enrolling the same leads again adds nobody and reports them already enrolled', async () => {
  const res = await enroll(seq['main']!, { leadIds: [lead['fresh1'], lead['qualified']] }, A.token);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body, {
    matched: 2,
    enrolled: 0,
    skipped: [
      { leadId: lead['qualified'], leadName: 'qualified', reason: 'already_enrolled' },
      { leadId: lead['fresh1'], leadName: 'fresh1', reason: 'already_enrolled' },
    ],
    dryRun: false,
  });
  assert.equal((await enrolmentsIn(seq['main']!)).length, 4);
});

test('by filter: enrolled as bulk, and an opted-out lead is excluded from the match rather than skipped', async () => {
  const res = await enroll(seq['bulk']!, { filter: { temperature: 'warm' } }, A.token);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body, { matched: 2, enrolled: 2, skipped: [], dryRun: false });
  const rows = await enrolmentsIn(seq['bulk']!);
  assert.deepEqual(rows.map((r) => r.lead_id).sort(), [lead['warm1'], lead['warm2']].sort());
  assert.ok(rows.every((r) => r.enrolled_by === 'bulk' && r.enrolled_by_user_id === A.userId));
  assert.equal(await statusOf('warm1'), 'nurture');
  assert.equal(await statusOf('warm2'), 'qualified');
  assert.equal(await statusOf('warmDnc'), 'new');
});

test('a sequence that is another organization\'s, inactive, or has no steps is refused', async () => {
  const other = await enroll(seq['otherOrg']!, { leadIds: [lead['fresh2']] }, A.token);
  assert.equal(other.status, 404, other.text);
  const inactive = await enroll(seq['inactive']!, { leadIds: [lead['fresh2']] }, A.token);
  assert.equal(inactive.status, 400, inactive.text);
  assert.match(inactive.text, /not active/);
  const empty = await enroll(seq['empty']!, { leadIds: [lead['fresh2']] }, A.token);
  assert.equal(empty.status, 400, empty.text);
  assert.match(empty.text, /no steps/);
  for (const id of [seq['otherOrg']!, seq['inactive']!, seq['empty']!]) {
    assert.equal((await enrolmentsIn(id)).length, 0);
  }
});

test('the body must be leadIds or a filter; a session is required', async () => {
  assert.equal((await enroll(seq['main']!, { leadIds: [lead['fresh2']], filter: {} }, A.token)).status, 400);
  assert.equal((await enroll(seq['main']!, {}, A.token)).status, 400);
  assert.equal((await enroll(seq['main']!, { leadIds: [lead['fresh2']] })).status, 401);
});
