import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AuthModule } from '../../auth/auth.module';
import { hashPassword } from '../../auth/password';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { AgentsModule } from './agents.module';

/**
 * Integration suite pinning the GET /api/agents contract against the real
 * database. Run with `npm run test:agents-list`.
 *
 * Every field of every member, for a roster built to hit each rule: an owner
 * with and without a profile, agents active, suspended and invited, an agent
 * with no profile, a created_at tie, current and retired assignments, an office
 * calendar, and one person who belongs to two organizations with a profile in
 * each. Rows are inserted directly so their timestamps and states are exact.
 */

const RUN = Date.now().toString(36);
const emailFor = (tag: string): string => `agents-list-${RUN}-${tag}@example.invalid`;
const PASSWORD = 'correct-horse-battery-staple';

const KEYS = [
  'id', 'firstName', 'lastName', 'email', 'phone', 'role', 'status', 'memberSince', 'timezone', 'title',
  'maxActiveLeads', 'hasProfile', 'profileId', 'takingLeads', 'activeLeads', 'calendarLinked',
];

let app: INestApplication;
let prisma: PrismaService;
let base: string;

const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];

type Member = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function get(token?: string): Promise<{ status: number; body: Member[]; text: string }> {
  const res = await fetch(`${base}/api/agents`, token ? { headers: { authorization: `Bearer ${token}` } } : {});
  const text = await res.text();
  let body: Member[] = [];
  try {
    body = JSON.parse(text);
  } catch {
    // raw text is still in the assertion message
  }
  return { status: res.status, body, text };
}

async function post(path: string, body: unknown): Promise<Member> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  assert.ok(res.status < 300, JSON.stringify(json));
  return json;
}

async function signupOwner(tag: string, teamSize: 'solo' | 'team') {
  const body = await post('/api/auth/signup', {
    email: emailFor(tag), password: PASSWORD, firstName: 'Owner', lastName: tag,
    organizationName: `AgentsList ${tag} ${RUN}`, teamSize,
  });
  createdUserIds.push(body['user'].id);
  createdOrgIds.push(body['organization'].id);
  return { token: body['token'] as string, orgId: body['organization'].id as string, userId: body['user'].id as string };
}

const t0 = new Date(Date.now() - 3600e3);
const at = (min: number) => new Date(t0.getTime() + min * 60e3);

/** A member row, optionally with a profile in that organization. */
async function member(
  orgId: string,
  tag: string,
  opts: { status?: string; joined?: boolean; created: Date; profile?: Record<string, unknown>; userId?: string },
) {
  const userId =
    opts.userId ??
    (
      await prisma.users.create({
        data: { email: emailFor(tag), first_name: `First${tag}`, last_name: `Last${tag}`, password_hash: await hashPassword(PASSWORD) },
        select: { id: true },
      })
    ).id;
  if (!opts.userId) createdUserIds.push(userId);
  await prisma.organization_members.create({
    data: {
      organization_id: orgId, user_id: userId, role: 'agent', status: opts.status ?? 'active',
      joined_at: opts.joined === false ? null : new Date(opts.created.getTime() + 1000), created_at: opts.created,
    },
  });
  const profileId = opts.profile
    ? (
        await prisma.agent_profiles.create({
          data: { organization_id: orgId, user_id: userId, display_name: `Agent ${tag}`, ...opts.profile },
          select: { id: true },
        })
      ).id
    : null;
  return { userId, profileId };
}

let A = { token: '', orgId: '', userId: '' };
let B = { token: '', orgId: '', userId: '' };
const ids: Record<string, { userId: string; profileId: string | null }> = {};

before(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, AuthModule, AgentsModule],
  }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  prisma = app.get(PrismaService);

  A = await signupOwner('a', 'team'); // owner with no profile
  B = await signupOwner('b', 'solo'); // owner with a profile
  await prisma.organizations.update({ where: { id: A.orgId }, data: { timezone: 'Europe/London' } });

  ids['a1'] = await member(A.orgId, 'a1', { created: at(1), profile: { title: 'Senior', timezone: 'America/New_York', max_active_leads: 10, calendly_user_uri: 'https://api.calendly.com/users/A1' } });
  ids['a2'] = await member(A.orgId, 'a2', { status: 'suspended', created: at(2), profile: { routing_enabled: false, max_active_leads: 5, cal_user_id: 42 } });
  ids['a3'] = await member(A.orgId, 'a3', { status: 'invited', joined: false, created: at(3), profile: {} });
  ids['a4'] = await member(A.orgId, 'a4', { joined: false, created: at(3) }); // no profile; created_at ties a3
  // a1 also belongs to org B, with a different profile there.
  ids['a1b'] = await member(B.orgId, 'a1b', { created: at(5), userId: ids['a1']!.userId, profile: { title: 'B-title', max_active_leads: 3 } });

  await prisma.calendar_connections.create({ data: { organization_id: A.orgId, provider: 'calendly', status: 'active' } });

  const lead = async (orgId: string) => (await prisma.leads.create({ data: { organization_id: orgId }, select: { id: true } })).id;
  const assign = async (orgId: string, agentId: string, is_current: boolean) =>
    prisma.lead_assignments.create({
      data: { organization_id: orgId, lead_id: await lead(orgId), agent_id: agentId, assignment_type: 'manual', is_current },
    });
  await assign(A.orgId, ids['a1']!.profileId!, true);
  await assign(A.orgId, ids['a1']!.profileId!, true);
  await assign(A.orgId, ids['a1']!.profileId!, false); // retired: not counted
  await assign(A.orgId, ids['a2']!.profileId!, true); // suspended still holds it
  await assign(B.orgId, ids['a1b']!.profileId!, true); // org B's: never counted for A
});

after(async () => {
  try {
    await prisma.leads.deleteMany({ where: { organization_id: { in: createdOrgIds } } });
    await prisma.calendar_connections.deleteMany({ where: { organization_id: { in: createdOrgIds } } });
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

const pick = (m: Member) => ({
  role: m['role'], status: m['status'], timezone: m['timezone'], title: m['title'], maxActiveLeads: m['maxActiveLeads'],
  hasProfile: m['hasProfile'], takingLeads: m['takingLeads'], activeLeads: m['activeLeads'], calendarLinked: m['calendarLinked'],
});

test('owner first, then by membership created_at, then id; exact keys on every member', async () => {
  const res = await get(A.token);
  assert.equal(res.status, 200, res.text);
  for (const m of res.body) assert.deepEqual(Object.keys(m), KEYS);

  const tieByIdFirst = [ids['a3']!, ids['a4']!]; // same created_at: member id breaks the tie
  const tieOrder = (
    await prisma.organization_members.findMany({
      where: { organization_id: A.orgId, user_id: { in: tieByIdFirst.map((x) => x.userId) } },
      orderBy: { id: 'asc' },
      select: { user_id: true },
    })
  ).map((r) => r.user_id);
  assert.deepEqual(res.body.map((m) => m['id']), [A.userId, ids['a1']!.userId, ids['a2']!.userId, ...tieOrder]);
});

test('every field, per member, follows its rule', async () => {
  const byId = new Map((await get(A.token)).body.map((m) => [m['id'], m]));

  // Owner without a profile: org timezone, no cap, not taking leads.
  assert.deepEqual(pick(byId.get(A.userId)!), {
    role: 'owner', status: 'active', timezone: 'Europe/London', title: null, maxActiveLeads: null,
    hasProfile: false, takingLeads: false, activeLeads: 0, calendarLinked: false,
  });
  assert.equal(byId.get(A.userId)!['profileId'], null);

  // Current assignments only; linked on the office's provider.
  const a1 = byId.get(ids['a1']!.userId)!;
  assert.deepEqual(pick(a1), {
    role: 'agent', status: 'active', timezone: 'America/New_York', title: 'Senior', maxActiveLeads: 10,
    hasProfile: true, takingLeads: true, activeLeads: 2, calendarLinked: true,
  });
  assert.equal(a1['profileId'], ids['a1']!.profileId);
  assert.equal(a1['firstName'], 'Firsta1');
  assert.equal(a1['email'], emailFor('a1'));
  assert.equal(a1['memberSince'], new Date(at(1).getTime() + 1000).toISOString());

  // Suspended, paused, holding a lead; a Cal.com id does not count on a Calendly office.
  assert.deepEqual(pick(byId.get(ids['a2']!.userId)!), {
    role: 'agent', status: 'suspended', timezone: 'America/Chicago', title: null, maxActiveLeads: 5,
    hasProfile: true, takingLeads: false, activeLeads: 1, calendarLinked: false,
  });

  // Invited, never joined: memberSince falls back to the membership's created_at.
  const a3 = byId.get(ids['a3']!.userId)!;
  assert.equal(a3['status'], 'invited');
  assert.equal(a3['maxActiveLeads'], 25);
  assert.equal(a3['memberSince'], at(3).toISOString());

  // An agent with no profile.
  assert.deepEqual(pick(byId.get(ids['a4']!.userId)!), {
    role: 'agent', status: 'active', timezone: 'Europe/London', title: null, maxActiveLeads: null,
    hasProfile: false, takingLeads: false, activeLeads: 0, calendarLinked: false,
  });
});

test('another organization sees only its own members, profiles and counts', async () => {
  const b = await get(B.token);
  assert.equal(b.status, 200, b.text);
  assert.deepEqual(b.body.map((m) => m['id']), [B.userId, ids['a1']!.userId]);

  // Owner B took leads at signup.
  assert.equal(b.body[0]!['hasProfile'], true);
  // The same person, read through org B: org B's profile and only org B's lead.
  const a1InB = b.body[1]!;
  assert.equal(a1InB['profileId'], ids['a1b']!.profileId);
  assert.equal(a1InB['title'], 'B-title');
  assert.equal(a1InB['maxActiveLeads'], 3);
  assert.equal(a1InB['activeLeads'], 1);
  assert.equal(a1InB['calendarLinked'], false, 'org B has no calendar connected');

  const a = (await get(A.token)).body.map((m) => m['id']);
  assert.ok(!a.includes(B.userId));
});

test('the roster never carries a password hash', async () => {
  const res = await get(A.token);
  assert.ok(!/password/i.test(res.text));
});

test('an agent is forbidden; no token is unauthenticated', async () => {
  const login = await post('/api/auth/login', { email: emailFor('a1'), password: PASSWORD });
  const asAgent = await get(login['token'] as string);
  assert.equal(asAgent.status, 403, asAgent.text);
  assert.equal((await get()).status, 401);
});
