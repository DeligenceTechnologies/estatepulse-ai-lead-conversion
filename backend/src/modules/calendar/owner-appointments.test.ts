import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import bcrypt from 'bcrypt';
import { AuthModule } from '../../auth/auth.module';
import { envSchema } from '../../app.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { CalendarModule } from './calendar.module';

/**
 * Integration suite for GET /api/appointments — the owner's appointment list —
 * and GET /api/agents/me/appointments — an agent's own, the same query with the
 * agent forced to theirs — against the real database. Run with
 * `npm run test:owner-appointments`.
 *
 * Pins the whole answer: which appointments (this organization, the date
 * window, the filters, at most 500), in start-time order, each with its lead
 * and agent. Appointments starting at the same moment have no defined order
 * among themselves, so those are compared as a group.
 */

// CalendarModule pulls in TelnyxModule. Nothing here may start the background
// pollers against the shared database, whatever the developer's .env says.
process.env['STRATEGY_ENGINE'] = '0';
process.env['CALENDAR_SYNC'] = '0';
process.env['WORKER_ENABLED'] = 'false';

const RUN = Date.now().toString(36);
const emailFor = (tag: string): string => `owner-appts-${RUN}-${tag}@example.invalid`;
const PASSWORD = 'correct-horse-battery-staple';
const DAY = 86400e3;
/** Whole minutes from now, so start times are easy to reason about. */
const NOW = Math.floor(Date.now() / 60e3) * 60e3;

let app: INestApplication;
let prisma: PrismaService;
let base: string;

const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];

type Row = Record<string, unknown> & { id: string; startTime: string };

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
    body: { email: emailFor(tag), password: PASSWORD, firstName: 'Own', lastName: 'Er', organizationName: `OwnerAppts ${tag} ${RUN}`, teamSize: 'team' },
  });
  assert.equal(res.status, 201, res.text);
  const body = JSON.parse(res.text);
  createdUserIds.push(body.user.id);
  createdOrgIds.push(body.organization.id);
  return { token: body.token as string, orgId: body.organization.id as string };
}

/** An agent with a profile in `orgId`; signed in if `login`. */
async function agent(orgId: string, tag: string, displayName: string, login = false) {
  const user = await prisma.users.create({
    data: { email: emailFor(tag), first_name: 'Agent', last_name: tag, password_hash: await bcrypt.hash(PASSWORD, 4) },
    select: { id: true },
  });
  createdUserIds.push(user.id);
  await prisma.organization_members.create({ data: { organization_id: orgId, user_id: user.id, role: 'agent', status: 'active' } });
  const profile = await prisma.agent_profiles.create({ data: { organization_id: orgId, user_id: user.id, display_name: displayName }, select: { id: true } });
  let token = '';
  if (login) {
    const res = await call('/api/auth/login', undefined, { method: 'POST', body: { email: emailFor(tag), password: PASSWORD } });
    assert.equal(res.status, 200, res.text);
    token = JSON.parse(res.text).token;
  }
  return { profileId: profile.id, token };
}

let ownerA = { token: '', orgId: '' };
let ownerB = { token: '', orgId: '' };
let agentToken = '';
let annId = '';
let bobId = '';
let leadIds: Record<string, string> = {};
let otherOrg = { agentId: '', leadId: '', agentToken: '' };
/** Every appointment of org A, as the list must send it, in start-time order. */
const all: Row[] = [];
const inDefaultWindow = () => all.filter((r) => r['window'] === true).map(({ window: _w, ...r }) => r as Row);

before(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, validate: (raw) => ({ ...raw, ...envSchema.parse(raw) }) }),
      PrismaModule,
      AuthModule,
      CalendarModule,
    ],
  }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  prisma = app.get(PrismaService);

  ownerA = await signupOwner('owner-a');
  ownerB = await signupOwner('owner-b');
  const ann = await agent(ownerA.orgId, 'ann', 'Ann Agent', true);
  agentToken = ann.token;
  annId = ann.profileId;
  bobId = (await agent(ownerA.orgId, 'bob', 'Bob Broker')).profileId;

  const lead = async (orgId: string, data: Record<string, unknown>) =>
    (await prisma.leads.create({ data: { organization_id: orgId, ...data }, select: { id: true } })).id;
  leadIds = {
    named: await lead(ownerA.orgId, { status: 'qualified', first_name: 'Bea', last_name: 'Buyer', email: 'bea@example.invalid', phone: '+15125550101' }),
    emailOnly: await lead(ownerA.orgId, { status: 'new', email: 'only@example.invalid' }),
    phoneOnly: await lead(ownerA.orgId, { status: 'contacted', phone: '+15125550102' }),
    nothing: await lead(ownerA.orgId, { status: 'booked' }),
  };
  const leadView: Record<string, [string, string | null, string | null, string]> = {
    named: ['Bea Buyer', 'bea@example.invalid', '+15125550101', 'qualified'],
    emailOnly: ['only@example.invalid', 'only@example.invalid', null, 'new'],
    phoneOnly: ['+15125550102', null, '+15125550102', 'contacted'],
    nothing: ['Unnamed lead', null, null, 'booked'],
  };

  // Out of start-time order, two starting at the same moment, two outside the
  // default window (30 days back to 90 ahead).
  const specs: Array<[number, string, string, string, Record<string, unknown>, string | null, string | null]> = [
    // days from now, lead, agent, status, metadata, meeting url, notes
    [5, 'named', 'ann', 'scheduled', { eventTypeName: 'Buyer consult', cancelUrl: 'https://calendly.com/c/1', rescheduleUrl: 'https://calendly.com/r/1' }, 'https://zoom.example.invalid/1', 'Bring "pre-approval" — ünïcode'],
    [-20, 'emailOnly', 'bob', 'completed', {}, null, null],
    [1, 'phoneOnly', 'ann', 'cancelled', { canceledReason: 'Lead asked to move it', eventTypeName: 'Home tour' }, null, null],
    [1, 'nothing', 'bob', 'rescheduled', { eventTypeName: null, unrelated: true }, null, 'Second at the same time'],
    [60, 'named', 'bob', 'no_show', {}, 'https://zoom.example.invalid/2', null],
    [-40, 'named', 'ann', 'completed', {}, null, null],
    [100, 'emailOnly', 'ann', 'scheduled', {}, null, null],
  ];
  for (const [days, leadKey, agentKey, status, metadata, meetingUrl, notes] of specs) {
    const start = new Date(NOW + days * DAY);
    const end = new Date(start.getTime() + 45 * 60e3);
    const row = await prisma.appointments.create({
      data: {
        organization_id: ownerA.orgId, lead_id: leadIds[leadKey]!, agent_id: agentKey === 'ann' ? annId : bobId,
        provider: 'calendly', external_event_id: `ev-${RUN}-${all.length}`, status, start_at: start, end_at: end,
        meeting_url: meetingUrl, notes, metadata: metadata as never,
      },
      select: { id: true, created_at: true },
    });
    const [leadName, leadEmail, leadPhone, leadStatus] = leadView[leadKey]!;
    const meta = metadata as Record<string, string | null | undefined>;
    all.push({
      id: row.id, leadId: leadIds[leadKey]!, leadName, leadEmail, leadPhone, leadStatus,
      agentId: agentKey === 'ann' ? annId : bobId, agentName: agentKey === 'ann' ? 'Ann Agent' : 'Bob Broker',
      provider: 'calendly', externalEventId: `ev-${RUN}-${all.length}`, startTime: start.toISOString(), endTime: end.toISOString(),
      status, appointmentType: meta['eventTypeName'] ?? null, meetingUrl, notes, cancelUrl: meta['cancelUrl'] ?? null,
      rescheduleUrl: meta['rescheduleUrl'] ?? null, canceledReason: meta['canceledReason'] ?? null, createdAt: row.created_at.toISOString(),
      window: days >= -30 && days <= 90,
    });
  }
  all.sort((x, y) => (x.startTime < y.startTime ? -1 : x.startTime > y.startTime ? 1 : 0));

  // Another organization with an appointment of its own.
  const otherAgent = await agent(ownerB.orgId, 'other', 'Other Agent', true);
  const otherLead = await lead(ownerB.orgId, { status: 'new', first_name: 'Other' });
  await prisma.appointments.create({
    data: { organization_id: ownerB.orgId, lead_id: otherLead, agent_id: otherAgent.profileId, provider: 'calendly', start_at: new Date(NOW + DAY), end_at: new Date(NOW + DAY + 30 * 60e3) },
  });
  otherOrg = { agentId: otherAgent.profileId, leadId: otherLead, agentToken: otherAgent.token };
});

after(async () => {
  try {
    // Leads first: appointments cascade from them, and they RESTRICT the
    // agent-profile cascade that deleting the users sets off.
    await prisma.leads.deleteMany({ where: { organization_id: { in: createdOrgIds } } });
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
    await prisma.organizations.deleteMany({ where: { id: { in: createdOrgIds.filter((id) => !audited.has(id)) } } });
  } finally {
    await app.close();
  }
});

/** Row for row, except that appointments starting at the same moment may come in any order among themselves. */
function assertSameUpToTies(text: string, expected: Row[]) {
  const actual = JSON.parse(text) as Row[];
  assert.deepEqual(actual.map((r) => r.startTime), expected.map((r) => r.startTime));
  const groups = (rows: Row[]) => {
    const byStart = new Map<string, string[]>();
    for (const r of rows) byStart.set(r.startTime, [...(byStart.get(r.startTime) ?? []), JSON.stringify(r)].sort());
    return [...byStart.entries()];
  };
  assert.deepEqual(groups(actual), groups(expected));
}

const list = (query: string, token = ownerA.token) => call(`/api/appointments${query}`, token);

test('the list: appointments in the default window, by start time, each with its lead and agent — every field as sent', async () => {
  const res = await list('');
  assert.equal(res.status, 200, res.text);
  assertSameUpToTies(res.text, inDefaultWindow());
  assert.equal(JSON.parse(res.text).length, 5);
});

test('from and to set the window, inclusive at both ends', async () => {
  const everything = all.map(({ window: _w, ...r }) => r as Row);
  const wide = await list(`?from=${new Date(NOW - 50 * DAY).toISOString()}&to=${new Date(NOW + 120 * DAY).toISOString()}`);
  assertSameUpToTies(wide.text, everything);

  const exact = everything.filter((r) => r.startTime === new Date(NOW + 5 * DAY).toISOString());
  const edge = await list(`?from=${exact[0]!.startTime}&to=${exact[0]!.startTime}`);
  assertSameUpToTies(edge.text, exact);

  const backwards = await list(`?from=${new Date(NOW + DAY).toISOString()}&to=${new Date(NOW - DAY).toISOString()}`);
  assert.equal(backwards.text, '[]');
});

test('status, agentId and leadId narrow the list, and together they intersect', async () => {
  const window = inDefaultWindow();
  for (const [query, keep] of [
    ['?status=scheduled', (r: Row) => r['status'] === 'scheduled'],
    [`?agentId=${bobId}`, (r: Row) => r['agentId'] === bobId],
    [`?leadId=${leadIds['named']}`, (r: Row) => r['leadId'] === leadIds['named']],
    [`?agentId=${bobId}&leadId=${leadIds['named']}`, (r: Row) => r['agentId'] === bobId && r['leadId'] === leadIds['named']],
    ['?status=nonsense', () => false],
  ] as const) {
    const res = await list(query);
    assert.equal(res.status, 200, `${query}: ${res.text}`);
    assertSameUpToTies(res.text, window.filter(keep));
  }
});

test("another organization's appointments, agents and leads are never in the list", async () => {
  const ownIds = new Set(all.map((r) => r.id));
  const theirs = JSON.parse((await list('', ownerB.token)).text) as Row[];
  assert.equal(theirs.length, 1);
  assert.ok(!ownIds.has(theirs[0]!.id));

  for (const query of [`?agentId=${otherOrg.agentId}`, `?leadId=${otherOrg.leadId}`]) {
    const res = await list(query);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.text, '[]');
  }
});

test('malformed filters are a 400, an agent is refused, and no session is a 401', async () => {
  for (const query of ['?agentId=not-a-uuid', '?leadId=nope', '?from=yesterday-ish', `?status=${'x'.repeat(30)}`]) {
    const res = await list(query);
    assert.equal(res.status, 400, `${query}: ${res.text}`);
  }
  assert.equal((await list('', agentToken)).status, 403);
  assert.equal((await call('/api/appointments')).status, 401);
});

test('at most 500, the earliest first', async () => {
  const many = await signupOwner('many');
  const theAgent = await agent(many.orgId, 'many-agent', 'Many Agent');
  const theLead = (await prisma.leads.create({ data: { organization_id: many.orgId, status: 'new' }, select: { id: true } })).id;
  await prisma.appointments.createMany({
    data: Array.from({ length: 502 }, (_, i) => (i * 7) % 502).map((m) => ({
      organization_id: many.orgId, lead_id: theLead, agent_id: theAgent.profileId, provider: 'calendly',
      start_at: new Date(NOW + DAY + m * 60e3), end_at: new Date(NOW + DAY + m * 60e3 + 30 * 60e3),
    })),
  });

  const res = await list('', many.token);
  assert.equal(res.status, 200, res.text.slice(0, 200));
  assert.deepEqual(
    (JSON.parse(res.text) as Row[]).map((r) => r.startTime),
    Array.from({ length: 500 }, (_, m) => new Date(NOW + DAY + m * 60e3).toISOString()),
  );
});

// --- an agent's own: GET /api/agents/me/appointments ---------------------------

const mine = (query: string, token = agentToken) => call(`/api/agents/me/appointments${query}`, token);
const annsInWindow = () => inDefaultWindow().filter((r) => r['agentId'] === annId);

test("an agent's own list: only their appointments, in the default window, by start time — every field as sent", async () => {
  const res = await mine('');
  assert.equal(res.status, 200, res.text);
  assertSameUpToTies(res.text, annsInWindow());
  assert.equal(JSON.parse(res.text).length, 2);
});

test("an agent's own list: a colleague's agentId is ignored; status, leadId and the window narrow within their own", async () => {
  const ownEverything = all.filter((r) => r['agentId'] === annId).map(({ window: _w, ...r }) => r as Row);
  for (const [query, expected] of [
    [`?agentId=${bobId}`, annsInWindow()],
    ['?status=cancelled', annsInWindow().filter((r) => r['status'] === 'cancelled')],
    [`?leadId=${leadIds['named']}`, annsInWindow().filter((r) => r['leadId'] === leadIds['named'])],
    [`?leadId=${leadIds['nothing']}`, []],
    [`?from=${new Date(NOW - 50 * DAY).toISOString()}&to=${new Date(NOW + 120 * DAY).toISOString()}`, ownEverything],
  ] as const) {
    const res = await mine(query);
    assert.equal(res.status, 200, `${query}: ${res.text}`);
    assertSameUpToTies(res.text, [...expected]);
  }
});

test("an agent's own list: another organization's agent sees only their own", async () => {
  const res = await mine('', otherOrg.agentToken);
  assert.equal(res.status, 200, res.text);
  const rows = JSON.parse(res.text) as Row[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!['agentId'], otherOrg.agentId);
});

test("an agent's own list: an owner without an agent profile is refused, malformed filters are a 400, no session a 401", async () => {
  const owner = await mine('', ownerA.token);
  assert.equal(owner.status, 403, owner.text);
  for (const query of ['?agentId=not-a-uuid', '?leadId=nope', '?from=yesterday-ish']) {
    assert.equal((await mine(query)).status, 400, query);
  }
  assert.equal((await call('/api/agents/me/appointments')).status, 401);
});
