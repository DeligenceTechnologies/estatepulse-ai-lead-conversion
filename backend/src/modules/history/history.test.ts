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
import { EventsModule } from '../events/events.module';
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
    data: { organization_id: orgId, status: 'contacted', first_name: name },
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
      EventsModule,
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

// --- one lead's SMS messages: GET /api/v1/messages?leadId= ----------------------

/** What the lead view used to assemble: the thread list, then each SMS thread's messages, in order. */
async function messagesThreadByThread(leadId: string, token: string): Promise<string> {
  const threads = await call(`/api/v1/conversations?limit=200&leadId=${leadId}`, token);
  assert.equal(threads.status, 200, threads.text);
  const parts: unknown[] = [];
  for (const thread of (threads.body as Array<{ id: string; channel: string }>).filter((t) => t.channel === 'sms')) {
    const res = await call(`/api/v1/conversations/${thread.id}/messages`, token);
    assert.equal(res.status, 200, res.text);
    parts.push(...(res.body as unknown[]));
  }
  return JSON.stringify(parts);
}

/** A lead of alice's with two SMS threads, a voice thread with messages, and distinct timestamps throughout. */
async function leadWithThreads(): Promise<string> {
  const lead = await prisma.leads.create({
    data: { organization_id: ownerA.orgId, status: 'contacted', first_name: 'Threads' },
    select: { id: true },
  });
  createdLeadIds.push(lead.id);
  await prisma.lead_assignments.create({
    data: { organization_id: ownerA.orgId, lead_id: lead.id, agent_id: alice.profileId, assignment_type: 'manual' },
  });
  const start = Date.parse('2026-09-01T12:00:00.000Z');
  let n = 0;
  for (const [channel, count, updated] of [
    ['sms', 4, '2026-10-02'],
    ['voice', 2, '2026-10-05'],
    ['sms', 3, '2026-10-04'],
  ] as const) {
    const thread = await prisma.conversations.create({
      data: { organization_id: ownerA.orgId, lead_id: lead.id, channel, updated_at: new Date(updated) },
      select: { id: true },
    });
    await prisma.messages.createMany({
      data: Array.from({ length: count }, (_, i) => {
        const at = new Date(start + n++ * 60e3);
        return {
          organization_id: ownerA.orgId,
          conversation_id: thread.id,
          sender_type: i % 2 ? 'lead' : 'ai',
          direction: i % 2 ? 'inbound' : 'outbound',
          body: `${channel} ${updated} #${i}`,
          delivery_status: i % 3 === 2 ? 'failed' : 'delivered',
          sent_at: i % 2 ? null : new Date(at.getTime() + 1000),
          created_at: at,
        };
      }),
    });
  }
  return lead.id;
}

test("lead messages: exactly the thread list's SMS threads, each thread's messages in order, in one request", async () => {
  const leadId = await leadWithThreads();
  for (const token of [ownerA.token, alice.token]) {
    const expected = await messagesThreadByThread(leadId, token);
    const res = await call(`/api/v1/messages?leadId=${leadId}`, token);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.text, expected);
    // Newest thread first, SMS only: the voice thread's messages are not in it.
    assert.deepEqual(
      (res.body as Array<{ body: string }>).map((m) => m.body),
      ['sms 2026-10-04 #0', 'sms 2026-10-04 #1', 'sms 2026-10-04 #2', 'sms 2026-10-02 #0', 'sms 2026-10-02 #1', 'sms 2026-10-02 #2', 'sms 2026-10-02 #3'],
    );
  }
});

test('lead messages: each thread keeps its own 500-message cap, oldest first', async () => {
  const lead = await prisma.leads.create({ data: { organization_id: ownerA.orgId, status: 'contacted' }, select: { id: true } });
  createdLeadIds.push(lead.id);
  const thread = await prisma.conversations.create({
    data: { organization_id: ownerA.orgId, lead_id: lead.id, channel: 'sms' },
    select: { id: true },
  });
  const start = Date.parse('2026-09-01T00:00:00.000Z');
  await prisma.messages.createMany({
    data: Array.from({ length: 502 }, (_, i) => ({
      organization_id: ownerA.orgId,
      conversation_id: thread.id,
      sender_type: 'ai',
      direction: 'outbound',
      body: `#${i}`,
      created_at: new Date(start + i * 1000),
    })),
  });

  const res = await call(`/api/v1/messages?leadId=${lead.id}`, ownerA.token);
  assert.equal(res.status, 200, res.text.slice(0, 200));
  assert.equal(res.text, await messagesThreadByThread(lead.id, ownerA.token));
  assert.equal(res.body.length, 500);
  assert.equal(res.body[499].body, '#499');
});

test("lead messages: an agent gets nothing for a colleague's lead, and nobody for another organization's", async () => {
  for (const [leadId, token] of [
    [leadBob, alice.token],
    [leadOtherOrg, ownerA.token],
    [leadOtherOrg, alice.token],
    ['00000000-0000-4000-8000-000000000000', ownerA.token],
  ] as const) {
    const res = await call(`/api/v1/messages?leadId=${leadId}`, token);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body, []);
  }
  // The scoping, not missing data: each lead's own office sees its texts.
  const own = await call(`/api/v1/messages?leadId=${leadOtherOrg}`, ownerB.token);
  assert.equal(own.body.length, 1);
  const bobs = await call(`/api/v1/messages?leadId=${leadBob}`, ownerA.token);
  assert.equal(bobs.body.length, 1);
});

test('lead messages: a missing or malformed leadId is a 400, and no session a 401', async () => {
  for (const path of ['/api/v1/messages', '/api/v1/messages?leadId=not-a-uuid']) {
    const res = await call(path, ownerA.token);
    assert.equal(res.status, 400, `${path}: ${res.text}`);
  }
  const anonymous = await call(`/api/v1/messages?leadId=${leadAlice}`);
  assert.equal(anonymous.status, 401, anonymous.text);
});

// --- one lead's calls: GET /api/v1/calls?leadId= (the lead detail view) ------

/**
 * A booked lead of alice's with calls of every kind: each status, a handoff, a
 * DNC, and a transcript that is text, empty, blank or absent.
 */
async function leadWithCalls(): Promise<string> {
  const lead = await prisma.leads.create({
    data: { organization_id: ownerA.orgId, status: 'appointment_booked', first_name: 'Callie', last_name: 'Caller', temperature: 'hot', phone: '+15125550111' },
    select: { id: true },
  });
  createdLeadIds.push(lead.id);
  await prisma.lead_assignments.create({
    data: { organization_id: ownerA.orgId, lead_id: lead.id, agent_id: alice.profileId, assignment_type: 'manual' },
  });
  const start = Date.parse('2026-09-01T12:00:00.000Z');
  const kinds = [
    { status: 'completed', transcript: 'AI: Hello\nLead: Hi, still looking.' },
    { status: 'no_answer', transcript: null },
    { status: 'failed', transcript: '' },
    { status: 'in_progress', transcript: ' ' },
    { status: 'completed', transcript: 'Transcript', handoff_requested: true },
    { status: 'completed', transcript: null, dnc_detected: true },
    { status: 'queued', transcript: null },
    { status: 'completed', transcript: 'Newest', duration_seconds: 245, recording_url: 'https://rec.example.invalid/1.mp3' },
  ];
  await prisma.voice_calls.createMany({
    data: kinds.map((kind, i) => ({
      organization_id: ownerA.orgId,
      lead_id: lead.id,
      provider: 'telnyx',
      provider_call_id: `call-${RUN}-${i}`,
      direction: i % 2 ? 'inbound' : 'outbound',
      started_at: new Date(start + i * 3600e3),
      ended_at: i % 2 ? null : new Date(start + i * 3600e3 + 60e3),
      created_at: new Date(start + i * 3600e3),
      ...kind,
    })),
  });
  return lead.id;
}

test("lead calls: the lead view's request answers exactly as the general list does for the same calls", async () => {
  const leadId = await leadWithCalls();
  for (const token of [ownerA.token, alice.token]) {
    const leadView = await call(`/api/v1/calls?leadId=${leadId}&limit=200`, token);
    // An extra filter that keeps every one of these calls takes the general path.
    const general = await call(`/api/v1/calls?leadId=${leadId}&limit=200&from=2000-01-01T00:00:00.000Z`, token);
    assert.equal(leadView.status, 200, leadView.text);
    assert.equal(general.status, 200, general.text);
    assert.equal(leadView.text, general.text);
    assert.equal(leadView.body.length, 8);
  }
});

test('lead calls: newest first; hasTranscript only where there is text; the booked outcome on the newest call only', async () => {
  const leadId = await leadWithCalls();
  const res = await call(`/api/v1/calls?leadId=${leadId}&limit=200`, ownerA.token);
  assert.equal(res.status, 200, res.text);
  const rows = res.body as Array<{ providerCallId: string; hasTranscript: boolean; outcome: string; agentName: string | null; leadName: string }>;

  assert.deepEqual(
    rows.map((r) => r.providerCallId),
    [7, 6, 5, 4, 3, 2, 1, 0].map((i) => `call-${RUN}-${i}`),
  );
  assert.deepEqual(
    rows.map((r) => r.hasTranscript),
    [true, false, false, true, true, false, false, true],
  );
  assert.deepEqual(
    rows.map((r) => r.outcome),
    ['APPOINTMENT_BOOKED', 'IN_PROGRESS', 'NOT_INTERESTED', 'HUMAN_HANDOFF', 'IN_PROGRESS', 'FAILED', 'NO_ANSWER', 'ANSWERED'],
  );
  assert.ok(rows.every((r) => r.leadName === 'Callie Caller' && r.agentName === 'Ag alice'));
  // The transcript text itself is never part of a list row.
  assert.ok(!res.text.includes('still looking'));
});

test('lead calls: ?limit= caps the page to the newest calls', async () => {
  const leadId = await leadWithCalls();
  const two = await call(`/api/v1/calls?leadId=${leadId}&limit=2`, ownerA.token);
  assert.deepEqual(
    (two.body as Array<{ providerCallId: string }>).map((r) => r.providerCallId),
    [`call-${RUN}-7`, `call-${RUN}-6`],
  );
  const capped = await call(`/api/v1/calls?leadId=${leadId}&limit=500`, ownerA.token);
  assert.equal(capped.body.length, 8);
});

test('lead calls: an unknown lead is an empty list, and no session a 401', async () => {
  const unknown = await call('/api/v1/calls?leadId=00000000-0000-4000-8000-000000000000&limit=200', ownerA.token);
  assert.equal(unknown.status, 200, unknown.text);
  assert.deepEqual(unknown.body, []);
  const anonymous = await call(`/api/v1/calls?leadId=${leadAlice}&limit=200`);
  assert.equal(anonymous.status, 401, anonymous.text);
});
