import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import bcrypt from 'bcrypt';
import { envSchema } from '../../app.module';
import { AuthModule } from '../../auth/auth.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { FollowupModule } from './followup.module';

/**
 * Integration suite for the sequence reads — GET /api/v1/sequences (the
 * Follow-ups screen) and GET /api/v1/sequences/:id — against the real
 * database. Run with `npm run test:followup-sequences`.
 *
 * Pins the whole answer: which sequences, in which order, each with its steps,
 * its enrolment triggers and its enrolment counts by status.
 */

// FollowupModule pulls in TelnyxModule. Nothing here may start the background
// pollers against the shared database, whatever the developer's .env says.
process.env['STRATEGY_ENGINE'] = '0';
process.env['CALENDAR_SYNC'] = '0';
process.env['WORKER_ENABLED'] = 'false';

const RUN = Date.now().toString(36);
const emailFor = (tag: string): string => `followup-seq-${RUN}-${tag}@example.invalid`;
const PASSWORD = 'correct-horse-battery-staple';
const MISSING = '00000000-0000-4000-8000-000000000000';
/** Live enrolments are due far in the future, so no follow-up runner sharing this database treats them as due. */
const SOMEDAY = new Date('2099-01-01T00:00:00.000Z');

let app: INestApplication;
let prisma: PrismaService;
let base: string;

const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];

async function call(path: string, token?: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; text: string }> {
  const res = await fetch(base + path, {
    method: init.method ?? 'GET',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  return { status: res.status, text: await res.text() };
}

async function signupOwner(tag: string) {
  const res = await call('/api/auth/signup', undefined, {
    method: 'POST',
    body: { email: emailFor(tag), password: PASSWORD, firstName: 'Owner', lastName: tag, organizationName: `FollowupSeq ${tag} ${RUN}`, teamSize: 'team' },
  });
  assert.equal(res.status, 201, res.text);
  const b = JSON.parse(res.text);
  createdUserIds.push(b.user.id);
  createdOrgIds.push(b.organization.id);
  return { token: b.token as string, orgId: b.organization.id as string };
}

let A = { token: '', orgId: '' };
let B = { token: '', orgId: '' };
let C = { token: '', orgId: '' };
let agentToken = '';
const seq: Record<string, string> = {};
/** Organization A's list, exactly as it must be sent. */
let listBody = '';

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
  C = await signupOwner('c-none');

  const agent = await prisma.users.create({
    data: { email: emailFor('agent'), first_name: 'Agent', last_name: 'A', password_hash: await bcrypt.hash(PASSWORD, 4) },
    select: { id: true },
  });
  createdUserIds.push(agent.id);
  await prisma.organization_members.create({ data: { organization_id: A.orgId, user_id: agent.id, role: 'agent', status: 'active' } });
  const login = await call('/api/auth/login', undefined, { method: 'POST', body: { email: emailFor('agent'), password: PASSWORD } });
  assert.equal(login.status, 200, login.text);
  agentToken = JSON.parse(login.text).token;

  const created = (day: number) => new Date(`2026-08-0${day}T00:00:00.000Z`);
  const sequence = async (
    orgId: string,
    code: string,
    data: { name: string; status: string; description?: string; day: number },
    steps: Array<{ order: number; action: 'sms' | 'voice'; delay: number; text: string; attempts?: number }>,
    triggers: Array<[string, boolean]>,
  ) => {
    const s = await prisma.followup_sequences.create({
      data: {
        organization_id: orgId, code: `${code}_${RUN}`.toUpperCase(), name: data.name, status: data.status,
        description: data.description ?? null, created_at: created(data.day),
      },
      select: { id: true },
    });
    for (const st of steps) {
      await prisma.sequence_steps.create({
        data: {
          organization_id: orgId, sequence_id: s.id, step_order: st.order, action_type: st.action, delay_minutes: st.delay,
          message_template: st.action === 'sms' ? st.text : null, voice_prompt: st.action === 'voice' ? st.text : null,
          max_attempts: st.attempts ?? 1,
        },
      });
    }
    for (const [trigger, active] of triggers) {
      await prisma.sequence_enroll_triggers.create({ data: { organization_id: orgId, sequence_id: s.id, trigger, active } });
    }
    return s.id;
  };

  // Inserted out of order — sequences, steps and triggers alike — so every
  // order in the answer is the query's doing.
  seq['empty'] = await sequence(A.orgId, 'empty', { name: 'Empty shell', status: 'archived', day: 3 }, [], []);
  seq['warm'] = await sequence(
    A.orgId,
    'warm',
    { name: 'Warm nurture', status: 'active', description: 'After a warm qualification', day: 1 },
    [
      { order: 3, action: 'sms', delay: 4320, text: 'Last note' },
      { order: 1, action: 'sms', delay: 1440, text: 'Hi {{first_name}} — "still" looking?' },
      { order: 2, action: 'voice', delay: 2880, text: 'Ask about timing', attempts: 2 },
    ],
    [['qualified_warm', true], ['no_answer', true]],
  );
  seq['cold'] = await sequence(A.orgId, 'cold', { name: 'Cold reactivation', status: 'inactive', day: 2 }, [{ order: 1, action: 'voice', delay: 10080, text: 'Reactivation call', attempts: 3 }], [['qualified_cold', false]]);
  seq['otherOrg'] = await sequence(B.orgId, 'other', { name: 'Org B', status: 'active', day: 1 }, [{ order: 1, action: 'sms', delay: 60, text: 'B' }], []);

  const leads = async (orgId: string, n: number) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      ids.push((await prisma.leads.create({ data: { organization_id: orgId, status: 'nurture', first_name: `L${i}` }, select: { id: true } })).id);
    }
    return ids;
  };
  const la = await leads(A.orgId, 8);
  const lb = await leads(B.orgId, 1);
  const enrol = (orgId: string, sequenceId: string, leadId: string, status: string) =>
    prisma.sequence_enrollments.create({
      data: { organization_id: orgId, sequence_id: sequenceId, lead_id: leadId, status, enrolled_by: 'manual', next_action_at: status === 'active' ? SOMEDAY : null },
    });
  // Warm: 2 active, 1 paused, 3 completed, 1 stopped. Cold: 1 completed.
  for (const [i, status] of (['active', 'active', 'paused', 'completed', 'completed', 'completed', 'stopped'] as const).entries()) {
    await enrol(A.orgId, seq['warm']!, la[i]!, status);
  }
  await enrol(A.orgId, seq['cold']!, la[7]!, 'completed');
  await enrol(B.orgId, seq['otherOrg']!, lb[0]!, 'active');

  const entry = (id: string, code: string, rest: Record<string, unknown>) => ({ id, code: `${code}_${RUN}`.toUpperCase(), ...rest });
  listBody = JSON.stringify([
    entry(seq['warm']!, 'warm', {
      name: 'Warm nurture', description: 'After a warm qualification', status: 'active',
      enrollTriggers: ['no_answer', 'qualified_warm'],
      activeCount: 2, pausedCount: 1, completedCount: 3, stoppedCount: 1,
      createdAt: '2026-08-01T00:00:00.000Z',
      steps: [
        { stepOrder: 1, actionType: 'sms', delayMinutes: 1440, messageTemplate: 'Hi {{first_name}} — "still" looking?', voicePrompt: null, maxAttempts: 1 },
        { stepOrder: 2, actionType: 'voice', delayMinutes: 2880, messageTemplate: null, voicePrompt: 'Ask about timing', maxAttempts: 2 },
        { stepOrder: 3, actionType: 'sms', delayMinutes: 4320, messageTemplate: 'Last note', voicePrompt: null, maxAttempts: 1 },
      ],
    }),
    entry(seq['cold']!, 'cold', {
      name: 'Cold reactivation', description: null, status: 'inactive',
      // Listed even though it is not in force: the screen shows the configuration.
      enrollTriggers: ['qualified_cold'],
      activeCount: 0, pausedCount: 0, completedCount: 1, stoppedCount: 0,
      createdAt: '2026-08-02T00:00:00.000Z',
      steps: [{ stepOrder: 1, actionType: 'voice', delayMinutes: 10080, messageTemplate: null, voicePrompt: 'Reactivation call', maxAttempts: 3 }],
    }),
    entry(seq['empty']!, 'empty', {
      name: 'Empty shell', description: null, status: 'archived', enrollTriggers: [],
      activeCount: 0, pausedCount: 0, completedCount: 0, stoppedCount: 0,
      createdAt: '2026-08-03T00:00:00.000Z', steps: [],
    }),
  ]);
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

test('the list: every sequence, oldest first, with ordered steps and triggers and counts by status — exactly as sent', async () => {
  const res = await call('/api/v1/sequences', A.token);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.text, listBody);
});

test('an agent of the organization reads the same list', async () => {
  const res = await call('/api/v1/sequences', agentToken);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.text, listBody);
});

test('each organization sees only its own sequences; one with none gets an empty list', async () => {
  const b = await call('/api/v1/sequences', B.token);
  assert.equal(b.status, 200, b.text);
  const bList = JSON.parse(b.text) as Array<{ id: string; activeCount: number }>;
  assert.deepEqual(bList.map((s) => [s.id, s.activeCount]), [[seq['otherOrg'], 1]]);

  const c = await call('/api/v1/sequences', C.token);
  assert.equal(c.status, 200, c.text);
  assert.equal(c.text, '[]');
});

test('one sequence answers exactly as its list entry; another organization’s or an unknown one is a 404', async () => {
  const list = JSON.parse(listBody) as unknown[];
  for (const [i, key] of (['warm', 'cold', 'empty'] as const).entries()) {
    const res = await call(`/api/v1/sequences/${seq[key]}`, A.token);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.text, JSON.stringify(list[i]));
  }
  const viaAgent = await call(`/api/v1/sequences/${seq['warm']}`, agentToken);
  assert.equal(viaAgent.text, JSON.stringify(list[0]));

  for (const [id, token] of [
    [seq['otherOrg']!, A.token],
    [seq['warm']!, B.token],
    [MISSING, A.token],
  ] as const) {
    const res = await call(`/api/v1/sequences/${id}`, token);
    assert.equal(res.status, 404, res.text);
    assert.equal(res.text, '{"error":{"code":"NOT_FOUND","message":"No such sequence"}}');
  }
  const malformed = await call('/api/v1/sequences/not-a-uuid', A.token);
  assert.equal(malformed.status, 400, malformed.text);
});

test("an owner's edit answers with the sequence exactly as the list then shows it", async () => {
  const res = await call(`/api/v1/sequences/${seq['cold']}`, A.token, { method: 'PATCH', body: { name: 'Cold, renamed' } });
  assert.equal(res.status, 200, res.text);
  const list = JSON.parse((await call('/api/v1/sequences', A.token)).text) as Array<{ id: string; name: string }>;
  const listed = list.find((s) => s.id === seq['cold']);
  assert.equal(listed?.name, 'Cold, renamed');
  assert.equal(res.text, JSON.stringify(listed));
});

test('no session, or a garbage one, is a 401', async () => {
  for (const token of [undefined, 'not-a-token']) {
    const res = await call('/api/v1/sequences', token);
    assert.equal(res.status, 401, res.text);
  }
});
