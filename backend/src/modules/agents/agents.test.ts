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
  try {
    // Users first, and the order is load-bearing. organization_members and
    // agent_profiles both cascade from users, and audit_logs.actor_id carries no
    // foreign key, so this removes everything the run owns without ever touching
    // an audit row. Deleting organizations first — as this hook used to — throws
    // before reaching here and leaves the users behind.
    if (createdUserIds.length > 0) {
      await prisma.users.deleteMany({ where: { id: { in: createdUserIds } } });
    }

    // An organization is only deletable while it has no audit rows: dropping one
    // sets audit_logs.organization_id to NULL (ON DELETE SET NULL), and
    // trg_audit_logs_immutable rejects every UPDATE on that table. So an
    // organization this run wrote an audit row for cannot be removed, by design,
    // and is deliberately left behind rather than worked around.
    //
    // Asked rather than caught: swallowing the exception would also swallow a
    // genuine teardown failure.
    const audited =
      createdOrgIds.length === 0
        ? []
        : await prisma.audit_logs.findMany({
            where: { organization_id: { in: createdOrgIds } },
            select: { organization_id: true },
            distinct: ['organization_id'],
          });
    const auditedOrgIds = new Set(audited.map((row) => row.organization_id));
    const deletableOrgIds = createdOrgIds.filter((id) => !auditedOrgIds.has(id));

    if (deletableOrgIds.length > 0) {
      await prisma.organizations.deleteMany({ where: { id: { in: deletableOrgIds } } });
    }

    // Proves the cleanup ran, instead of leaving a silent leak for the next run
    // to inherit — which is how the old hook failed unnoticed.
    const leaked = await prisma.users.count({ where: { id: { in: createdUserIds } } });
    assert.equal(leaked, 0, `${leaked} user(s) from run ${RUN} survived teardown`);
  } finally {
    // In a finally so a teardown failure can never again leave the Nest server
    // and the Prisma pool open, which is what made the runner hang rather than
    // report.
    await app.close();
  }
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

test('the membership switch takes suspended and active, and nothing else', async () => {
  // 'active' is the reinstatement path and is deliberately NOT in this list:
  // updateAgentSchema has always accepted it, and asserting a 400 for it here
  // contradicted both the schema and the reactivation the UI offers.
  for (const body of [{ status: 'banned' }, { status: true }, { role: 'owner' }, {}]) {
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

// --- editing an agent profile ------------------------------------------------

/**
 * A dedicated agent for the edit tests, created here rather than reusing
 * agentA: that one has been suspended by the tests above, and an edit suite
 * that depended on the suspension order would break the moment a test moved.
 */
let editAgentId = '';
const EDIT_EMAIL = (): string => emailFor('agent-edit');
const EDIT_EMAIL_NEW = (): string => emailFor('agent-edit-renamed');

test('owner creates the agent the edit tests operate on', async () => {
  const res = await call('POST', '/api/agents', {
    token: ownerA.token,
    body: { email: EDIT_EMAIL(), password: PASSWORD, firstName: 'Edna', lastName: 'Editable' },
  });
  assert.equal(res.status, 201, res.text);

  editAgentId = (res.body as unknown as Member).id;
  createdUserIds.push(editAgentId);
});

test('owner edits every Phase 1 field, and Postgres holds the new values', async () => {
  const res = await call('PATCH', `/api/agents/${editAgentId}`, {
    token: ownerA.token,
    body: {
      firstName: 'Grace',
      lastName: 'Hopper',
      email: EDIT_EMAIL_NEW(),
      phone: '512-555-0123',
      title: 'Senior Listing Agent',
      timezone: 'America/New_York',
      maxActiveLeads: 40,
    },
  });
  assert.equal(res.status, 200, res.text);

  const body = res.body as unknown as Member & { title: string | null; maxActiveLeads: number | null };
  assert.equal(body.firstName, 'Grace');
  assert.equal(body.lastName, 'Hopper');
  assert.equal(body.email, EDIT_EMAIL_NEW());
  assert.equal(body.phone, '512-555-0123');
  assert.equal(body.title, 'Senior Listing Agent');
  assert.equal(body.timezone, 'America/New_York');
  assert.equal(body.maxActiveLeads, 40);

  // The response is not the assertion — the rows are. Name, email and phone on
  // users; title, timezone and the cap on agent_profiles.
  const user = await prisma.users.findUnique({ where: { id: editAgentId } });
  assert.equal(user?.first_name, 'Grace');
  assert.equal(user?.last_name, 'Hopper');
  assert.equal(user?.email, EDIT_EMAIL_NEW());
  assert.equal(user?.phone, '512-555-0123');

  const profile = await prisma.agent_profiles.findFirst({
    where: { organization_id: ownerA.orgId, user_id: editAgentId },
  });
  assert.equal(profile?.title, 'Senior Listing Agent');
  assert.equal(profile?.timezone, 'America/New_York');
  assert.equal(profile?.max_active_leads, 40);
  // The profile's own copies of the name, email and phone move with them.
  assert.equal(profile?.display_name, 'Grace Hopper');
  assert.equal(profile?.email, EDIT_EMAIL_NEW());
  assert.equal(profile?.phone, '512-555-0123');
});

test('the edited email is the credential: the agent signs in with the new one', async () => {
  const withNew = await call('POST', '/api/auth/login', {
    body: { email: EDIT_EMAIL_NEW(), password: PASSWORD },
  });
  assert.equal(withNew.status, 200, withNew.text);

  // And the old address is nobody's login any more.
  const withOld = await call('POST', '/api/auth/login', { body: { email: EDIT_EMAIL(), password: PASSWORD } });
  assert.equal(withOld.status, 401, withOld.text);
});

test('a partial edit changes only what it named', async () => {
  const res = await call('PATCH', `/api/agents/${editAgentId}`, {
    token: ownerA.token,
    body: { title: 'Buyer Agent' },
  });
  assert.equal(res.status, 200, res.text);

  const user = await prisma.users.findUnique({ where: { id: editAgentId } });
  assert.equal(user?.first_name, 'Grace');
  assert.equal(user?.email, EDIT_EMAIL_NEW());

  const profile = await prisma.agent_profiles.findFirst({
    where: { organization_id: ownerA.orgId, user_id: editAgentId },
  });
  assert.equal(profile?.title, 'Buyer Agent');
  // Untouched by a title-only edit.
  assert.equal(profile?.max_active_leads, 40);
  assert.equal(profile?.timezone, 'America/New_York');
});

test('null clears an optional column', async () => {
  const res = await call('PATCH', `/api/agents/${editAgentId}`, {
    token: ownerA.token,
    body: { phone: null, title: null },
  });
  assert.equal(res.status, 200, res.text);

  const user = await prisma.users.findUnique({ where: { id: editAgentId } });
  assert.equal(user?.phone, null);

  const profile = await prisma.agent_profiles.findFirst({
    where: { organization_id: ownerA.orgId, user_id: editAgentId },
  });
  assert.equal(profile?.title, null);
});

test('an edit never moves role, membership status or organization', async () => {
  const before = await prisma.organization_members.findFirst({
    where: { organization_id: ownerA.orgId, user_id: editAgentId },
  });

  const res = await call('PATCH', `/api/agents/${editAgentId}`, {
    token: ownerA.token,
    body: { firstName: 'Grace', maxActiveLeads: 7 },
  });
  assert.equal(res.status, 200, res.text);

  const after = await prisma.organization_members.findFirst({
    where: { organization_id: ownerA.orgId, user_id: editAgentId },
  });
  assert.equal(after?.role, before?.role);
  assert.equal(after?.status, before?.status);
  assert.equal(after?.organization_id, before?.organization_id);
});

test('invalid profile values are a 400, and nothing is written', async () => {
  for (const body of [
    { email: 'not-an-email' },
    { timezone: 'Mars/Olympus_Mons' },
    // agent_profiles has CHECK (max_active_leads > 0) — a 400, never a 500.
    { maxActiveLeads: 0 },
    { maxActiveLeads: -1 },
    { maxActiveLeads: 2.5 },
    { maxActiveLeads: '10' },
    { firstName: '' },
    { lastName: '   ' },
  ]) {
    const res = await call('PATCH', `/api/agents/${editAgentId}`, { token: ownerA.token, body });
    assert.equal(res.status, 400, `${JSON.stringify(body)} -> ${res.text}`);
  }

  // The cap the last successful edit set is still there.
  const profile = await prisma.agent_profiles.findFirst({
    where: { organization_id: ownerA.orgId, user_id: editAgentId },
  });
  assert.equal(profile?.max_active_leads, 7);
});

test('fields the client must not control are rejected outright', async () => {
  for (const body of [
    { role: 'owner' },
    { organizationId: ownerB.orgId },
    { organization_id: ownerB.orgId },
    { password: PASSWORD },
    { routingEnabled: false },
    { routing_enabled: false },
    { agentStatus: 'available' },
    { firstName: 'Grace', role: 'owner' },
    // The membership switch and a profile edit have different authorization
    // rules, so a body doing both is refused rather than half-applied.
    { status: 'suspended', title: 'Broker' },
  ]) {
    const res = await call('PATCH', `/api/agents/${editAgentId}`, { token: ownerA.token, body });
    assert.equal(res.status, 400, `${JSON.stringify(body)} -> ${res.text}`);
  }

  const member = await prisma.organization_members.findFirst({
    where: { organization_id: ownerA.orgId, user_id: editAgentId },
  });
  assert.equal(member?.role, 'agent');
  assert.equal(member?.status, 'active');
});

test('an email another account holds is a 409, case-insensitively', async () => {
  const res = await call('PATCH', `/api/agents/${editAgentId}`, {
    token: ownerA.token,
    body: { email: AGENT_A_EMAIL().toUpperCase() },
  });
  assert.equal(res.status, 409, res.text);
  assert.equal(errCode(res), 'EMAIL_TAKEN');

  const user = await prisma.users.findUnique({ where: { id: editAgentId } });
  assert.equal(user?.email, EDIT_EMAIL_NEW());
});

test("re-saving the agent's own email is not a conflict with itself", async () => {
  const res = await call('PATCH', `/api/agents/${editAgentId}`, {
    token: ownerA.token,
    body: { email: EDIT_EMAIL_NEW(), title: 'Listing Agent' },
  });
  assert.equal(res.status, 200, res.text);
});

test("an owner cannot edit another organization's agent", async () => {
  // Owner B, addressing an agent that exists — but not in their tenant. A 404
  // rather than a 403: confirming the account exists would leak across tenants.
  const res = await call('PATCH', `/api/agents/${editAgentId}`, {
    token: ownerB.token,
    body: { firstName: 'Mallory', maxActiveLeads: 999 },
  });
  assert.equal(res.status, 404, res.text);

  const user = await prisma.users.findUnique({ where: { id: editAgentId } });
  assert.equal(user?.first_name, 'Grace');
  const profile = await prisma.agent_profiles.findFirst({
    where: { organization_id: ownerA.orgId, user_id: editAgentId },
  });
  assert.notEqual(profile?.max_active_leads, 999);
});

test('an agent cannot edit anyone, including themselves', async () => {
  const login = await call('POST', '/api/auth/login', {
    body: { email: EDIT_EMAIL_NEW(), password: PASSWORD },
  });
  assert.equal(login.status, 200, login.text);
  const token = login.body['token'] as string;

  const other = await call('PATCH', `/api/agents/${agentAId}`, { token, body: { title: 'Broker' } });
  assert.equal(other.status, 403, other.text);

  const self = await call('PATCH', `/api/agents/${editAgentId}`, { token, body: { title: 'Broker' } });
  assert.equal(self.status, 403, self.text);
});

test('the owner is not editable here, and gains no agent profile from trying', async () => {
  // An owner has no agent_profiles row by design. Minting one as a side effect
  // of a name change would quietly turn the account into a routing target.
  const res = await call('PATCH', `/api/agents/${ownerA.userId}`, {
    token: ownerA.token,
    body: { title: 'Broker' },
  });
  assert.equal(res.status, 403, res.text);

  const profile = await prisma.agent_profiles.findFirst({
    where: { organization_id: ownerA.orgId, user_id: ownerA.userId },
  });
  assert.equal(profile, null);
});

test('the roster reports the edited title and lead cap', async () => {
  const res = await call('GET', '/api/agents', { token: ownerA.token });
  assert.equal(res.status, 200, res.text);

  const rows = res.body as unknown as Array<Member & { title: string | null; maxActiveLeads: number | null }>;
  const edited = rows.find((m) => m.id === editAgentId)!;
  assert.equal(edited.title, 'Listing Agent');
  assert.equal(edited.maxActiveLeads, 7);

  // The owner has no profile, so there is no cap to report rather than a
  // default to invent.
  const owner = rows.find((m) => m.id === ownerA.userId)!;
  assert.equal(owner.maxActiveLeads, null);
  assert.equal(owner.title, null);
});

test('the edit is recorded in the audit log, naming fields but not values', async () => {
  const entries = await prisma.audit_logs.findMany({
    where: { organization_id: ownerA.orgId, action: 'member.updated', entity_id: editAgentId },
    orderBy: { created_at: 'desc' },
  });
  assert.ok(entries.length > 0, 'no member.updated audit row was written');

  const first = entries.at(-1)!;
  assert.equal(first.actor_type, 'user');
  assert.equal(first.actor_id, ownerA.userId);
  assert.equal(first.entity_type, 'member');
  assert.ok(Array.isArray((first.payload as { changed?: unknown })?.changed));
  // The phone number itself never reaches the audit table.
  assert.ok(!JSON.stringify(first.payload).includes('512-555-0123'));
});

// --- max active leads at onboarding -----------------------------------------

test('Add Agent stores the lead cap the owner entered', async () => {
  const res = await call('POST', '/api/agents', {
    token: ownerA.token,
    body: {
      email: emailFor('cap'),
      password: PASSWORD,
      firstName: 'Cap',
      lastName: 'Ped',
      maxActiveLeads: 12,
    },
  });
  assert.equal(res.status, 201, res.text);

  const created = res.body as unknown as Member & { maxActiveLeads: number | null };
  createdUserIds.push(created.id);
  assert.equal(created.maxActiveLeads, 12);

  const profile = await prisma.agent_profiles.findFirst({
    where: { organization_id: ownerA.orgId, user_id: created.id },
  });
  assert.equal(profile?.max_active_leads, 12);
});

test('Add Agent without a lead cap leaves the column default standing', async () => {
  const res = await call('POST', '/api/agents', {
    token: ownerA.token,
    body: { email: emailFor('nocap'), password: PASSWORD, firstName: 'No', lastName: 'Cap' },
  });
  assert.equal(res.status, 201, res.text);

  const created = res.body as unknown as Member & { maxActiveLeads: number | null };
  createdUserIds.push(created.id);
  assert.equal(created.maxActiveLeads, 25);

  const profile = await prisma.agent_profiles.findFirst({
    where: { organization_id: ownerA.orgId, user_id: created.id },
  });
  assert.equal(profile?.max_active_leads, 25);
});

test('Add Agent rejects a lead cap the database could not store', async () => {
  // agent_profiles has CHECK (max_active_leads > 0).
  for (const maxActiveLeads of [0, -1, 2.5, '10', null]) {
    const res = await call('POST', '/api/agents', {
      token: ownerA.token,
      body: {
        email: emailFor(`bad-cap-${String(maxActiveLeads)}`),
        password: PASSWORD,
        firstName: 'Bad',
        lastName: 'Cap',
        maxActiveLeads,
      },
    });
    assert.equal(res.status, 400, `${String(maxActiveLeads)} -> ${res.text}`);
  }
});

// --- owner who also takes leads ---------------------------------------------

test('"I also take leads" requires a session and an owner', async () => {
  const anon = await call('PUT', '/api/agents/me/taking-leads', { body: { enabled: true } });
  assert.equal(anon.status, 401, anon.text);

  const login = await call('POST', '/api/auth/login', { body: { email: EDIT_EMAIL_NEW(), password: PASSWORD } });
  assert.equal(login.status, 200, login.text);
  const asAgent = await call('PUT', '/api/agents/me/taking-leads', {
    token: login.body['token'] as string,
    body: { enabled: true },
  });
  assert.equal(asAgent.status, 403, asAgent.text);
});

test('"I also take leads" accepts only {enabled}, never a target', async () => {
  for (const body of [{}, { enabled: 'yes' }, { enabled: true, userId: ownerA.userId }, { enabled: true, organizationId: ownerA.orgId }]) {
    const res = await call('PUT', '/api/agents/me/taking-leads', { token: ownerB.token, body });
    assert.equal(res.status, 400, `${JSON.stringify(body)} -> ${res.text}`);
  }
  const profile = await prisma.agent_profiles.findFirst({
    where: { organization_id: ownerB.orgId, user_id: ownerB.userId },
  });
  assert.equal(profile, null);
});

test('an owner turns on "I also take leads": a profile in their own org, and /me sees it', async () => {
  const res = await call('PUT', '/api/agents/me/taking-leads', { token: ownerB.token, body: { enabled: true } });
  assert.equal(res.status, 200, res.text);
  const me = res.body as unknown as Member & { takingLeads: boolean };
  assert.equal(me.id, ownerB.userId);
  assert.equal(me.role, 'owner');
  assert.equal(me.hasProfile, true);
  assert.equal(me.takingLeads, true);

  const profile = await prisma.agent_profiles.findFirst({
    where: { organization_id: ownerB.orgId, user_id: ownerB.userId },
  });
  assert.ok(profile);
  assert.equal(profile.routing_enabled, true);
  assert.equal(profile.email, emailFor('owner-b'));

  // Owner A's organization is untouched.
  const leak = await prisma.agent_profiles.findFirst({
    where: { organization_id: ownerA.orgId, user_id: ownerB.userId },
  });
  assert.equal(leak, null);

  const session = await call('GET', '/api/auth/me', { token: ownerB.token });
  assert.equal(session.body['agentProfileId'], profile.id);
  assert.equal(session.body['role'], 'owner');
});

test('the owner who takes leads can edit their own profile, but not before', async () => {
  const res = await call('PATCH', `/api/agents/${ownerB.userId}`, {
    token: ownerB.token,
    body: { title: 'Broker', maxActiveLeads: 12, timezone: 'Asia/Kolkata' },
  });
  assert.equal(res.status, 200, res.text);
  const profile = await prisma.agent_profiles.findFirst({
    where: { organization_id: ownerB.orgId, user_id: ownerB.userId },
  });
  assert.equal(profile?.title, 'Broker');
  assert.equal(profile?.max_active_leads, 12);
  assert.equal(profile?.timezone, 'Asia/Kolkata');

  // Owner A still has no profile, so their self-edit is still refused.
  const before = await call('PATCH', `/api/agents/${ownerA.userId}`, { token: ownerA.token, body: { title: 'Broker' } });
  assert.equal(before.status, 403, before.text);
});

test('the owner who takes leads reaches the agent self-service routes, like any agent', async () => {
  const res = await call('GET', '/api/agents/me/dashboard', { token: ownerB.token });
  // The agent routes resolve the caller's profile, not their role.
  assert.equal(res.status, 200, res.text);
});

test('turning "I also take leads" off keeps the profile and is idempotent', async () => {
  const profileBefore = await prisma.agent_profiles.findFirst({
    where: { organization_id: ownerB.orgId, user_id: ownerB.userId },
  });

  for (let i = 0; i < 2; i += 1) {
    const res = await call('PUT', '/api/agents/me/taking-leads', { token: ownerB.token, body: { enabled: false } });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body['takingLeads'], false);
    assert.equal(res.body['hasProfile'], true);
  }

  const profileAfter = await prisma.agent_profiles.findFirst({
    where: { organization_id: ownerB.orgId, user_id: ownerB.userId },
  });
  assert.equal(profileAfter?.id, profileBefore?.id);
  assert.equal(profileAfter?.routing_enabled, false);

  const audits = await prisma.audit_logs.findMany({
    where: { organization_id: ownerB.orgId, entity_id: ownerB.userId, action: 'member.routing_disabled' },
  });
  assert.equal(audits.length, 1);
});

test('turning it back on resumes the same profile; each answer is the roster row, leads and cap untouched', async () => {
  const profile = await prisma.agent_profiles.findFirstOrThrow({
    where: { organization_id: ownerB.orgId, user_id: ownerB.userId },
  });
  // At their cap, with two current leads (and one retired) and a linked office
  // calendar: the switch is not a capacity rule, and must leave all of it be.
  await prisma.agent_profiles.update({
    where: { id: profile.id },
    data: { max_active_leads: 2, calendly_user_uri: `https://api.calendly.com/users/owner-${RUN}` },
  });
  const connection = await prisma.calendar_connections.create({
    data: { organization_id: ownerB.orgId, provider: 'calendly', status: 'active' },
  });
  const leadIds: string[] = [];
  try {
    for (const isCurrent of [true, true, false]) {
      const lead = await prisma.leads.create({ data: { organization_id: ownerB.orgId, status: 'new' } });
      leadIds.push(lead.id);
      await prisma.lead_assignments.create({
        data: {
          organization_id: ownerB.orgId,
          lead_id: lead.id,
          agent_id: profile.id,
          assignment_type: 'manual',
          is_current: isCurrent,
        },
      });
    }

    for (const enabled of [true, false]) {
      const res = await call('PUT', '/api/agents/me/taking-leads', { token: ownerB.token, body: { enabled } });
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(res.body, await rosterRow(ownerB.token, ownerB.userId));
      assert.equal(res.body['takingLeads'], enabled);
      assert.equal(res.body['profileId'], profile.id);
      assert.equal(res.body['maxActiveLeads'], 2);
      assert.equal(res.body['activeLeads'], 2);
      assert.equal(res.body['calendarLinked'], true);
    }

    const after = await prisma.agent_profiles.findMany({ where: { user_id: ownerB.userId } });
    assert.deepEqual(
      after.map((p) => [p.id, p.organization_id, p.routing_enabled]),
      [[profile.id, ownerB.orgId, false]],
    );
    assert.equal(await prisma.lead_assignments.count({ where: { agent_id: profile.id, is_current: true } }), 2);

    // Every switch this owner has made, in order — and none for the repeat.
    const entries = await prisma.audit_logs.findMany({
      where: { organization_id: ownerB.orgId, entity_id: ownerB.userId, action: { startsWith: 'member.routing_' } },
      orderBy: { created_at: 'asc' },
      select: { actor_type: true, actor_id: true, action: true, entity_type: true, payload: true },
    });
    const entry = (action: string, from: boolean, to: boolean, profileCreated: boolean) => ({
      actor_type: 'user',
      actor_id: ownerB.userId,
      action,
      entity_type: 'member',
      payload: { from, to, profileCreated },
    });
    assert.deepEqual(entries, [
      entry('member.routing_enabled', false, true, true),
      entry('member.routing_disabled', true, false, false),
      entry('member.routing_enabled', false, true, false),
      entry('member.routing_disabled', true, false, false),
    ]);
  } finally {
    // Deleting the leads takes their assignments with them, which is what lets
    // after() remove this owner's profile.
    await prisma.leads.deleteMany({ where: { id: { in: leadIds } } });
    await prisma.calendar_connections.delete({ where: { id: connection.id } });
  }
});

test('a double-click on "I also take leads" makes one profile and one audit row, and every click answers the same', async () => {
  const owner = await signupOwner('double-click', `Agents Test Double ${RUN}`);

  const clicks = await Promise.all(
    [0, 1, 2].map(() => call('PUT', '/api/agents/me/taking-leads', { token: owner.token, body: { enabled: true } })),
  );
  for (const res of clicks) {
    assert.equal(res.status, 200, res.text);
    assert.equal(res.text, clicks[0]!.text);
  }
  assert.deepEqual(clicks[0]!.body, await rosterRow(owner.token, owner.userId));
  assert.equal(clicks[0]!.body['takingLeads'], true);

  const profiles = await prisma.agent_profiles.findMany({ where: { user_id: owner.userId } });
  assert.deepEqual(
    profiles.map((p) => [p.id, p.organization_id, p.routing_enabled]),
    [[clicks[0]!.body['profileId'], owner.orgId, true]],
  );
  const entries = await prisma.audit_logs.findMany({
    where: { organization_id: owner.orgId, entity_id: owner.userId, action: { startsWith: 'member.routing_' } },
    select: { action: true, payload: true },
  });
  assert.deepEqual(entries, [{ action: 'member.routing_enabled', payload: { from: false, to: true, profileCreated: true } }]);

  // Another organization's roster never sees it.
  const other = await call('GET', '/api/agents', { token: ownerA.token });
  assert.ok(!(other.body as unknown as Member[]).some((m) => m.id === owner.userId));
});

test('a "Just me" signup starts the owner with an agent profile', async () => {
  const res = await call('POST', '/api/auth/signup', {
    body: {
      email: emailFor('solo'),
      password: PASSWORD,
      firstName: 'Solo',
      lastName: 'Owner',
      organizationName: `Agents Test Solo ${RUN}`,
      teamSize: 'solo',
    },
  });
  assert.equal(res.status, 201, res.text);
  const user = res.body['user'] as { id: string };
  const organization = res.body['organization'] as { id: string };
  createdUserIds.push(user.id);
  createdOrgIds.push(organization.id);

  const profile = await prisma.agent_profiles.findFirst({
    where: { organization_id: organization.id, user_id: user.id },
  });
  assert.ok(profile);
  assert.equal(res.body['agentProfileId'], profile.id);
  assert.equal(profile.routing_enabled, true);

  const roster = await call('GET', '/api/agents', { token: res.body['token'] as string });
  const [owner] = roster.body as unknown as Array<Member & { takingLeads: boolean }>;
  assert.equal(owner.role, 'owner');
  assert.equal(owner.takingLeads, true);
});

test('a team signup (or an older client sending nothing) creates no profile', async () => {
  const profile = await prisma.agent_profiles.findFirst({
    where: { organization_id: ownerA.orgId, user_id: ownerA.userId },
  });
  assert.equal(profile, null);

  const bad = await call('POST', '/api/auth/signup', {
    body: {
      email: emailFor('bad-size'),
      password: PASSWORD,
      firstName: 'Bad',
      lastName: 'Size',
      organizationName: `Agents Test Bad ${RUN}`,
      teamSize: 'enterprise',
    },
  });
  assert.equal(bad.status, 400, bad.text);
});

// --- what an update answers ---------------------------------------------------

/** The member's row exactly as a roster reload would show it. */
async function rosterRow(token: string, userId: string): Promise<Record<string, unknown> | undefined> {
  const res = await call('GET', '/api/agents', { token });
  assert.equal(res.status, 200, res.text);
  return (res.body as unknown as Array<Record<string, unknown>>).find((m) => m['id'] === userId);
}

test("an edit, a suspend and a reinstatement each answer the roster's own row, counts included", async () => {
  // An office calendar the agent is linked to and two current leads (plus one
  // retired), so calendarLinked and activeLeads are real values, not defaults.
  const created = await call('POST', '/api/agents', {
    token: ownerA.token,
    body: { email: emailFor('answers'), password: PASSWORD, firstName: 'Ada', lastName: 'Answer' },
  });
  assert.equal(created.status, 201, created.text);
  const userId = (created.body as unknown as Member).id;
  createdUserIds.push(userId);

  const profile = await prisma.agent_profiles.update({
    where: { id: (created.body as unknown as { profileId: string }).profileId },
    data: { calendly_user_uri: `https://api.calendly.com/users/${RUN}` },
  });
  const connection = await prisma.calendar_connections.create({
    data: { organization_id: ownerA.orgId, provider: 'calendly', status: 'active' },
  });
  const leadIds: string[] = [];
  try {
    for (const isCurrent of [true, true, false]) {
      const lead = await prisma.leads.create({ data: { organization_id: ownerA.orgId, status: 'new' } });
      leadIds.push(lead.id);
      await prisma.lead_assignments.create({
        data: {
          organization_id: ownerA.orgId,
          lead_id: lead.id,
          agent_id: profile.id,
          assignment_type: 'manual',
          is_current: isCurrent,
        },
      });
    }

    const edit = await call('PATCH', `/api/agents/${userId}`, {
      token: ownerA.token,
      body: { maxActiveLeads: 3, title: 'Closer' },
    });
    assert.equal(edit.status, 200, edit.text);
    assert.deepEqual(edit.body, await rosterRow(ownerA.token, userId));
    assert.equal(edit.body['maxActiveLeads'], 3);
    assert.equal(edit.body['title'], 'Closer');
    assert.equal(edit.body['activeLeads'], 2);
    assert.equal(edit.body['calendarLinked'], true);

    for (const [status, action] of [
      ['suspended', 'member.suspended'],
      ['active', 'member.reactivated'],
    ] as const) {
      const res = await call('PATCH', `/api/agents/${userId}`, { token: ownerA.token, body: { status } });
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(res.body, await rosterRow(ownerA.token, userId));
      assert.equal(res.body['status'], status);
      assert.equal(res.body['activeLeads'], 2);

      const [entry] = await prisma.audit_logs.findMany({
        where: { organization_id: ownerA.orgId, entity_id: userId, action },
        select: { actor_type: true, actor_id: true, entity_type: true, payload: true },
      });
      assert.deepEqual(entry, {
        actor_type: 'user',
        actor_id: ownerA.userId,
        entity_type: 'member',
        payload: { from: status === 'suspended' ? 'active' : 'suspended', to: status },
      });
    }
  } finally {
    // Deleting the leads takes their assignments with them, which is what lets
    // after() remove this agent's profile.
    await prisma.leads.deleteMany({ where: { id: { in: leadIds } } });
    await prisma.calendar_connections.delete({ where: { id: connection.id } });
  }
});

test('an agent whose profile row is missing gets one from their first edit', async () => {
  // A membership with no agent_profiles row, as rows predating create() have.
  const user = await prisma.users.create({
    data: {
      email: emailFor('no-profile'),
      first_name: 'Pat',
      last_name: 'Legacy',
      phone: '512-555-0199',
      password_hash: await bcrypt.hash(PASSWORD, 4),
    },
  });
  createdUserIds.push(user.id);
  await prisma.organization_members.create({
    data: { organization_id: ownerA.orgId, user_id: user.id, role: 'agent', status: 'active' },
  });

  const res = await call('PATCH', `/api/agents/${user.id}`, {
    token: ownerA.token,
    body: { title: 'Rejoined', maxActiveLeads: 4 },
  });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body, await rosterRow(ownerA.token, user.id));

  const profile = await prisma.agent_profiles.findFirst({
    where: { organization_id: ownerA.orgId, user_id: user.id },
  });
  assert.ok(profile, 'no profile was backfilled');
  assert.equal(res.body['hasProfile'], true);
  assert.equal(res.body['profileId'], profile.id);
  assert.equal(res.body['title'], 'Rejoined');
  assert.equal(res.body['maxActiveLeads'], 4);
  assert.equal(res.body['activeLeads'], 0);
  // Everything not supplied comes from the user row or the column defaults.
  assert.equal(profile.display_name, 'Pat Legacy');
  assert.equal(profile.email, emailFor('no-profile'));
  assert.equal(profile.phone, '512-555-0199');
  assert.equal(profile.timezone, 'America/Chicago');
  assert.equal(profile.routing_enabled, true);

  const entries = await prisma.audit_logs.findMany({
    where: { organization_id: ownerA.orgId, entity_id: user.id, action: 'member.updated' },
    select: { actor_id: true, payload: true },
  });
  assert.deepEqual(entries, [{ actor_id: ownerA.userId, payload: { changed: ['title', 'maxActiveLeads'] } }]);
});

test('no response in this suite contained a password or a hash', () => {
  for (const body of allResponseBodies) {
    assert.ok(!body.includes(PASSWORD), `a response echoed the password: ${body}`);
    assert.ok(!body.includes('$2b$'), `a response contained a bcrypt hash: ${body}`);
    assert.ok(!body.includes('password_hash'), `a response named password_hash: ${body}`);
  }
});
