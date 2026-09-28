import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import bcrypt from 'bcrypt';
import { AuthModule } from '../../auth/auth.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { AgentsModule } from './agents.module';

/**
 * Integration suite against the real database, in the same shape as
 * auth/auth.test.ts: every row it creates is torn down in after(), and emails
 * are namespaced per run so a crashed run cannot collide with the next one.
 *
 * Run with `npm run test:agents`, which supplies --env-file and NODE_ENV=test
 * (the latter makes the credential rate limiters inert — this suite signs up
 * more accounts than the hourly cap allows).
 *
 * Boots AuthModule + AgentsModule rather than AppModule: the full graph would
 * also start the delivery worker and the lead watcher, which would poll a
 * shared database for the length of the run.
 *
 * Two organizations are created on purpose. Tenant isolation cannot be
 * demonstrated with one — every query trivially passes.
 */

const RUN = Date.now().toString(36);
const emailFor = (tag: string): string => `agenttest-${RUN}-${tag}@example.invalid`;
const PASSWORD = 'correct-horse-battery-staple';

let app: INestApplication;
let prisma: PrismaService;
let base: string;

const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];

/** Every response body the suite has seen, for the password sweep at the end. */
const allResponseBodies: string[] = [];

interface Res {
  status: number;
  body: Record<string, unknown>;
  text: string;
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.token !== undefined) headers['authorization'] = `Bearer ${opts.token}`;

  const res = await fetch(base + path, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });

  const text = await res.text();
  allResponseBodies.push(text);

  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // non-JSON response; the raw text is still asserted on
  }
  return { status: res.status, body, text };
}

const errCode = (res: Res): unknown => (res.body['error'] as Record<string, unknown> | undefined)?.['code'];

interface Member {
  id: string;
  email: string;
  role: string;
  status: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  memberSince: string | null;
  timezone: string;
  hasProfile: boolean;
  activeLeads: number;
  calendarLinked: boolean;
}

async function signupOwner(tag: string, org: string): Promise<{ token: string; userId: string; orgId: string }> {
  const res = await call('POST', '/api/auth/signup', {
    body: { email: emailFor(tag), password: PASSWORD, firstName: 'Own', lastName: 'Er', organizationName: org },
  });
  assert.equal(res.status, 201, `signup(${tag}) failed: ${res.text}`);

  const user = res.body['user'] as { id: string };
  const organization = res.body['organization'] as { id: string };
  createdUserIds.push(user.id);
  createdOrgIds.push(organization.id);
  return { token: res.body['token'] as string, userId: user.id, orgId: organization.id };
}

/** Owner A and B, plus one agent inside A. */
let ownerA = { token: '', userId: '', orgId: '' };
let ownerB = { token: '', userId: '', orgId: '' };
let agentAId = '';
let agentAToken = '';
const AGENT_A_EMAIL = (): string => emailFor('agent-a');

before(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, AuthModule, AgentsModule],
  }).compile();

  app = moduleRef.createNestApplication();
  // The filter is what turns AppError into the {error:{code}} envelope every
  // assertion below reads, so the suite installs it exactly as main does.
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.listen(0, '127.0.0.1');

  base = await app.getUrl();
  prisma = app.get(PrismaService);

  ownerA = await signupOwner('owner-a', `Agents Test A ${RUN}`);
  ownerB = await signupOwner('owner-b', `Agents Test B ${RUN}`);
});

after(async () => {
  // Organizations cascade to memberships and agent profiles; users are deleted
  // separately because they are not owned by an organization.
  if (createdOrgIds.length > 0) {
    await prisma.organizations.deleteMany({ where: { id: { in: createdOrgIds } } });
  }
  if (createdUserIds.length > 0) {
    await prisma.users.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await app.close();
});

// --- authentication and authorization ---------------------------------------

test('unauthenticated requests are rejected on every route', async () => {
  const list = await call('GET', '/api/agents');
  const create = await call('POST', '/api/agents', { body: { email: emailFor('nope'), password: PASSWORD, firstName: 'A', lastName: 'B' } });
  const patch = await call('PATCH', `/api/agents/${ownerA.userId}`, { body: { status: 'suspended' } });

  for (const res of [list, create, patch]) {
    assert.equal(res.status, 401, res.text);
    assert.equal(errCode(res), 'UNAUTHENTICATED');
  }
});

test('a garbage bearer token is rejected, not treated as anonymous', async () => {
  const res = await call('GET', '/api/agents', { token: 'not-a-jwt' });
  assert.equal(res.status, 401, res.text);
});

// --- listing ----------------------------------------------------------------

test('owner lists their own organization, owner first', async () => {
  const res = await call('GET', '/api/agents', { token: ownerA.token });
  assert.equal(res.status, 200, res.text);

  const members = res.body as unknown as Member[];
  assert.ok(Array.isArray(members));
  assert.equal(members.length, 1);
  assert.equal(members[0].id, ownerA.userId);
  assert.equal(members[0].role, 'owner');
  assert.equal(members[0].status, 'active');
  // Signup creates no agent_profiles row, so the owner falls back to the
  // organization's timezone.
  assert.equal(members[0].hasProfile, false);
  assert.ok(members[0].timezone.length > 0);
});

test('the roster never carries a password hash', async () => {
  const res = await call('GET', '/api/agents', { token: ownerA.token });
  assert.ok(!res.text.includes('password'), res.text);
  assert.ok(!res.text.includes('$2b$'), res.text);
});

// --- creation ---------------------------------------------------------------

test('owner creates an agent: user + membership + profile, and nothing else', async () => {
  const res = await call('POST', '/api/agents', {
    token: ownerA.token,
    body: { email: AGENT_A_EMAIL(), password: PASSWORD, firstName: 'Nia', lastName: 'Newton', phone: '512-555-0199' },
  });

  assert.equal(res.status, 201, res.text);
  const created = res.body as unknown as Member;
  createdUserIds.push(created.id);
  agentAId = created.id;

  assert.equal(created.role, 'agent');
  assert.equal(created.status, 'active');
  assert.equal(created.email, AGENT_A_EMAIL());
  assert.equal(created.phone, '512-555-0199');
  // Roster fields, all read from rows that exist. Zero and false here are facts
  // about empty tables, not placeholders.
  assert.equal(created.hasProfile, true);
  assert.equal(created.activeLeads, 0);
  assert.equal(created.calendarLinked, false);
  assert.ok(created.timezone.length > 0);
  assert.ok(created.memberSince);

  const member = await prisma.organization_members.findFirst({
    where: { organization_id: ownerA.orgId, user_id: created.id },
  });
  assert.ok(member, 'membership row missing');
  assert.equal(member.organization_id, ownerA.orgId, 'agent landed in the wrong organization');
  assert.equal(member.role, 'agent');
  assert.equal(member.status, 'active');

  const profile = await prisma.agent_profiles.findFirst({
    where: { organization_id: ownerA.orgId, user_id: created.id },
  });
  assert.ok(profile, 'agent_profiles row missing');
  assert.equal(profile.display_name, 'Nia Newton');

  // Scheduling and territories are separate features: no rows now.
  assert.equal(await prisma.agent_availability.count({ where: { agent_id: profile.id } }), 0);
  assert.equal(await prisma.agent_territories.count({ where: { agent_id: profile.id } }), 0);
});

test('the initial password is stored as a bcrypt hash and is never echoed', async () => {
  const user = await prisma.users.findUnique({ where: { id: agentAId } });
  assert.ok(user);
  assert.ok(user.password_hash, 'no password hash stored');
  assert.notEqual(user.password_hash, PASSWORD);
  assert.match(user.password_hash, /^\$2[aby]\$\d{2}\$/);
  assert.ok(await bcrypt.compare(PASSWORD, user.password_hash), 'stored hash does not verify');
});

test('the new agent can sign in with the password the owner set', async () => {
  const res = await call('POST', '/api/auth/login', { body: { email: AGENT_A_EMAIL(), password: PASSWORD } });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body['role'], 'agent');
  agentAToken = res.body['token'] as string;
});

test('an agent may not list or manage members', async () => {
  const list = await call('GET', '/api/agents', { token: agentAToken });
  assert.equal(list.status, 403, list.text);
  assert.equal(errCode(list), 'FORBIDDEN');

  const create = await call('POST', '/api/agents', {
    token: agentAToken,
    body: { email: emailFor('by-agent'), password: PASSWORD, firstName: 'No', lastName: 'Way' },
  });
  assert.equal(create.status, 403, create.text);

  const patch = await call('PATCH', `/api/agents/${ownerA.userId}`, {
    token: agentAToken,
    body: { status: 'suspended' },
  });
  assert.equal(patch.status, 403, patch.text);
});

test('the roster now shows the owner then the agent', async () => {
  const res = await call('GET', '/api/agents', { token: ownerA.token });
  const members = res.body as unknown as Member[];

  assert.equal(members.length, 2);
  assert.deepEqual(
    members.map((m) => m.role),
    ['owner', 'agent'],
  );
});

// --- input contract ---------------------------------------------------------

test('a duplicate email is a 409, case-insensitively', async () => {
  const same = await call('POST', '/api/agents', {
    token: ownerA.token,
    body: { email: AGENT_A_EMAIL(), password: PASSWORD, firstName: 'Dup', lastName: 'Licate' },
  });
  assert.equal(same.status, 409, same.text);
  assert.equal(errCode(same), 'EMAIL_TAKEN');

  const upper = await call('POST', '/api/agents', {
    token: ownerA.token,
    body: { email: AGENT_A_EMAIL().toUpperCase(), password: PASSWORD, firstName: 'Dup', lastName: 'Licate' },
  });
  assert.equal(upper.status, 409, upper.text);

  // And no half-created rows from either attempt.
  const count = await prisma.users.count({ where: { email: { equals: AGENT_A_EMAIL(), mode: 'insensitive' } } });
  assert.equal(count, 1);
});

test('malformed input is a 400', async () => {
  const cases: Array<Record<string, unknown>> = [
    { email: 'not-an-email', password: PASSWORD, firstName: 'A', lastName: 'B' },
    { email: emailFor('short-pw'), password: 'short', firstName: 'A', lastName: 'B' },
    { email: emailFor('no-name'), password: PASSWORD, firstName: '', lastName: 'B' },
    { password: PASSWORD, firstName: 'A', lastName: 'B' },
  ];

  for (const body of cases) {
    const res = await call('POST', '/api/agents', { token: ownerA.token, body });
    assert.equal(res.status, 400, `${JSON.stringify(body)} -> ${res.text}`);
    assert.equal(errCode(res), 'VALIDATION_ERROR');
  }
});

test('a client-supplied role or organization id is rejected outright', async () => {
  for (const extra of [{ role: 'owner' }, { organizationId: ownerB.orgId }, { organization_id: ownerB.orgId }]) {
    const res = await call('POST', '/api/agents', {
      token: ownerA.token,
      body: { email: emailFor('escalate'), password: PASSWORD, firstName: 'Esc', lastName: 'Alate', ...extra },
    });
    assert.equal(res.status, 400, `${JSON.stringify(extra)} -> ${res.text}`);
  }

  // Nothing was created by any of those attempts.
  assert.equal(await prisma.users.count({ where: { email: emailFor('escalate') } }), 0);
  // And organization B gained no members.
  assert.equal(await prisma.organization_members.count({ where: { organization_id: ownerB.orgId } }), 1);
});

// --- tenant isolation -------------------------------------------------------

test('a roster contains only its own organization', async () => {
  const a = (await call('GET', '/api/agents', { token: ownerA.token })).body as unknown as Member[];
  const b = (await call('GET', '/api/agents', { token: ownerB.token })).body as unknown as Member[];

  assert.equal(b.length, 1);
  assert.equal(b[0].id, ownerB.userId);

  const aIds = new Set(a.map((m) => m.id));
  assert.ok(!aIds.has(ownerB.userId), "organization A can see organization B's owner");
  assert.ok(!b.some((m) => aIds.has(m.id)), "organization B can see organization A's members");
});

test("an owner cannot suspend another organization's member", async () => {
  const res = await call('PATCH', `/api/agents/${agentAId}`, {
    token: ownerB.token,
    body: { status: 'suspended' },
  });

  // 404, not 403: confirming the user exists would leak across the tenant line.
  assert.equal(res.status, 404, res.text);
  assert.equal(errCode(res), 'NOT_FOUND');

  const member = await prisma.organization_members.findFirst({
    where: { organization_id: ownerA.orgId, user_id: agentAId },
  });
  assert.equal(member?.status, 'active', "another organization's owner changed this membership");
});

// --- suspension -------------------------------------------------------------

test('an owner cannot suspend themselves', async () => {
  const res = await call('PATCH', `/api/agents/${ownerA.userId}`, {
    token: ownerA.token,
    body: { status: 'suspended' },
  });
  assert.equal(res.status, 403, res.text);
  assert.equal(errCode(res), 'FORBIDDEN');
});

test('an unknown user id is a 404, and a malformed one a 400', async () => {
  const unknown = await call('PATCH', '/api/agents/00000000-0000-4000-8000-000000000000', {
    token: ownerA.token,
    body: { status: 'suspended' },
  });
  assert.equal(unknown.status, 404, unknown.text);

  const malformed = await call('PATCH', '/api/agents/not-a-uuid', {
    token: ownerA.token,
    body: { status: 'suspended' },
  });
  assert.equal(malformed.status, 400, malformed.text);
});

test('only status: suspended is accepted', async () => {
  for (const body of [{ status: 'active' }, { role: 'owner' }, {}]) {
    const res = await call('PATCH', `/api/agents/${agentAId}`, { token: ownerA.token, body });
    assert.equal(res.status, 400, `${JSON.stringify(body)} -> ${res.text}`);
  }
});

test('owner suspends the agent, and the change is persisted', async () => {
  const res = await call('PATCH', `/api/agents/${agentAId}`, {
    token: ownerA.token,
    body: { status: 'suspended' },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal((res.body as unknown as Member).status, 'suspended');

  const member = await prisma.organization_members.findFirst({
    where: { organization_id: ownerA.orgId, user_id: agentAId },
  });
  assert.equal(member?.status, 'suspended');

  // Nothing was deleted: the user and the profile are untouched.
  assert.ok(await prisma.users.findUnique({ where: { id: agentAId } }));
  assert.ok(
    await prisma.agent_profiles.findFirst({ where: { organization_id: ownerA.orgId, user_id: agentAId } }),
  );
});

test("a suspended agent's existing token stops working immediately", async () => {
  // Inherited from AuthService.loadAuthContext, which joins
  // organization_members ON status = 'active' on every request — not a second
  // mechanism added by this feature.
  const me = await call('GET', '/api/auth/me', { token: agentAToken });
  assert.equal(me.status, 403, me.text);
  assert.equal(errCode(me), 'NO_ORGANIZATION');

  const login = await call('POST', '/api/auth/login', { body: { email: AGENT_A_EMAIL(), password: PASSWORD } });
  assert.equal(login.status, 403, login.text);
});

test('no response in this suite contained a password or a hash', () => {
  for (const body of allResponseBodies) {
    assert.ok(!body.includes(PASSWORD), `a response echoed the password: ${body}`);
    assert.ok(!body.includes('$2b$'), `a response contained a bcrypt hash: ${body}`);
    assert.ok(!body.includes('password_hash'), `a response named password_hash: ${body}`);
  }
});
