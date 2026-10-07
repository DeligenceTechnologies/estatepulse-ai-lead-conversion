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
 * Integration suite pinning the GET /api/agents/me/dashboard contract against
 * the real database. Run with `npm run test:agent-me-dashboard`.
 *
 * Four counts, each with its own rule: leads currently assigned to the caller;
 * of those, the ones not in an inactive status (legacy 'lost' included,
 * legacy 'booked' still active); of those, the ones still 'new'; and the
 * caller's upcoming scheduled or rescheduled appointments. A lead reassigned
 * away, a colleague's, and another organization's must not count.
 */

const RUN = Date.now().toString(36);
const emailFor = (tag: string): string => `agent-me-dash-${RUN}-${tag}@example.invalid`;
const PASSWORD = 'correct-horse-battery-staple';

let app: INestApplication;
let prisma: PrismaService;
let base: string;

const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];

async function dashboard(token?: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${base}/api/agents/me/dashboard`, token ? { headers: { authorization: `Bearer ${token}` } } : {});
  return { status: res.status, text: await res.text() };
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
    organizationName: `AgentMeDash ${tag} ${RUN}`, teamSize: 'team', // no agent profile
  });
  createdUserIds.push(b['user'].id);
  createdOrgIds.push(b['organization'].id);
  return { token: b['token'] as string, orgId: b['organization'].id as string };
}

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

let ownerA = { token: '', orgId: '' };
let X = { profileId: '', token: '' };
let Y = { profileId: '', token: '' };
let Z = { profileId: '', token: '' };
let W = { profileId: '', token: '' };

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
  X = await agent(ownerA.orgId, 'x');
  Y = await agent(ownerA.orgId, 'y'); // colleague
  Z = await agent(ownerA.orgId, 'z'); // nothing
  W = await agent(ownerB.orgId, 'w'); // other organization

  const lead = async (orgId: string, status: string) =>
    (await prisma.leads.create({ data: { organization_id: orgId, status }, select: { id: true } })).id;
  const assign = (orgId: string, leadId: string, agentId: string, is_current = true) =>
    prisma.lead_assignments.create({
      data: { organization_id: orgId, lead_id: leadId, agent_id: agentId, assignment_type: 'manual', is_current },
    });

  // X currently holds 10: active new, new, contacting, qualified, legacy booked;
  // inactive closed, not_interested, dnc, invalid, legacy lost.
  let xLead = '';
  for (const status of ['new', 'new', 'contacting', 'qualified', 'booked', 'closed', 'not_interested', 'dnc', 'invalid', 'lost']) {
    xLead = await lead(ownerA.orgId, status);
    await assign(ownerA.orgId, xLead, X.profileId);
  }
  // Reassigned from X to Y; and one X held once and nobody holds now.
  const moved = await lead(ownerA.orgId, 'new');
  await assign(ownerA.orgId, moved, X.profileId, false);
  await assign(ownerA.orgId, moved, Y.profileId);
  await assign(ownerA.orgId, await lead(ownerA.orgId, 'new'), X.profileId, false);
  // Y's own; and org B's.
  await assign(ownerA.orgId, await lead(ownerA.orgId, 'contacting'), Y.profileId);
  const bLead = await lead(ownerB.orgId, 'new');
  await assign(ownerB.orgId, bLead, W.profileId);

  const hour = 3600e3;
  const appt = (orgId: string, agentId: string, leadId: string, startIn: number, status: string) =>
    prisma.appointments.create({
      data: {
        organization_id: orgId, agent_id: agentId, lead_id: leadId, provider: 'calendly', status,
        start_at: new Date(Date.now() + startIn), end_at: new Date(Date.now() + startIn + hour / 2),
      },
    });
  // X: two upcoming that count; cancelled, completed and past ones that do not.
  await appt(ownerA.orgId, X.profileId, xLead, 24 * hour, 'scheduled');
  await appt(ownerA.orgId, X.profileId, xLead, 48 * hour, 'rescheduled');
  await appt(ownerA.orgId, X.profileId, xLead, 24 * hour, 'cancelled');
  await appt(ownerA.orgId, X.profileId, xLead, 24 * hour, 'completed');
  await appt(ownerA.orgId, X.profileId, xLead, -24 * hour, 'scheduled');
  await appt(ownerA.orgId, Y.profileId, moved, 24 * hour, 'scheduled');
  await appt(ownerB.orgId, W.profileId, bLead, 24 * hour, 'scheduled');
});

after(async () => {
  try {
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
    await prisma.organizations.deleteMany({ where: { id: { in: createdOrgIds.filter((o) => !audited.has(o)) } } });
  } finally {
    await app.close();
  }
});

test('the four counts, exact body and key order', async () => {
  const res = await dashboard(X.token);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.text, '{"activeLeads":5,"newLeads":2,"upcomingAppointments":2,"totalAssignedLeads":10}');
});

test("a reassigned lead counts for its new holder only; a colleague's never counts here", async () => {
  const res = await dashboard(Y.token);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.text, '{"activeLeads":2,"newLeads":1,"upcomingAppointments":1,"totalAssignedLeads":2}');
});

test('another organization counts only its own', async () => {
  const res = await dashboard(W.token);
  assert.equal(res.text, '{"activeLeads":1,"newLeads":1,"upcomingAppointments":1,"totalAssignedLeads":1}');
});

test('an agent with nothing reads real zeros', async () => {
  const res = await dashboard(Z.token);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.text, '{"activeLeads":0,"newLeads":0,"upcomingAppointments":0,"totalAssignedLeads":0}');
});

test('an owner without an agent profile is forbidden; no or bad token is unauthenticated', async () => {
  assert.equal((await dashboard(ownerA.token)).status, 403);
  assert.equal((await dashboard()).status, 401);
  assert.equal((await dashboard('not-a-jwt')).status, 401);
});
