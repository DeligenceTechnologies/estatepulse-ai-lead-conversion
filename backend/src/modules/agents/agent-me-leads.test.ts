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
 * Integration suite pinning the GET /api/agents/me/leads contract against the
 * real database. Run with `npm run test:agent-me-leads`.
 *
 * Built to hit each rule: one agent holding more leads than the 200-row page,
 * with and without a source, null contact fields and a legacy status; a lead
 * reassigned away to a colleague; a lead with a retired and a current
 * assignment; an agent with none; and an agent in another organization. Rows
 * are inserted directly so their timestamps are exact.
 */

const RUN = Date.now().toString(36);
const emailFor = (tag: string): string => `agent-me-leads-${RUN}-${tag}@example.invalid`;
const PASSWORD = 'correct-horse-battery-staple';
const KEYS = ['id', 'firstName', 'lastName', 'email', 'phone', 'status', 'temperature', 'source', 'createdAt', 'assignedAt'];

let app: INestApplication;
let prisma: PrismaService;
let base: string;

const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];

type Lead = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function list(token?: string): Promise<{ status: number; body: Lead[]; text: string }> {
  const res = await fetch(`${base}/api/agents/me/leads`, token ? { headers: { authorization: `Bearer ${token}` } } : {});
  const text = await res.text();
  let body: Lead[] = [];
  try {
    body = JSON.parse(text);
  } catch {
    // raw text is still in the assertion message
  }
  return { status: res.status, body, text };
}

async function post(path: string, body: unknown): Promise<Record<string, any>> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  assert.ok(res.status < 300, JSON.stringify(json));
  return json;
}

async function signupOwner(tag: string) {
  const b = await post('/api/auth/signup', {
    email: emailFor(tag), password: PASSWORD, firstName: 'Owner', lastName: tag,
    organizationName: `AgentMeLeads ${tag} ${RUN}`, teamSize: 'team', // no agent profile
  });
  createdUserIds.push(b['user'].id);
  createdOrgIds.push(b['organization'].id);
  return { token: b['token'] as string, orgId: b['organization'].id as string };
}

/** An agent with a profile in `orgId`, signed in. */
async function agent(orgId: string, tag: string) {
  const u = await prisma.users.create({
    data: { email: emailFor(tag), first_name: tag, password_hash: await hashPassword(PASSWORD) },
    select: { id: true },
  });
  createdUserIds.push(u.id);
  await prisma.organization_members.create({ data: { organization_id: orgId, user_id: u.id, role: 'agent' } });
  const profile = await prisma.agent_profiles.create({
    data: { organization_id: orgId, user_id: u.id, display_name: tag },
    select: { id: true },
  });
  const login = await post('/api/auth/login', { email: emailFor(tag), password: PASSWORD });
  return { profileId: profile.id, token: login['token'] as string };
}

const t0 = new Date(Date.now() - 86400e3).getTime();
let ownerA = { token: '', orgId: '' };
let X = { profileId: '', token: '' };
let Y = { profileId: '', token: '' };
let Z = { profileId: '', token: '' };
let W = { profileId: '', token: '' };
let sourceId = '';
let leadIds: string[] = [];
const id: Record<string, string> = {};

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

  ownerA = await signupOwner('a');
  const ownerB = await signupOwner('b');
  X = await agent(ownerA.orgId, 'x'); // more than a page of leads
  Y = await agent(ownerA.orgId, 'y'); // colleague
  Z = await agent(ownerA.orgId, 'z'); // none
  W = await agent(ownerB.orgId, 'w'); // other organization

  sourceId = (
    await prisma.lead_sources.create({
      data: { organization_id: ownerA.orgId, name: 'Buyer Inquiry', code: `aml-${RUN}`, source_type: 'webhook', provider: 'tally' },
    })
  ).id;

  // 205 leads for X, one minute apart: i = 204 is the newest.
  const leads = await prisma.leads.createManyAndReturn({
    data: Array.from({ length: 205 }, (_, i) => ({
      organization_id: ownerA.orgId,
      first_name: i % 7 === 0 ? null : `L${i}`,
      last_name: i % 3 ? `Last${i}` : null,
      email: i % 4 === 0 ? null : `l${i}@example.invalid`,
      phone: i % 2 ? `+1512555${1000 + i}` : null,
      status: i === 204 ? 'booked' : 'contacting',
      temperature: i % 5 === 0 ? 'hot' : null,
      lead_source_id: i % 3 === 0 ? null : sourceId,
      created_at: new Date(t0 + i * 60e3),
    })),
    select: { id: true },
  });
  leadIds = leads.map((l) => l.id);
  await prisma.lead_assignments.createMany({
    data: leadIds.map((leadId, i) => ({
      organization_id: ownerA.orgId, lead_id: leadId, agent_id: X.profileId, assignment_type: 'manual',
      assigned_at: new Date(t0 + i * 1000),
    })),
  });
  // The newest lead also has an earlier, retired assignment to X.
  await prisma.lead_assignments.create({
    data: { organization_id: ownerA.orgId, lead_id: leadIds[204]!, agent_id: X.profileId, assignment_type: 'manual', is_current: false, assigned_at: new Date(t0 - 5000) },
  });

  // Newer than all of X's: reassigned from X to Y, and Y's own.
  const lead = async (orgId: string, name: string, minute: number) =>
    (await prisma.leads.create({ data: { organization_id: orgId, first_name: name, created_at: new Date(t0 + minute * 60e3) }, select: { id: true } })).id;
  const assign = (orgId: string, leadId: string, agentId: string, is_current: boolean, ms: number) =>
    prisma.lead_assignments.create({
      data: { organization_id: orgId, lead_id: leadId, agent_id: agentId, assignment_type: 'manual', is_current, assigned_at: new Date(t0 + ms) },
    });
  id['moved'] = await lead(ownerA.orgId, 'Moved', 300);
  await assign(ownerA.orgId, id['moved'], X.profileId, false, 0);
  await assign(ownerA.orgId, id['moved'], Y.profileId, true, 7000);
  id['yours'] = await lead(ownerA.orgId, 'Yours', 301);
  await assign(ownerA.orgId, id['yours'], Y.profileId, true, 8000);
  id['other'] = await lead(ownerB.orgId, 'OtherOrg', 302);
  await assign(ownerB.orgId, id['other'], W.profileId, true, 0);
});

after(async () => {
  try {
    await prisma.leads.deleteMany({ where: { organization_id: { in: createdOrgIds } } });
    await prisma.lead_sources.deleteMany({ where: { organization_id: { in: createdOrgIds } } });
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

test('newest lead first, at most 200, exact keys on every row', async () => {
  const res = await list(X.token);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.length, 200);
  for (const l of res.body) assert.deepEqual(Object.keys(l), KEYS);
  // Leads 204 down to 5: the five oldest fall off the page.
  assert.deepEqual(res.body.map((l) => l['id']), leadIds.slice(5).reverse());
});

test('every field follows its rule: source or null, null contact fields, legacy status', async () => {
  const byId = new Map((await list(X.token)).body.map((l) => [l['id'], l]));

  const newest = byId.get(leadIds[204])!; // i = 204: legacy 'booked', no source (204 % 3 === 0)
  assert.equal(newest['status'], 'appointment_booked');
  assert.equal(newest['firstName'], 'L204');
  assert.equal(newest['source'], null);
  assert.deepEqual(byId.get(leadIds[203])!['source'], { name: 'Buyer Inquiry', provider: 'tally' });

  const bare = byId.get(leadIds[12])!; // i = 12: no source, email, phone, last name or temperature
  assert.deepEqual(
    { firstName: bare['firstName'], lastName: bare['lastName'], email: bare['email'], phone: bare['phone'], source: bare['source'], temperature: bare['temperature'] },
    { firstName: 'L12', lastName: null, email: null, phone: null, source: null, temperature: null },
  );
  assert.equal(byId.get(leadIds[196])!['firstName'], null); // i % 7 === 0
  assert.equal(byId.get(leadIds[200])!['temperature'], 'hot');
  assert.equal(byId.get(leadIds[199])!['status'], 'contacting');
  assert.equal(byId.get(leadIds[199])!['createdAt'], new Date(t0 + 199 * 60e3).toISOString());
});

test('assignedAt is the current assignment, not a retired one', async () => {
  const newest = (await list(X.token)).body[0]!;
  assert.equal(newest['id'], leadIds[204]);
  assert.equal(newest['assignedAt'], new Date(t0 + 204 * 1000).toISOString());
});

test("a reassigned-away lead and a colleague's lead are not listed; the colleague sees both", async () => {
  const mine = (await list(X.token)).body.map((l) => l['id']);
  assert.ok(!mine.includes(id['moved']));
  assert.ok(!mine.includes(id['yours']));

  const theirs = (await list(Y.token)).body;
  assert.deepEqual(theirs.map((l) => l['id']), [id['yours'], id['moved']]);
  assert.equal(theirs[1]!['assignedAt'], new Date(t0 + 7000).toISOString());
  assert.equal(theirs[1]!['source'], null);
});

test('another organization: never listed here, and its agent sees only its own', async () => {
  assert.ok(!(await list(X.token)).body.some((l) => l['id'] === id['other']));
  const other = await list(W.token);
  assert.equal(other.status, 200, other.text);
  assert.deepEqual(other.body.map((l) => l['id']), [id['other']]);
});

test('an agent with no leads gets an empty list', async () => {
  const res = await list(Z.token);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.text, '[]');
});

test('an owner without an agent profile is forbidden; no or bad token is unauthenticated', async () => {
  assert.equal((await list(ownerA.token)).status, 403);
  assert.equal((await list()).status, 401);
  assert.equal((await list('not-a-jwt')).status, 401);
});
