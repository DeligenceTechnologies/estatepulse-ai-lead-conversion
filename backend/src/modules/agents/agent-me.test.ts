import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AuthModule } from '../../auth/auth.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { AgentsModule } from './agents.module';

/**
 * Integration suite for the agent's own surface, against the real database and
 * in the same shape as agents.test.ts: emails namespaced per run, every row it
 * creates tracked by id and torn down in after().
 *
 * Run with `npm run test:agent-me`.
 *
 * A file of its own rather than more cases in agents.test.ts. That suite is the
 * OWNER's roster; this one needs a second agent, real leads and real
 * assignments, and its teardown has an ordering constraint that suite does not
 * (see after()). Keeping them apart means neither one's fixtures can strand the
 * other's.
 *
 * Two organizations on purpose. "An agent sees only their own leads" cannot be
 * shown with one agent, and tenant isolation cannot be shown with one office.
 */

const RUN = Date.now().toString(36);
const emailFor = (tag: string): string => `agentme-${RUN}-${tag}@example.invalid`;
const PASSWORD = 'correct-horse-battery-staple';

let app: INestApplication;
let prisma: PrismaService;
let base: string;

const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];
const createdLeadIds: string[] = [];

interface Res {
  status: number;
  body: unknown;
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
  let body: unknown = {};
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    // non-JSON response; the raw text is still asserted on
  }
  return { status: res.status, body, text };
}

const errCode = (res: Res): unknown =>
  ((res.body as Record<string, unknown>)['error'] as Record<string, unknown> | undefined)?.['code'];

const asRecord = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;

async function signupOwner(tag: string, org: string): Promise<{ token: string; userId: string; orgId: string }> {
  const res = await call('POST', '/api/auth/signup', {
    body: { email: emailFor(tag), password: PASSWORD, firstName: 'Own', lastName: 'Er', organizationName: org },
  });
  assert.equal(res.status, 201, `signup(${tag}) failed: ${res.text}`);

  const user = asRecord(asRecord(res.body)['user']);
  const organization = asRecord(asRecord(res.body)['organization']);
  createdUserIds.push(user['id'] as string);
  createdOrgIds.push(organization['id'] as string);
  return {
    token: asRecord(res.body)['token'] as string,
    userId: user['id'] as string,
    orgId: organization['id'] as string,
  };
}

/** Creates an agent in `ownerToken`'s organization and signs them in. */
async function createAgent(
  ownerToken: string,
  tag: string,
): Promise<{ userId: string; token: string }> {
  const created = await call('POST', '/api/agents', {
    token: ownerToken,
    body: { email: emailFor(tag), password: PASSWORD, firstName: 'Ag', lastName: tag },
  });
  assert.equal(created.status, 201, `create agent(${tag}) failed: ${created.text}`);
  const userId = asRecord(created.body)['id'] as string;
  createdUserIds.push(userId);

  const login = await call('POST', '/api/auth/login', {
    body: { email: emailFor(tag), password: PASSWORD },
  });
  assert.equal(login.status, 200, login.text);
  return { userId, token: asRecord(login.body)['token'] as string };
}

let ownerA = { token: '', userId: '', orgId: '' };
let ownerB = { token: '', userId: '', orgId: '' };
let alice = { userId: '', token: '' };
let bob = { userId: '', token: '' };

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

  ownerA = await signupOwner('owner-a', `AgentMe Test A ${RUN}`);
  ownerB = await signupOwner('owner-b', `AgentMe Test B ${RUN}`);
  alice = await createAgent(ownerA.token, 'alice');
  bob = await createAgent(ownerA.token, 'bob');
});

after(async () => {
  try {
    // Leads FIRST. lead_assignments.agent_id is ON DELETE RESTRICT against
    // agent_profiles, so an assignment still pointing at an agent blocks the
    // cascade that removes their profile along with their user row. Deleting
    // the lead cascades its assignments and clears the way.
    if (createdLeadIds.length > 0) {
      await prisma.leads.deleteMany({ where: { id: { in: createdLeadIds } } });
    }

    // Users next: organization_members and agent_profiles both cascade from
    // users, and audit_logs.actor_id has no foreign key, so this touches no
    // audit row.
    if (createdUserIds.length > 0) {
      await prisma.users.deleteMany({ where: { id: { in: createdUserIds } } });
    }

    // An organization is only deletable while it has no audit rows: dropping
    // one sets audit_logs.organization_id to NULL (ON DELETE SET NULL), and
    // trg_audit_logs_immutable rejects every UPDATE on that table. Creating an
    // agent writes a member.created audit row, so these organizations cannot be
    // removed — that is the immutability working, not a leak to fix here.
    // Asked rather than caught, so a genuine failure is not swallowed.
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

    const leakedUsers = await prisma.users.count({ where: { id: { in: createdUserIds } } });
    assert.equal(leakedUsers, 0, `${leakedUsers} user(s) from run ${RUN} survived teardown`);
    const leakedLeads = await prisma.leads.count({ where: { id: { in: createdLeadIds } } });
    assert.equal(leakedLeads, 0, `${leakedLeads} lead(s) from run ${RUN} survived teardown`);
  } finally {
    // In a finally so a teardown failure cannot leave the Nest server and the
    // Prisma pool open, which makes the runner hang instead of report.
    await app.close();
  }
});

/** A lead in org A, tracked for teardown. */
async function makeLead(fields: Record<string, unknown> = {}): Promise<string> {
  const lead = await prisma.leads.create({
    data: { organization_id: ownerA.orgId, status: 'new', ...fields },
    select: { id: true },
  });
  createdLeadIds.push(lead.id);
  return lead.id;
}

/** Assigns a lead to an agent by their users.id, the way routing will. */
async function assign(leadId: string, agentUserId: string): Promise<void> {
  const profile = await prisma.agent_profiles.findFirst({
    where: { organization_id: ownerA.orgId, user_id: agentUserId },
    select: { id: true },
  });
  assert.ok(profile, 'the agent should have had a profile created with them');
  await prisma.lead_assignments.create({
    data: {
      organization_id: ownerA.orgId,
      lead_id: leadId,
      agent_id: profile.id,
      // Verbatim from lead_assignments_type_check.
      assignment_type: 'manual',
      is_current: true,
    },
  });
}

// --- authentication ----------------------------------------------------------

test('the agent surface requires a session', async () => {
  for (const path of ['/api/agents/me/dashboard', '/api/agents/me/leads']) {
    const res = await call('GET', path);
    assert.equal(res.status, 401, `${path} -> ${res.text}`);
  }
});

test('a garbage bearer token is rejected, not treated as anonymous', async () => {
  const res = await call('GET', '/api/agents/me/dashboard', { token: 'not-a-jwt' });
  assert.equal(res.status, 401, res.text);
});

test('an agent signs in with the existing login route and is seen as an agent', async () => {
  const me = await call('GET', '/api/auth/me', { token: alice.token });
  assert.equal(me.status, 200, me.text);
  assert.equal(asRecord(me.body)['role'], 'agent');
  // The id the whole surface below is scoped by, resolved server-side.
  assert.ok(asRecord(me.body)['agentProfileId'], 'an agent should carry an agentProfileId');
  // The organization NAME is what an agent may know about their office.
  assert.equal(asRecord(asRecord(me.body)['organization'])['name'], `AgentMe Test A ${RUN}`);
});

// --- the dashboard -----------------------------------------------------------

test('a new agent reads real zeros, not placeholders', async () => {
  const res = await call('GET', '/api/agents/me/dashboard', { token: bob.token });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body, {
    activeLeads: 0,
    newLeads: 0,
    upcomingAppointments: 0,
    totalAssignedLeads: 0,
  });
});

test('an owner has no agent profile, so the agent surface is closed to them', async () => {
  for (const path of ['/api/agents/me/dashboard', '/api/agents/me/leads']) {
    const res = await call('GET', path, { token: ownerA.token });
    assert.equal(res.status, 403, `${path} -> ${res.text}`);
    assert.equal(errCode(res), 'FORBIDDEN');
  }
});

// --- my leads ----------------------------------------------------------------

test('an assigned lead appears with the fields the screen needs', async () => {
  const leadId = await makeLead({
    first_name: 'Assigned',
    last_name: 'Lead',
    email: 'assigned.lead@example.invalid',
    phone: '512-555-0190',
    temperature: 'hot',
  });
  await assign(leadId, alice.userId);

  const res = await call('GET', '/api/agents/me/leads', { token: alice.token });
  assert.equal(res.status, 200, res.text);

  const rows = res.body as Array<Record<string, unknown>>;
  const mine = rows.find((r) => r['id'] === leadId);
  assert.ok(mine, 'the assigned lead should be in the list');
  assert.equal(mine['firstName'], 'Assigned');
  assert.equal(mine['phone'], '512-555-0190');
  assert.equal(mine['email'], 'assigned.lead@example.invalid');
  assert.equal(mine['status'], 'new');
  assert.equal(mine['temperature'], 'hot');
  assert.ok(mine['assignedAt'], 'assignedAt should come from lead_assignments');
});

test('the dashboard counts move with the assignment', async () => {
  const res = await call('GET', '/api/agents/me/dashboard', { token: alice.token });
  assert.equal(res.status, 200, res.text);
  // The cards and the table read the same filter, so they cannot disagree.
  assert.deepEqual(res.body, {
    activeLeads: 1,
    newLeads: 1,
    upcomingAppointments: 0,
    totalAssignedLeads: 1,
  });
});

test('an agent can open a lead assigned to them', async () => {
  const list = await call('GET', '/api/agents/me/leads', { token: alice.token });
  const leadId = (list.body as Array<Record<string, unknown>>)[0]['id'] as string;

  const res = await call('GET', `/api/agents/me/leads/${leadId}`, { token: alice.token });
  assert.equal(res.status, 200, res.text);
  const body = asRecord(res.body);
  assert.equal(body['email'], 'assigned.lead@example.invalid');
  // Detail fields, all read straight off the lead row.
  for (const key of ['location', 'timeline', 'minBudget', 'motivation', 'aiSummary', 'consentStatus']) {
    assert.ok(key in body, `detail should expose ${key}`);
  }
});

test('an unassigned lead is invisible, and opening it is a 404', async () => {
  const leadId = await makeLead({ first_name: 'Not', last_name: 'Yours' });

  const detail = await call('GET', `/api/agents/me/leads/${leadId}`, { token: alice.token });
  // A 404 rather than a 403: confirming the lead exists but is not theirs would
  // leak the office's pipeline one id at a time.
  assert.equal(detail.status, 404, detail.text);

  const list = await call('GET', '/api/agents/me/leads', { token: alice.token });
  assert.ok(!list.text.includes(leadId), 'an unassigned lead appeared in the list');
});

test("one agent never sees another agent's lead", async () => {
  const list = await call('GET', '/api/agents/me/leads', { token: bob.token });
  assert.equal(list.status, 200, list.text);
  assert.equal((list.body as unknown[]).length, 0, "saw a lead assigned to somebody else");

  const dash = await call('GET', '/api/agents/me/dashboard', { token: bob.token });
  assert.equal(asRecord(dash.body)['totalAssignedLeads'], 0);

  // And cannot reach it by id either.
  const aliceList = await call('GET', '/api/agents/me/leads', { token: alice.token });
  const aliceLeadId = (aliceList.body as Array<Record<string, unknown>>)[0]['id'] as string;
  const stolen = await call('GET', `/api/agents/me/leads/${aliceLeadId}`, { token: bob.token });
  assert.equal(stolen.status, 404, stolen.text);
});

test('an agent in another organization sees nothing of this one', async () => {
  const bea = await createAgent(ownerB.token, 'bea');

  const leads = await call('GET', '/api/agents/me/leads', { token: bea.token });
  assert.equal(leads.status, 200, leads.text);
  assert.equal((leads.body as unknown[]).length, 0);

  const dash = await call('GET', '/api/agents/me/dashboard', { token: bea.token });
  assert.equal(asRecord(dash.body)['totalAssignedLeads'], 0);
});

test('a reassigned lead stops being the previous agent’s', async () => {
  const aliceList = await call('GET', '/api/agents/me/leads', { token: alice.token });
  const leadId = (aliceList.body as Array<Record<string, unknown>>)[0]['id'] as string;

  // Close Alice's assignment and give it to Bob, the way a reassignment would.
  await prisma.lead_assignments.updateMany({
    where: { organization_id: ownerA.orgId, lead_id: leadId, is_current: true },
    data: { is_current: false, unassigned_at: new Date() },
  });
  await assign(leadId, bob.userId);

  const gone = await call('GET', '/api/agents/me/leads', { token: alice.token });
  assert.equal((gone.body as unknown[]).length, 0, 'a reassigned lead stayed with the old agent');
  const stale = await call('GET', `/api/agents/me/leads/${leadId}`, { token: alice.token });
  assert.equal(stale.status, 404, stale.text);

  const now = await call('GET', '/api/agents/me/leads', { token: bob.token });
  assert.equal((now.body as unknown[]).length, 1, 'the new agent should hold it');
});

// --- authorization boundaries ------------------------------------------------

test('an agent still cannot reach the owner roster', async () => {
  // The separate shell is a convenience; OwnerGuard is the boundary.
  const list = await call('GET', '/api/agents', { token: alice.token });
  assert.equal(list.status, 403, list.text);

  const create = await call('POST', '/api/agents', {
    token: alice.token,
    body: { email: emailFor('nope'), password: PASSWORD, firstName: 'No', lastName: 'Pe' },
  });
  assert.equal(create.status, 403, create.text);

  const patch = await call('PATCH', `/api/agents/${bob.userId}`, {
    token: alice.token,
    body: { status: 'suspended' },
  });
  assert.equal(patch.status, 403, patch.text);
});

test('there is no route that takes an agent id', async () => {
  // The only way to name an agent is to be them. If a /:agentId/leads route is
  // ever added, this fails and the reason is right here.
  const profile = await prisma.agent_profiles.findFirst({
    where: { organization_id: ownerA.orgId, user_id: bob.userId },
    select: { id: true },
  });
  const res = await call('GET', `/api/agents/${profile!.id}/leads`, { token: alice.token });
  assert.ok(res.status === 403 || res.status === 404, `unexpected ${res.status}: ${res.text}`);
});

test('a suspended agent loses the surface with the token they already hold', async () => {
  const suspend = await call('PATCH', `/api/agents/${bob.userId}`, {
    token: ownerA.token,
    body: { status: 'suspended' },
  });
  assert.equal(suspend.status, 200, suspend.text);

  const res = await call('GET', '/api/agents/me/dashboard', { token: bob.token });
  // Inherited from loadAuthContext, which joins organization_members on
  // status = 'active' on every request — not a second mechanism added here.
  assert.equal(res.status, 403, res.text);
  assert.equal(errCode(res), 'NO_ORGANIZATION');
});

test('a malformed lead id is a 400 before any query runs', async () => {
  const res = await call('GET', '/api/agents/me/leads/not-a-uuid', { token: alice.token });
  assert.equal(res.status, 400, res.text);
});
