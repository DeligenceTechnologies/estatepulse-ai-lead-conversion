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
import { CalendarModule } from './calendar.module';
import { EventsModule } from '../events/events.module';

/**
 * Integration suite for GET /api/leads/:leadId/appointments — the lead
 * dossier's appointments tab — against the real database. Run with
 * `npm run test:lead-appointments`.
 *
 * Who may see a lead: an owner, any lead in their organization; an agent, only
 * a lead currently assigned to them. Anything else is the same 404 as a lead
 * that does not exist.
 */

// CalendarModule pulls in TelnyxModule. Nothing here may start the background
// pollers against the shared database, whatever the developer's .env says.
process.env['STRATEGY_ENGINE'] = '0';
process.env['CALENDAR_SYNC'] = '0';
process.env['WORKER_ENABLED'] = 'false';

const RUN = Date.now().toString(36);
const emailFor = (tag: string): string => `lead-appts-${RUN}-${tag}@example.invalid`;
const PASSWORD = 'correct-horse-battery-staple';
const NOT_FOUND = '{"error":{"code":"NOT_FOUND","message":"No such lead"}}';

let app: INestApplication;
let prisma: PrismaService;
let base: string;

const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];
const createdLeadIds: string[] = [];

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

const appointmentsOf = (leadId: string, token?: string) => call(`/api/leads/${leadId}/appointments`, token);

async function signupOwner(tag: string) {
  const res = await call('/api/auth/signup', undefined, {
    method: 'POST',
    body: { email: emailFor(tag), password: PASSWORD, firstName: 'Own', lastName: 'Er', organizationName: `Lead appts ${tag} ${RUN}` },
  });
  assert.equal(res.status, 201, res.text);
  const body = JSON.parse(res.text);
  createdUserIds.push(body.user.id);
  createdOrgIds.push(body.organization.id);
  return { token: body.token as string, orgId: body.organization.id as string };
}

async function createAgent(ownerToken: string, orgId: string, tag: string) {
  const created = await call('/api/agents', ownerToken, {
    method: 'POST',
    body: { email: emailFor(tag), password: PASSWORD, firstName: 'Ag', lastName: tag },
  });
  assert.equal(created.status, 201, created.text);
  const userId = JSON.parse(created.text).id as string;
  createdUserIds.push(userId);
  const login = await call('/api/auth/login', undefined, { method: 'POST', body: { email: emailFor(tag), password: PASSWORD } });
  assert.equal(login.status, 200, login.text);
  const profile = await prisma.agent_profiles.findFirstOrThrow({ where: { organization_id: orgId, user_id: userId } });
  return { token: JSON.parse(login.text).token as string, profileId: profile.id, name: profile.display_name };
}

async function lead(orgId: string, data: { first_name?: string; last_name?: string; email?: string; phone?: string; status?: string }) {
  const row = await prisma.leads.create({ data: { organization_id: orgId, status: 'new', ...data }, select: { id: true } });
  createdLeadIds.push(row.id);
  return row.id;
}

const assign = (orgId: string, leadId: string, agentId: string, isCurrent: boolean) =>
  prisma.lead_assignments.create({
    data: { organization_id: orgId, lead_id: leadId, agent_id: agentId, assignment_type: 'manual', is_current: isCurrent },
  });

const appointment = (orgId: string, leadId: string, agentId: string, startIso: string) =>
  prisma.appointments.create({
    data: {
      organization_id: orgId,
      lead_id: leadId,
      agent_id: agentId,
      provider: 'calendly',
      start_at: new Date(startIso),
      end_at: new Date(Date.parse(startIso) + 30 * 60e3),
    },
  });

let ownerA = { token: '', orgId: '' };
let ownerB = { token: '', orgId: '' };
let alice = { token: '', profileId: '', name: '' };
let bob = { token: '', profileId: '', name: '' };
let leadFull = '';
let leadEmpty = '';
let leadBobs = '';
let leadOtherOrg = '';
/** leadFull's response, exactly as it must be sent. */
let fullBody = '';

before(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, validate: (raw) => ({ ...raw, ...envSchema.parse(raw) }) }),
      PrismaModule,
      AuthModule,
      EventsModule,
      AgentsModule,
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
  bob = await createAgent(ownerA.token, ownerA.orgId, 'bob');
  const carol = await createAgent(ownerB.token, ownerB.orgId, 'carol');

  // Alice's now, Bob's before her.
  leadFull = await lead(ownerA.orgId, {
    first_name: 'Bea',
    last_name: 'Buyer',
    email: 'bea@example.invalid',
    phone: '+15125550123',
    status: 'contacted',
  });
  await assign(ownerA.orgId, leadFull, bob.profileId, false);
  await assign(ownerA.orgId, leadFull, alice.profileId, true);

  // Inserted oldest first, so the order in the response is the query's doing.
  const earlier = await prisma.appointments.create({
    data: {
      organization_id: ownerA.orgId,
      lead_id: leadFull,
      agent_id: alice.profileId,
      provider: 'calendly',
      status: 'cancelled',
      start_at: new Date('2026-12-01T09:30:00.000Z'),
      end_at: new Date('2026-12-01T10:00:00.000Z'),
      metadata: { canceledReason: 'Client asked to move it' },
    },
  });
  const later = await prisma.appointments.create({
    data: {
      organization_id: ownerA.orgId,
      lead_id: leadFull,
      agent_id: bob.profileId,
      provider: 'calendly',
      external_event_id: `ev-${RUN}`,
      status: 'rescheduled',
      start_at: new Date('2026-12-02T15:00:00.000Z'),
      end_at: new Date('2026-12-02T15:45:00.000Z'),
      meeting_url: 'https://meet.example.invalid/abc',
      notes: 'Bring "pre-approval" — ünïcode',
      metadata: {
        eventTypeName: 'Buyer Consultation',
        cancelUrl: 'https://calendly.example.invalid/cancel/x',
        rescheduleUrl: 'https://calendly.example.invalid/reschedule/x',
      },
    },
  });

  const who = { leadId: leadFull, leadName: 'Bea Buyer', leadEmail: 'bea@example.invalid', leadPhone: '+15125550123', leadStatus: 'contacted' };
  fullBody = JSON.stringify([
    {
      id: later.id,
      ...who,
      agentId: bob.profileId,
      agentName: bob.name,
      provider: 'calendly',
      externalEventId: `ev-${RUN}`,
      startTime: '2026-12-02T15:00:00.000Z',
      endTime: '2026-12-02T15:45:00.000Z',
      status: 'rescheduled',
      appointmentType: 'Buyer Consultation',
      meetingUrl: 'https://meet.example.invalid/abc',
      notes: 'Bring "pre-approval" — ünïcode',
      cancelUrl: 'https://calendly.example.invalid/cancel/x',
      rescheduleUrl: 'https://calendly.example.invalid/reschedule/x',
      canceledReason: null,
      createdAt: later.created_at.toISOString(),
    },
    {
      id: earlier.id,
      ...who,
      agentId: alice.profileId,
      agentName: alice.name,
      provider: 'calendly',
      externalEventId: null,
      startTime: '2026-12-01T09:30:00.000Z',
      endTime: '2026-12-01T10:00:00.000Z',
      status: 'cancelled',
      appointmentType: null,
      meetingUrl: null,
      notes: null,
      cancelUrl: null,
      rescheduleUrl: null,
      canceledReason: 'Client asked to move it',
      createdAt: earlier.created_at.toISOString(),
    },
  ]);

  leadEmpty = await lead(ownerA.orgId, { first_name: 'Nora' });
  await assign(ownerA.orgId, leadEmpty, alice.profileId, true);

  leadBobs = await lead(ownerA.orgId, { first_name: 'Bobs' });
  await assign(ownerA.orgId, leadBobs, bob.profileId, true);
  await appointment(ownerA.orgId, leadBobs, bob.profileId, '2026-12-03T12:00:00.000Z');

  leadOtherOrg = await lead(ownerB.orgId, { first_name: 'Other' });
  await assign(ownerB.orgId, leadOtherOrg, carol.profileId, true);
  await appointment(ownerB.orgId, leadOtherOrg, carol.profileId, '2026-12-04T12:00:00.000Z');
});

after(async () => {
  try {
    // Leads first: appointments and assignments cascade from them, and both
    // RESTRICT the agent-profile cascade.
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

test('owner: a lead with appointments, newest first, every field exactly as sent', async () => {
  const res = await appointmentsOf(leadFull, ownerA.token);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.text, fullBody);
});

test('owner: a lead with no appointments is an empty list, not a 404', async () => {
  const res = await appointmentsOf(leadEmpty, ownerA.token);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.text, '[]');
});

test('an agent sees the leads currently assigned to them, exactly as the owner does', async () => {
  const full = await appointmentsOf(leadFull, alice.token);
  assert.equal(full.status, 200, full.text);
  assert.equal(full.text, fullBody);

  const empty = await appointmentsOf(leadEmpty, alice.token);
  assert.equal(empty.status, 200, empty.text);
  assert.equal(empty.text, '[]');
});

test("an agent cannot see a colleague's lead, nor one that was theirs before", async () => {
  // Bob held leadFull before Alice; leadBobs is his now.
  for (const [leadId, token] of [
    [leadFull, bob.token],
    [leadBobs, alice.token],
  ] as const) {
    const res = await appointmentsOf(leadId, token);
    assert.equal(res.status, 404, res.text);
    assert.equal(res.text, NOT_FOUND);
  }
});

test("another organization's lead is the same 404 as one that does not exist", async () => {
  for (const [leadId, token] of [
    [leadOtherOrg, ownerA.token],
    [leadOtherOrg, alice.token],
    [leadFull, ownerB.token],
    ['00000000-0000-4000-8000-000000000000', ownerA.token],
    ['not-a-uuid', ownerA.token],
  ] as const) {
    const res = await appointmentsOf(leadId, token);
    assert.equal(res.status, 404, `${leadId}: ${res.text}`);
    assert.equal(res.text, NOT_FOUND);
  }

  // And their own lead is visible to them, so the 404 above is the tenant line.
  const own = await appointmentsOf(leadOtherOrg, ownerB.token);
  assert.equal(own.status, 200, own.text);
  assert.equal(JSON.parse(own.text).length, 1);
});

test('no session is a 401', async () => {
  const res = await appointmentsOf(leadFull);
  assert.equal(res.status, 401, res.text);
});

test('only the 50 newest appointments are listed', async () => {
  const leadId = await lead(ownerA.orgId, { first_name: 'Busy' });
  const start = Date.parse('2027-01-01T00:00:00.000Z');
  // Shuffled insert order, distinct start times.
  await prisma.appointments.createMany({
    data: Array.from({ length: 53 }, (_, i) => (i * 17) % 53).map((h) => ({
      organization_id: ownerA.orgId,
      lead_id: leadId,
      agent_id: alice.profileId,
      provider: 'calendly',
      start_at: new Date(start + h * 3600e3),
      end_at: new Date(start + h * 3600e3 + 30 * 60e3),
    })),
  });

  const res = await appointmentsOf(leadId, ownerA.token);
  assert.equal(res.status, 200, res.text);
  const starts = (JSON.parse(res.text) as Array<{ startTime: string }>).map((a) => a.startTime);
  assert.deepEqual(
    starts,
    Array.from({ length: 50 }, (_, i) => new Date(start + (52 - i) * 3600e3).toISOString()),
  );
});

test("the lead's name falls back to its email, then its phone, then 'Unnamed lead'", async () => {
  for (const [data, expected] of [
    [{ email: 'only@example.invalid', phone: '+15125550100' }, 'only@example.invalid'],
    [{ phone: '+15125550100' }, '+15125550100'],
    [{}, 'Unnamed lead'],
  ] as const) {
    const leadId = await lead(ownerA.orgId, data);
    await appointment(ownerA.orgId, leadId, alice.profileId, '2026-12-05T12:00:00.000Z');

    const res = await appointmentsOf(leadId, ownerA.token);
    assert.equal(res.status, 200, res.text);
    const [row] = JSON.parse(res.text) as Array<{ leadName: string; leadStatus: string }>;
    assert.equal(row!.leadName, expected);
    assert.equal(row!.leadStatus, 'new');
  }
});
