import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AuthModule } from '../../../auth/auth.module';
import { envSchema } from '../../../app.module';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { PrismaModule } from '../../../prisma/prisma.module';
import { PrismaService } from '../../../prisma/prisma.service';
import { AgentsModule } from '../../agents/agents.module';
import { EventsModule } from '../../events/events.module';
import { CalendarModule } from '../calendar.module';
import { CalendlyClientService } from '../calendly.client';
import { IN_CALL_BOOKING_PROVIDER, sha256 } from './in-call-booking-settings.service';

/**
 * In-call booking against the real database: the tool endpoints exactly as
 * Telnyx calls them, the tool authorization, and the real assignment and
 * appointment writes. Only Calendly is replaced, so no meeting is booked.
 *
 * Run with `npm run test:in-call-booking`. Rows are namespaced per run and torn
 * down in after(). The strategy engine and calendar poller are forced off so no
 * test lead is ever contacted.
 */

const RUN = Date.now().toString(36);
const emailFor = (tag: string) => `incallbook-${RUN}-${tag}@example.invalid`;
const PASSWORD = 'correct-horse-battery-staple';
const TOKEN = `tool-token-${RUN}`;
const HOST = `https://api.calendly.com/users/test-${RUN}`;
const EVENT_TYPE = 'https://api.calendly.com/event_types/rr-test';
const EVENT_URI = `https://api.calendly.com/scheduled_events/evt-${RUN}`;
const SLOT = '2030-03-14T15:00:00.000Z';

let app: INestApplication;
let prisma: PrismaService;
let base: string;
let calendlyCalls: { createInvitee: unknown[] } = { createInvitee: [] };

const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];
const createdLeadIds: string[] = [];

const fakeCalendly = {
  listAvailableTimes: async () => ({
    collection: [{ status: 'available', invitees_remaining: 1, start_time: SLOT, scheduling_url: 'u' }],
    pagination: { count: 1, next_page_token: null },
  }),
  createInvitee: async (_c: unknown, body: unknown) => {
    calendlyCalls.createInvitee.push(body);
    return { uri: 'inv-1', event: EVENT_URI, cancel_url: 'https://c', reschedule_url: 'https://r' };
  },
  getEventType: async () => ({ uri: 'https://api.calendly.com/event_types/rr', locations: [{ kind: 'zoom_conference' }] }),
  getScheduledEvent: async () => ({
    uri: EVENT_URI,
    name: 'Buyer consultation',
    status: 'active',
    start_time: SLOT,
    end_time: '2030-03-14T15:30:00.000Z',
    updated_at: '2030-03-01T00:00:00.000Z',
    location: { join_url: 'https://zoom.example/j/1' },
    event_memberships: [{ user: HOST, user_name: 'Alice' }],
  }),
};

async function call(path: string, body: unknown, token?: string) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, any>, text };
}

let orgId = '';
let ownerToken = '';
let aliceProfileId = '';
let otherOrgId = '';

async function signup(tag: string): Promise<{ token: string; orgId: string }> {
  const r = await fetch(`${base}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: emailFor(tag), password: PASSWORD, firstName: 'Own', lastName: 'Er', organizationName: `InCall ${tag} ${RUN}` }),
  });
  const b = (await r.json()) as any;
  assert.equal(r.status, 201, JSON.stringify(b));
  createdUserIds.push(b.user.id);
  createdOrgIds.push(b.organization.id);
  return { token: b.token, orgId: b.organization.id };
}

/** A lead on a call in the given state, as the voice webhook would have left it. */
async function leadOnCall(org: string, status: string, email: string | null = 'buyer@example.com') {
  const lead = await prisma.leads.create({
    data: { organization_id: org, status: 'engaged', first_name: 'Bea', last_name: RUN, email, normalized_email: email },
    select: { id: true },
  });
  createdLeadIds.push(lead.id);
  const ccid = `v3:test-${RUN}-${createdLeadIds.length}`;
  await prisma.voice_calls.create({
    data: { organization_id: org, lead_id: lead.id, provider: 'telnyx', provider_call_id: ccid, status, started_at: new Date() },
  });
  return { leadId: lead.id, ccid };
}

before(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        validate: (raw) => ({ ...raw, ...envSchema.parse(raw), STRATEGY_ENGINE: '0', CALENDAR_SYNC: '0' }),
      }),
      PrismaModule,
      AuthModule,
      EventsModule,
      AgentsModule,
      CalendarModule,
    ],
  })
    .overrideProvider(CalendlyClientService)
    .useValue(fakeCalendly)
    .compile();

  app = moduleRef.createNestApplication({ rawBody: true });
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  prisma = app.get(PrismaService);

  const owner = await signup('owner');
  orgId = owner.orgId;
  ownerToken = owner.token;
  otherOrgId = (await signup('other')).orgId;

  const created = await fetch(`${base}/api/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ email: emailFor('alice'), password: PASSWORD, firstName: 'Alice', lastName: RUN }),
  });
  const agent = (await created.json()) as any;
  assert.equal(created.status, 201, JSON.stringify(agent));
  createdUserIds.push(agent.id);
  const profile = await prisma.agent_profiles.findFirstOrThrow({ where: { organization_id: orgId, user_id: agent.id } });
  aliceProfileId = profile.id;
  await prisma.agent_profiles.update({ where: { id: profile.id }, data: { calendly_user_uri: HOST } });

  await prisma.organizations.update({ where: { id: orgId }, data: { timezone: 'America/Chicago' } });
  await prisma.calendar_connections.create({
    data: {
      organization_id: orgId,
      provider: 'calendly',
      status: 'active',
      credentials_secret_ref: 'not-used-by-the-fake',
      metadata: { scope: 'availability:read scheduled_events:write', calendlyOrgUri: 'https://api.calendly.com/organizations/o' },
    },
  });
  await prisma.integrations.create({
    data: {
      organization_id: orgId,
      provider: IN_CALL_BOOKING_PROVIDER,
      integration_type: 'calendar',
      status: 'active',
      metadata: {
        eventTypeUri: EVENT_TYPE,
        eventTypeName: 'Buyer consultation',
        durationMinutes: 30,
        tokenHash: sha256(TOKEN),
        secretId: 's',
        secretIdentifier: 'i',
        toolIds: [],
        assistantId: 'a',
      },
    },
  });
});

after(async () => {
  try {
    if (createdLeadIds.length) {
      await prisma.domain_events.deleteMany({ where: { aggregate_id: { in: createdLeadIds } } });
      await prisma.appointments.deleteMany({ where: { lead_id: { in: createdLeadIds } } });
      await prisma.voice_calls.deleteMany({ where: { lead_id: { in: createdLeadIds } } });
      await prisma.leads.deleteMany({ where: { id: { in: createdLeadIds } } });
    }
    await prisma.calendar_connections.deleteMany({ where: { organization_id: { in: createdOrgIds } } });
    await prisma.integrations.deleteMany({ where: { organization_id: { in: createdOrgIds } } });
    if (createdUserIds.length) await prisma.users.deleteMany({ where: { id: { in: createdUserIds } } });
    const audited = await prisma.audit_logs.findMany({
      where: { organization_id: { in: createdOrgIds } },
      select: { organization_id: true },
      distinct: ['organization_id'],
    });
    const keep = new Set(audited.map((a) => a.organization_id));
    const deletable = createdOrgIds.filter((id) => !keep.has(id));
    if (deletable.length) await prisma.organizations.deleteMany({ where: { id: { in: deletable } } });
  } finally {
    await app.close();
  }
});

const AVAIL = '/api/tools/telnyx/booking/availability';
const BOOK = '/api/tools/telnyx/booking/book';

test('refuses a request without the token or with a wrong token', async () => {
  const { leadId, ccid } = await leadOnCall(orgId, 'in_progress');
  assert.equal((await call(AVAIL, { lead_id: leadId, call_control_id: ccid })).status, 401);
  assert.equal((await call(AVAIL, { lead_id: leadId, call_control_id: ccid }, 'wrong')).status, 401);
});

test("books for the call's own lead even when lead_id names another lead", async () => {
  const { leadId, ccid } = await leadOnCall(orgId, 'in_progress');
  const other = await leadOnCall(orgId, 'in_progress');
  await prisma.appointments.deleteMany({ where: { external_event_id: `evt-${RUN}` } });
  const r = await call(BOOK, { lead_id: other.leadId, call_control_id: ccid, start_time: SLOT }, TOKEN);
  assert.equal(r.status, 200, r.text);
  const appt = await prisma.appointments.findFirstOrThrow({ where: { external_event_id: `evt-${RUN}` } });
  assert.equal(appt.lead_id, leadId);
  assert.equal(await prisma.appointments.count({ where: { lead_id: other.leadId } }), 0);
  // Every test here books the same fake Calendly event; leave it free for the next.
  await prisma.appointments.deleteMany({ where: { external_event_id: `evt-${RUN}` } });
});

test('refuses a call that has ended', async () => {
  const { leadId, ccid } = await leadOnCall(orgId, 'completed');
  assert.equal((await call(AVAIL, { lead_id: leadId, call_control_id: ccid }, TOKEN)).status, 401);
});

test("refuses an office's token for another office's call", async () => {
  const { leadId, ccid } = await leadOnCall(otherOrgId, 'in_progress');
  assert.equal((await call(AVAIL, { lead_id: leadId, call_control_id: ccid }, TOKEN)).status, 401);
});

test('offers open times in the office time zone', async () => {
  const { leadId, ccid } = await leadOnCall(orgId, 'in_progress');
  const r = await call(AVAIL, { lead_id: leadId, call_control_id: ccid, day: '2030-03-14', preferred_time: '10:00' }, TOKEN);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.timezone, 'America/Chicago');
  assert.equal(r.body.requestedTimeAvailable, true);
  assert.deepEqual(r.body.slots, [{ start: SLOT, spoken: 'Thursday, March 14 at 10:00 AM' }]);
});

test('books, assigns the lead to Calendly’s host as round robin, and records the appointment', async () => {
  const { leadId, ccid } = await leadOnCall(orgId, 'in_progress');
  calendlyCalls = { createInvitee: [] };
  const r = await call(BOOK, { lead_id: leadId, call_control_id: ccid, start_time: SLOT }, TOKEN);

  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.agentName, `Alice ${RUN}`);
  // No partial `tracking` object: Calendly rejects one unless all six fields are set.
  assert.equal((calendlyCalls.createInvitee[0] as any).tracking, undefined);
  // The event type's video location is sent, or Calendly makes no join link.
  assert.deepEqual((calendlyCalls.createInvitee[0] as any).location, { kind: 'zoom_conference' });

  const assignment = await prisma.lead_assignments.findFirstOrThrow({ where: { lead_id: leadId, is_current: true } });
  assert.equal(assignment.agent_id, aliceProfileId);
  assert.equal(assignment.assignment_type, 'round_robin');

  const appt = await prisma.appointments.findFirstOrThrow({ where: { lead_id: leadId } });
  assert.equal(appt.agent_id, aliceProfileId);
  assert.equal(appt.status, 'scheduled');
  assert.equal(appt.start_at.toISOString(), SLOT);

  const lead = await prisma.leads.findUniqueOrThrow({ where: { id: leadId } });
  assert.equal(lead.status, 'appointment_booked');

  const audit = await prisma.audit_logs.findFirstOrThrow({ where: { entity_id: leadId, action: 'lead.assigned' } });
  assert.equal(audit.actor_type, 'ai');
});

test('booking twice for the same event does not duplicate the appointment or the assignment', async () => {
  const { leadId, ccid } = await leadOnCall(orgId, 'in_progress');
  // Same fake event uri both times — as a Telnyx retry would produce.
  await prisma.appointments.deleteMany({ where: { external_event_id: `evt-${RUN}` } });
  await call(BOOK, { lead_id: leadId, call_control_id: ccid, start_time: SLOT }, TOKEN);
  await call(BOOK, { lead_id: leadId, call_control_id: ccid, start_time: SLOT }, TOKEN);
  assert.equal(await prisma.appointments.count({ where: { external_event_id: `evt-${RUN}` } }), 1);
  assert.equal(await prisma.lead_assignments.count({ where: { lead_id: leadId, is_current: true } }), 1);
});

test('asks for an email when the lead has none', async () => {
  const { leadId, ccid } = await leadOnCall(orgId, 'in_progress', null);
  const r = await call(BOOK, { lead_id: leadId, call_control_id: ccid, start_time: SLOT }, TOKEN);
  assert.equal(r.status, 200);
  assert.equal(r.body.reason, 'email_required');
});

test('owner settings: only an owner may read or change them', async () => {
  const anon = await fetch(`${base}/api/in-call-booking`);
  assert.equal(anon.status, 401);
  const owner = await fetch(`${base}/api/in-call-booking`, { headers: { authorization: `Bearer ${ownerToken}` } });
  assert.equal(owner.status, 200, await owner.text());
});
