import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AuthModule } from '../../auth/auth.module';
import { envSchema } from '../../app.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { AgentsModule } from '../agents/agents.module';
import { CalendarModule } from '../calendar/calendar.module';
import { HistoryModule } from './history.module';

/**
 * Integration suite for the `?leadId=` filter on the call, conversation and
 * appointment lists, against the real database. Run with `npm run test:history`.
 *
 * The filter narrows; it must never widen. So the cases are: the owner sees
 * the lead, an agent sees their own lead, an agent asking for a colleague's
 * lead gets nothing, and a lead id from another organization gets nothing.
 */

// CalendarModule pulls in TelnyxModule. Nothing here may start the background
// pollers against the shared database, whatever the developer's .env says.
process.env['STRATEGY_ENGINE'] = '0';
process.env['CALENDAR_SYNC'] = '0';
process.env['WORKER_ENABLED'] = 'false';

const RUN = Date.now().toString(36);
const emailFor = (tag: string): string => `history-${RUN}-${tag}@example.invalid`;
const PASSWORD = 'correct-horse-battery-staple';

let app: INestApplication;
let prisma: PrismaService;
let base: string;

const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];
const createdLeadIds: string[] = [];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(path: string, token?: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: any; text: string }> {
  const res = await fetch(base + path, {
    method: init.method ?? 'GET',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  let body: unknown = {};
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
    body: { email: emailFor(tag), password: PASSWORD, firstName: 'Own', lastName: 'Er', organizationName: `History ${tag} ${RUN}` },
  });
  assert.equal(res.status, 201, res.text);
  createdUserIds.push(res.body.user.id);
  createdOrgIds.push(res.body.organization.id);
  return { token: res.body.token as string, orgId: res.body.organization.id as string };
}

async function createAgent(ownerToken: string, orgId: string, tag: string) {
  const created = await call('/api/agents', ownerToken, {
    method: 'POST',
    body: { email: emailFor(tag), password: PASSWORD, firstName: 'Ag', lastName: tag },
  });
  assert.equal(created.status, 201, created.text);
  createdUserIds.push(created.body.id);
  const login = await call('/api/auth/login', undefined, {
    method: 'POST',
    body: { email: emailFor(tag), password: PASSWORD },
  });
  assert.equal(login.status, 200, login.text);
  const profile = await prisma.agent_profiles.findFirstOrThrow({
    where: { organization_id: orgId, user_id: created.body.id },
  });
  return { token: login.body.token as string, profileId: profile.id };
}

/** A lead with one call, one SMS thread (one message) and one appointment. */
async function leadWithActivity(orgId: string, name: string, agentProfileId: string | null) {
  const lead = await prisma.leads.create({
    data: { organization_id: orgId, status: 'contacting', first_name: name },
    select: { id: true },
  });
  createdLeadIds.push(lead.id);
  if (agentProfileId) {
    await prisma.lead_assignments.create({
      data: { organization_id: orgId, lead_id: lead.id, agent_id: agentProfileId, assignment_type: 'manual' },
    });
  }
  await prisma.voice_calls.create({
    data: { organization_id: orgId, lead_id: lead.id, provider: 'telnyx', direction: 'outbound', status: 'completed' },
  });
  const conv = await prisma.conversations.create({
    data: { organization_id: orgId, lead_id: lead.id, channel: 'sms' },
  });
  await prisma.messages.create({
    data: { organization_id: orgId, conversation_id: conv.id, sender_type: 'ai', direction: 'outbound', body: `hi ${name}` },
  });
  if (agentProfileId) {
    const start = new Date(Date.now() + 24 * 3600e3);
    await prisma.appointments.create({
      data: {
        organization_id: orgId,
        lead_id: lead.id,
        agent_id: agentProfileId,
        provider: 'calendly',
        start_at: start,
        end_at: new Date(start.getTime() + 30 * 60e3),
      },
    });
  }
  return lead.id;
}

let ownerA = { token: '', orgId: '' };
let ownerB = { token: '', orgId: '' };
let alice = { token: '', profileId: '' };
let leadAlice = '';
let leadBob = '';
let leadOtherOrg = '';

before(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, validate: (raw) => ({ ...raw, ...envSchema.parse(raw) }) }),
      PrismaModule,
      AuthModule,
      AgentsModule,
      HistoryModule,
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
  alice = await createAgent(ownerA.token, ownerA.orgId, 'alice');
  const bob = await createAgent(ownerA.token, ownerA.orgId, 'bob');
  const agentB = await createAgent(ownerB.token, ownerB.orgId, 'carol');

  leadAlice = await leadWithActivity(ownerA.orgId, 'Alicelead', alice.profileId);
  leadBob = await leadWithActivity(ownerA.orgId, 'Boblead', bob.profileId);
  leadOtherOrg = await leadWithActivity(ownerB.orgId, 'Otherorg', agentB.profileId);
});

after(async () => {
  try {
    // Leads first: calls, threads, messages, appointments and assignments
    // cascade from them, and assignments RESTRICT the agent-profile cascade.
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

const leadIdsOf = (rows: { leadId: string }[]): string[] => [...new Set(rows.map((r) => r.leadId))];

test('owner: ?leadId= returns exactly that lead on all three lists', async () => {
  const calls = await call(`/api/v1/calls?leadId=${leadAlice}`, ownerA.token);
  const convs = await call(`/api/v1/conversations?leadId=${leadAlice}`, ownerA.token);
  const appts = await call(`/api/appointments?leadId=${leadAlice}`, ownerA.token);
  assert.equal(calls.status, 200, calls.text);
  assert.deepEqual(leadIdsOf(calls.body), [leadAlice]);
  assert.equal(calls.body.length, 1);
  assert.deepEqual(leadIdsOf(convs.body), [leadAlice]);
  assert.equal(appts.status, 200, appts.text);
  assert.deepEqual(leadIdsOf(appts.body), [leadAlice]);
});

test('owner: without ?leadId= the lists are unchanged (both leads)', async () => {
  const calls = await call('/api/v1/calls', ownerA.token);
  const convs = await call('/api/v1/conversations', ownerA.token);
  assert.deepEqual(leadIdsOf(calls.body).sort(), [leadAlice, leadBob].sort());
  assert.deepEqual(leadIdsOf(convs.body).sort(), [leadAlice, leadBob].sort());
});

test('agent: ?leadId= of their own lead returns it', async () => {
  const calls = await call(`/api/v1/calls?leadId=${leadAlice}`, alice.token);
  const convs = await call(`/api/v1/conversations?leadId=${leadAlice}`, alice.token);
  assert.equal(calls.status, 200, calls.text);
  assert.deepEqual(leadIdsOf(calls.body), [leadAlice]);
  assert.deepEqual(leadIdsOf(convs.body), [leadAlice]);
});

test("agent: ?leadId= of a colleague's lead returns nothing", async () => {
  const calls = await call(`/api/v1/calls?leadId=${leadBob}`, alice.token);
  const convs = await call(`/api/v1/conversations?leadId=${leadBob}`, alice.token);
  assert.equal(calls.status, 200, calls.text);
  assert.deepEqual(calls.body, []);
  assert.equal(convs.status, 200, convs.text);
  assert.deepEqual(convs.body, []);
});

test('agent: the owner-only appointment list stays forbidden, filter or not', async () => {
  const appts = await call(`/api/appointments?leadId=${leadAlice}`, alice.token);
  assert.equal(appts.status, 403, appts.text);
});

test('a leadId from another organization returns nothing, for owner and agent', async () => {
  for (const token of [ownerA.token, alice.token]) {
    const calls = await call(`/api/v1/calls?leadId=${leadOtherOrg}`, token);
    const convs = await call(`/api/v1/conversations?leadId=${leadOtherOrg}`, token);
    assert.deepEqual(calls.body, []);
    assert.deepEqual(convs.body, []);
  }
  const appts = await call(`/api/appointments?leadId=${leadOtherOrg}`, ownerA.token);
  assert.equal(appts.status, 200, appts.text);
  assert.deepEqual(appts.body, []);
  // And the other org still sees its own lead, so the empty result above is
  // the scoping, not missing data.
  const own = await call(`/api/v1/calls?leadId=${leadOtherOrg}`, ownerB.token);
  assert.deepEqual(leadIdsOf(own.body), [leadOtherOrg]);
});

test('a malformed leadId is rejected', async () => {
  for (const path of ['/api/v1/calls?leadId=not-a-uuid', '/api/v1/conversations?leadId=not-a-uuid', '/api/appointments?leadId=not-a-uuid']) {
    const res = await call(path, ownerA.token);
    assert.equal(res.status, 400, `${path}: ${res.text}`);
  }
});
