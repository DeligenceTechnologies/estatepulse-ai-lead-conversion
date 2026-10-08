import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import bcrypt from 'bcrypt';
import { AuthModule } from '../../auth/auth.module';
import { envSchema } from '../../app.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { CalendarModule } from './calendar.module';
import { EventsModule } from '../events/events.module';
import { leadBookingUrl } from './lead-booking-link';
import { CalendarProviderRegistry } from './providers/provider.registry';
import type { CalendarProvider, NormalizedEventType } from './providers/types';

/**
 * Integration suite for GET /api/leads/:leadId/booking-options — the assigned
 * agent's own event types as links tied to this lead — against the real
 * database. Run with `npm run test:booking-options`.
 *
 * Only the provider's network call (listEventTypes) is replaced, by a stub that
 * records what it was handed. Everything else — the session, the lead's
 * visibility, the current assignment, the office connection, the registry's
 * provider lookup and the filtering and ordering of event types — is real.
 */

// CalendarModule pulls in TelnyxModule. Nothing here may start the background
// pollers against the shared database, whatever the developer's .env says.
process.env['STRATEGY_ENGINE'] = '0';
process.env['CALENDAR_SYNC'] = '0';
process.env['WORKER_ENABLED'] = 'false';

const RUN = Date.now().toString(36);
const emailFor = (tag: string): string => `booking-${RUN}-${tag}@example.invalid`;
const PASSWORD = 'correct-horse-battery-staple';
const NOT_FOUND = '{"error":{"code":"NOT_FOUND","message":"No such lead"}}';

let app: INestApplication;
let prisma: PrismaService;
let base: string;

const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];
const createdLeadIds: string[] = [];

/** Every listEventTypes call the endpoint made, in order. */
const providerCalls: Array<{ conn: unknown; opts: unknown }> = [];

const HOST_ALICE = `https://api.calendly.com/users/${RUN}-alice`;
const HOST_EMPTY = `https://api.calendly.com/users/${RUN}-nothing-bookable`;
const OTHER_HOST = 'https://api.calendly.com/users/someone-else';

/** What the provider "returns" for a host: one of each kind the endpoint must keep or drop. */
function eventTypesFor(host: string | undefined): NormalizedEventType[] {
  const et = (over: Partial<NormalizedEventType>): NormalizedEventType => ({
    id: 'et',
    name: 'Meeting',
    active: true,
    durationMinutes: 30,
    schedulingUrl: 'https://calendly.com/alice/meeting',
    poolingType: null,
    ownerName: 'Alice',
    ownerType: 'User',
    hostIds: [host ?? ''],
    ...over,
  });
  if (host === HOST_EMPTY) return [et({ id: 'theirs', hostIds: [OTHER_HOST] })];
  return [
    et({ id: 'tour', name: 'Home tour', durationMinutes: 60, schedulingUrl: 'https://calendly.com/alice/tour' }),
    et({ id: 'consult', name: 'Buyer consult', schedulingUrl: 'https://calendly.com/alice/consult?month=2026-11' }),
    et({ id: 'activate', name: 'Activation call', schedulingUrl: 'https://calendly.com/alice/activate' }),
    et({ id: 'off', name: 'Inactive', active: false }),
    et({ id: 'nolink', name: 'No link', schedulingUrl: null }),
    et({ id: 'http', name: 'Plain http', schedulingUrl: 'http://calendly.com/alice/http' }),
    et({ id: 'rr', name: 'Round robin', poolingType: 'round_robin', ownerType: 'Team', hostIds: [] }),
    et({ id: 'shared', name: 'Shared', hostIds: [host ?? '', OTHER_HOST] }),
    et({ id: 'other', name: 'Someone else', hostIds: [OTHER_HOST] }),
  ];
}

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

const optionsFor = (leadId: string, token?: string) => call(`/api/leads/${leadId}/booking-options`, token);

async function signupOwner(tag: string) {
  const res = await call('/api/auth/signup', undefined, {
    method: 'POST',
    body: { email: emailFor(tag), password: PASSWORD, firstName: 'Own', lastName: 'Er', organizationName: `Booking ${tag} ${RUN}` },
  });
  assert.equal(res.status, 201, res.text);
  const body = JSON.parse(res.text);
  createdUserIds.push(body.user.id);
  createdOrgIds.push(body.organization.id);
  return { token: body.token as string, orgId: body.organization.id as string };
}

/** An agent member of `orgId`, signed in; with a profile unless `profile` is false. */
async function agent(orgId: string, tag: string, opts: { profile?: boolean; host?: string | null } = {}) {
  const user = await prisma.users.create({
    data: { email: emailFor(tag), first_name: 'Agent', last_name: tag, password_hash: await bcrypt.hash(PASSWORD, 4) },
    select: { id: true },
  });
  createdUserIds.push(user.id);
  await prisma.organization_members.create({ data: { organization_id: orgId, user_id: user.id, role: 'agent', status: 'active' } });
  const profile =
    opts.profile === false
      ? null
      : await prisma.agent_profiles.create({
          data: { organization_id: orgId, user_id: user.id, display_name: `Agent ${tag}`, calendly_user_uri: opts.host ?? null },
          select: { id: true, display_name: true },
        });
  const login = await call('/api/auth/login', undefined, { method: 'POST', body: { email: emailFor(tag), password: PASSWORD } });
  assert.equal(login.status, 200, login.text);
  return { token: JSON.parse(login.text).token as string, profileId: profile?.id ?? '', name: profile?.display_name ?? '' };
}

async function lead(orgId: string, data: { first_name?: string; last_name?: string; email?: string } = {}) {
  const row = await prisma.leads.create({ data: { organization_id: orgId, status: 'new', ...data }, select: { id: true } });
  createdLeadIds.push(row.id);
  return row.id;
}

const assign = (orgId: string, leadId: string, agentId: string, isCurrent: boolean, assignedAt: string) =>
  prisma.lead_assignments.create({
    data: { organization_id: orgId, lead_id: leadId, agent_id: agentId, assignment_type: 'manual', is_current: isCurrent, assigned_at: new Date(assignedAt) },
  });

/**
 * An office calendar connection. The metadata deliberately carries no
 * organization URI: should a sync process elsewhere on this shared database
 * pick the row up, the real provider refuses it before making any request.
 */
const officeCalendar = (orgId: string, provider: string, status: string, credentials: string | null) =>
  prisma.calendar_connections.create({
    data: { organization_id: orgId, provider, status, credentials_secret_ref: credentials, metadata: {} },
  });

let owner = { token: '', orgId: '' };
let alice = { token: '', profileId: '', name: '' };
let bob = { token: '', profileId: '', name: '' };
const leads = { alices: '', bobs: '', unassigned: '', wasAlices: '', nothingBookable: '' };
let dan = { token: '', profileId: '', name: '' };
const otherOrgs: Record<'none' | 'errored' | 'noCredentials' | 'google', { token: string; lead: string; agentId: string; agentName: string }> = {} as never;
/** leads.alices' answer, exactly as it must be sent. */
let alicesBody = '';

before(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, validate: (raw) => ({ ...raw, ...envSchema.parse(raw) }) }),
      PrismaModule,
      AuthModule,
      EventsModule,
      CalendarModule,
    ],
  }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  prisma = app.get(PrismaService);

  // The real registry — so an unsupported provider is still refused — with
  // only the network call replaced.
  const registry = app.get(CalendarProviderRegistry);
  const realGet = registry.get.bind(registry);
  registry.get = (id: string): CalendarProvider => {
    const real = realGet(id);
    const stub = Object.create(real) as CalendarProvider;
    stub.listEventTypes = async (conn, opts) => {
      providerCalls.push({ conn, opts });
      return eventTypesFor(opts?.memberHostIds?.[0]);
    };
    return stub;
  };

  owner = await signupOwner('owner');
  alice = await agent(owner.orgId, 'alice', { host: HOST_ALICE });
  bob = await agent(owner.orgId, 'bob');
  dan = await agent(owner.orgId, 'dan', { host: HOST_EMPTY });
  // An older inactive office row beside the live one: the live one is used.
  await officeCalendar(owner.orgId, 'calendly', 'inactive', 'old-reference');
  await officeCalendar(owner.orgId, 'calendly', 'active', 'live-reference');

  leads.alices = await lead(owner.orgId, { first_name: 'Bea', last_name: 'Buyer', email: 'bea@example.invalid' });
  await assign(owner.orgId, leads.alices, bob.profileId, false, '2026-01-01T00:00:00Z');
  await assign(owner.orgId, leads.alices, alice.profileId, true, '2026-02-01T00:00:00Z');
  leads.bobs = await lead(owner.orgId, { first_name: 'Bobs' });
  await assign(owner.orgId, leads.bobs, bob.profileId, true, '2026-02-01T00:00:00Z');
  leads.unassigned = await lead(owner.orgId, { first_name: 'Nobody' });
  leads.wasAlices = await lead(owner.orgId, { first_name: 'Was' });
  await assign(owner.orgId, leads.wasAlices, alice.profileId, false, '2026-01-01T00:00:00Z');
  await assign(owner.orgId, leads.wasAlices, bob.profileId, true, '2026-02-01T00:00:00Z');
  leads.nothingBookable = await lead(owner.orgId, { first_name: 'Dans' });
  await assign(owner.orgId, leads.nothingBookable, dan.profileId, true, '2026-02-01T00:00:00Z');

  for (const [key, calendar] of [
    ['none', null],
    ['errored', ['calendly', 'error', 'a-reference']],
    ['noCredentials', ['calendly', 'active', null]],
    ['google', ['google_calendar', 'active', 'a-reference']],
  ] as const) {
    const other = await signupOwner(`org-${key}`);
    if (calendar) await officeCalendar(other.orgId, calendar[0], calendar[1], calendar[2]);
    const theirAgent = await agent(other.orgId, `agent-${key}`, { host: `https://api.calendly.com/users/${RUN}-${key}` });
    const theirLead = await lead(other.orgId, { first_name: key });
    await assign(other.orgId, theirLead, theirAgent.profileId, true, '2026-02-01T00:00:00Z');
    otherOrgs[key] = { token: other.token, lead: theirLead, agentId: theirAgent.profileId, agentName: theirAgent.name };
  }

  const link = (url: string) =>
    leadBookingUrl('calendly', url, { id: leads.alices, name: 'Bea Buyer', email: 'bea@example.invalid' });
  // Thirty minutes before sixty, then by name; everything that is not alice's
  // own, active, https page is left out.
  alicesBody = JSON.stringify({
    agent: { id: alice.profileId, name: alice.name },
    provider: 'calendly',
    eventTypes: [
      { id: 'activate', name: 'Activation call', durationMinutes: 30, bookingUrl: link('https://calendly.com/alice/activate') },
      { id: 'consult', name: 'Buyer consult', durationMinutes: 30, bookingUrl: link('https://calendly.com/alice/consult?month=2026-11') },
      { id: 'tour', name: 'Home tour', durationMinutes: 60, bookingUrl: link('https://calendly.com/alice/tour') },
    ],
    blocker: null,
  });
});

after(async () => {
  try {
    // Leads first: assignments cascade from them, and they RESTRICT the
    // agent-profile cascade that deleting the users sets off.
    await prisma.leads.deleteMany({ where: { id: { in: createdLeadIds } } });
    await prisma.calendar_connections.deleteMany({ where: { organization_id: { in: createdOrgIds } } });
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

/** The request, plus whatever the provider was asked along the way. */
async function optionsWithProviderCalls(leadId: string, token?: string) {
  providerCalls.length = 0;
  const res = await optionsFor(leadId, token);
  return { ...res, providerCalls: [...providerCalls] };
}

test("owner: the current agent's own bookable pages, as links tied to this lead, exactly as sent", async () => {
  const res = await optionsWithProviderCalls(leads.alices, owner.token);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.text, alicesBody);

  // The provider is handed the live office row, unchanged, and asked about this agent.
  const live = await prisma.calendar_connections.findFirstOrThrow({
    where: { organization_id: owner.orgId, agent_id: null, status: 'active' },
  });
  assert.equal(res.providerCalls.length, 1);
  assert.deepEqual(res.providerCalls[0], { conn: live, opts: { memberHostIds: [HOST_ALICE] } });
});

test('agent: a lead currently assigned to them answers exactly as it does for the owner', async () => {
  const res = await optionsWithProviderCalls(leads.alices, alice.token);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.text, alicesBody);
  assert.equal(res.providerCalls.length, 1);
});

test('an unassigned lead has no agent, and the provider is not asked', async () => {
  const res = await optionsWithProviderCalls(leads.unassigned, owner.token);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.text, '{"agent":null,"provider":null,"eventTypes":[],"blocker":"no_agent"}');
  assert.equal(res.providerCalls.length, 0);
});

test('a lead that was once theirs is hidden from the agent; the owner sees who holds it now', async () => {
  const asAlice = await optionsWithProviderCalls(leads.wasAlices, alice.token);
  assert.equal(asAlice.status, 404, asAlice.text);
  assert.equal(asAlice.text, NOT_FOUND);
  assert.equal(asAlice.providerCalls.length, 0);

  // Bob holds it now, and Bob has no scheduling link.
  const asOwner = await optionsWithProviderCalls(leads.wasAlices, owner.token);
  assert.equal(asOwner.status, 200, asOwner.text);
  assert.equal(
    asOwner.text,
    JSON.stringify({ agent: { id: bob.profileId, name: bob.name }, provider: 'calendly', eventTypes: [], blocker: 'agent_not_linked' }),
  );
  assert.equal(asOwner.providerCalls.length, 0);
});

test("an agent cannot see a colleague's lead or an unassigned one", async () => {
  for (const leadId of [leads.bobs, leads.unassigned]) {
    const res = await optionsFor(leadId, alice.token);
    assert.equal(res.status, 404, res.text);
    assert.equal(res.text, NOT_FOUND);
  }
});

test("another organization's lead is the same 404 as one that does not exist, or a malformed id", async () => {
  for (const [leadId, token] of [
    [otherOrgs.none.lead, owner.token],
    [otherOrgs.none.lead, alice.token],
    [leads.alices, otherOrgs.none.token],
    ['00000000-0000-4000-8000-000000000000', owner.token],
    ['not-a-uuid', owner.token],
  ] as const) {
    const res = await optionsWithProviderCalls(leadId, token);
    assert.equal(res.status, 404, `${leadId}: ${res.text}`);
    assert.equal(res.text, NOT_FOUND);
    assert.equal(res.providerCalls.length, 0);
  }
});

test('no session, or a garbage one, is a 401', async () => {
  const none = await optionsFor(leads.alices);
  assert.equal(none.status, 401, none.text);
  const garbage = await optionsFor(leads.alices, 'not-a-token');
  assert.equal(garbage.status, 401, garbage.text);
});

test('each reason a lead cannot be booked yet: unlinked agent, no usable calendar, nothing bookable', async () => {
  const expect = async (leadId: string, token: string, body: unknown, providerCalled: boolean) => {
    const res = await optionsWithProviderCalls(leadId, token);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.text, JSON.stringify(body));
    assert.equal(res.providerCalls.length, providerCalled ? 1 : 0, res.text);
  };
  const agentOf = (o: { agentId: string; agentName: string }) => ({ id: o.agentId, name: o.agentName });

  await expect(leads.bobs, bob.token, { agent: { id: bob.profileId, name: bob.name }, provider: 'calendly', eventTypes: [], blocker: 'agent_not_linked' }, false);
  for (const key of ['none', 'errored', 'noCredentials'] as const) {
    await expect(otherOrgs[key].lead, otherOrgs[key].token, { agent: agentOf(otherOrgs[key]), provider: null, eventTypes: [], blocker: 'no_calendar' }, false);
  }
  await expect(leads.nothingBookable, owner.token, { agent: { id: dan.profileId, name: dan.name }, provider: 'calendly', eventTypes: [], blocker: 'no_event_types' }, true);
});

test('an office calendar on a provider this deployment does not support is refused', async () => {
  const res = await optionsWithProviderCalls(otherOrgs.google.lead, otherOrgs.google.token);
  assert.equal(res.status, 400, res.text);
  assert.equal(res.text, '{"error":{"code":"VALIDATION_ERROR","message":"Unsupported calendar provider \\"google_calendar\\""}}');
  assert.equal(res.providerCalls.length, 0);
});

test('an agent session with no profile is refused, as it always has been', async () => {
  // A member with no agent_profiles row has no current assignments to see by.
  // The answer is the generic error envelope; nothing leaks about the lead.
  const noProfile = await agent(owner.orgId, 'no-profile', { profile: false });
  const res = await optionsWithProviderCalls(leads.alices, noProfile.token);
  assert.equal(res.status, 500, res.text);
  assert.equal(res.text, '{"error":{"code":"INTERNAL","message":"Internal server error"}}');
  assert.equal(res.providerCalls.length, 0);
});
