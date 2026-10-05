import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AuthModule } from '../../auth/auth.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { AgentsModule } from '../agents/agents.module';
import { LeadsModule } from './leads.module';

/**
 * Integration suite for GET /api/dashboard, against the real database, in the
 * same shape as agent-me.test.ts. Run with `npm run test:dashboard`.
 *
 * Two organizations: B has no leads, so any count it sees from A is a leak.
 */

const RUN = Date.now().toString(36);
const emailFor = (tag: string): string => `dash-${RUN}-${tag}@example.invalid`;
const PASSWORD = 'correct-horse-battery-staple';

let app: INestApplication;
let prisma: PrismaService;
let base: string;

const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];
const createdLeadIds: string[] = [];

async function call(path: string, token?: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(base + path, {
    method: init.method ?? 'GET',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  let body: any = {};
  try {
    body = JSON.parse(text);
  } catch {
    // raw text is still in the assertion message
  }
  return { status: res.status, body, text };
}

async function signupOwner(tag: string) {
  const res = await call('/api/auth/signup', undefined, {
    method: 'POST',
    body: { email: emailFor(tag), password: PASSWORD, firstName: 'Own', lastName: 'Er', organizationName: `Dash ${tag} ${RUN}` },
  });
  assert.equal(res.status, 201, res.text);
  createdUserIds.push(res.body.user.id);
  createdOrgIds.push(res.body.organization.id);
  return { token: res.body.token as string, orgId: res.body.organization.id as string };
}

let ownerA = { token: '', orgId: '' };
let ownerB = { token: '', orgId: '' };
let agentToken = '';
let agentProfileId = '';

async function makeLead(fields: Record<string, unknown>): Promise<string> {
  const lead = await prisma.leads.create({
    data: { organization_id: ownerA.orgId, status: 'new', ...fields },
    select: { id: true },
  });
  createdLeadIds.push(lead.id);
  return lead.id;
}

before(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, AuthModule, AgentsModule, LeadsModule],
  }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  prisma = app.get(PrismaService);

  ownerA = await signupOwner('owner-a');
  ownerB = await signupOwner('owner-b');

  const created = await call('/api/agents', ownerA.token, {
    method: 'POST',
    body: { email: emailFor('agent'), password: PASSWORD, firstName: 'Ag', lastName: 'Ent' },
  });
  assert.equal(created.status, 201, created.text);
  createdUserIds.push(created.body.id);
  const login = await call('/api/auth/login', undefined, {
    method: 'POST',
    body: { email: emailFor('agent'), password: PASSWORD },
  });
  agentToken = login.body.token;
  agentProfileId = (await prisma.agent_profiles.findFirstOrThrow({
    where: { organization_id: ownerA.orgId, user_id: created.body.id },
  })).id;

  const t = Date.now();
  // Contacted after 10s, 30s and 50s (below) -> median 30s, all within 60s.
  await makeLead({ temperature: 'hot', created_at: new Date(t - 10_000), first_contact_at: new Date(t), status: 'contacted' });
  await makeLead({ temperature: 'cold', created_at: new Date(t - 30_000), first_contact_at: new Date(t), status: 'nurture' });
  // Never contacted, unrated.
  await makeLead({ needs_review: true });
  // Hot but held by the agent: not "hot unassigned".
  const held = await makeLead({ temperature: 'hot', status: 'qualified', created_at: new Date(t - 50_000), first_contact_at: new Date(t) });
  await prisma.lead_assignments.create({
    data: { organization_id: ownerA.orgId, lead_id: held, agent_id: agentProfileId, assignment_type: 'manual' },
  });
  // Hot but lost: excluded from open temperature counts.
  await makeLead({ temperature: 'hot', status: 'lost' });
});

after(async () => {
  try {
    // Leads first: lead_assignments.agent_id RESTRICTs the profile cascade.
    await prisma.leads.deleteMany({ where: { id: { in: createdLeadIds } } });
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

test('unauthenticated request is rejected', async () => {
  assert.equal((await call('/api/dashboard')).status, 401);
});

test('an agent cannot read the owner dashboard', async () => {
  assert.equal((await call('/api/dashboard', agentToken)).status, 403);
});

test('owner sees real counts for their own organization', async () => {
  const res = await call('/api/dashboard', ownerA.token);
  assert.equal(res.status, 200, res.text);
  const d = res.body;

  assert.equal(d.leads.total, 5);
  assert.equal(d.leads.last7Days, 5);
  assert.deepEqual(d.leads.byStatus, { new: 1, contacted: 1, nurture: 1, qualified: 1, lost: 1 });
  assert.deepEqual(d.leads.byTemperature, { hot: 2, warm: 0, cold: 1, unrated: 1 });

  assert.equal(d.attention.hotUnassigned, 1);
  assert.equal(d.attention.neverContacted, 1);
  assert.equal(d.attention.needsReview, 1);

  assert.equal(d.speedToLead.sample, 3);
  assert.equal(d.speedToLead.medianSeconds, 30);
  assert.equal(d.speedToLead.within60sPct, 100);

  assert.equal(d.calls7Days.total, 0);
  assert.equal(d.upcomingAppointments, 0);
  assert.deepEqual(d.sources30Days, [{ name: 'No source', count: 5 }]);
});

test("another organization's owner sees none of it", async () => {
  const res = await call('/api/dashboard', ownerB.token);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.leads.total, 0);
  assert.equal(res.body.attention.hotUnassigned, 0);
  assert.equal(res.body.speedToLead.medianSeconds, null);
  assert.deepEqual(res.body.sources30Days, []);
});
