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
import { EventsModule } from '../events/events.module';
import { CalendarModule } from './calendar.module';

/**
 * Integration suite for the calendar surface, against the real database and in
 * the same shape as agent-me.test.ts: emails namespaced per run, every row it
 * creates tracked by id and torn down in after().
 *
 * Run with `npm run test:calendar`.
 *
 * The case this file exists for above all others is
 * "an agent's own calendar route is not shadowed by the owner's". Those two
 * routes — /api/agents/me/calendar and /api/agents/:userId/calendar — match the
 * same URL, and which one answers is decided by registration order in
 * CalendarModule. A reorder would break the agent's screen with a 400 that
 * looks like a client bug, and only an end-to-end request can show it.
 */

// CalendarModule pulls in TelnyxModule, whose lead watcher and follow-up runner
// would otherwise start against the shared database and contact real leads
// while the suite runs, whatever the developer's .env says.
process.env['STRATEGY_ENGINE'] = '0';
process.env['CALENDAR_SYNC'] = '0';
process.env['WORKER_ENABLED'] = 'false';

const RUN = Date.now().toString(36);
const emailFor = (tag: string): string => `calendar-${RUN}-${tag}@example.invalid`;
const PASSWORD = 'correct-horse-battery-staple';

let app: INestApplication;
let prisma: PrismaService;
let base: string;

const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];

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

const asRecord = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;
const errCode = (res: Res): unknown =>
  ((res.body as Record<string, unknown>)['error'] as Record<string, unknown> | undefined)?.['code'];

async function signupOwner(tag: string, org: string) {
  const res = await call('POST', '/api/auth/signup', {
    body: {
      email: emailFor(tag),
      password: PASSWORD,
      firstName: 'Own',
      lastName: 'Er',
      organizationName: org,
    },
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

async function createAgent(ownerToken: string, tag: string) {
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

/** A full valid week, Mon–Fri 09:00–17:00. */
function week(overrides: Record<number, Partial<{ isAvailable: boolean; startTime: string; endTime: string }>> = {}) {
  return Array.from({ length: 7 }, (_, dayOfWeek) => ({
    dayOfWeek,
    isAvailable: dayOfWeek >= 1 && dayOfWeek <= 5,
    startTime: '09:00',
    endTime: '17:00',
    ...(overrides[dayOfWeek] ?? {}),
  }));
}

let ownerA = { token: '', userId: '', orgId: '' };
let ownerB = { token: '', userId: '', orgId: '' };
let alice = { userId: '', token: '' };

before(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      // The server's own env schema, not a bare ConfigModule: settings that
      // exist only as a default there (the Calendly base URLs) would otherwise
      // be missing here, and getOrThrow would fail on a key production always
      // has.
      ConfigModule.forRoot({
        isGlobal: true,
        validate: (raw) => ({ ...raw, ...envSchema.parse(raw) }),
      }),
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

  ownerA = await signupOwner('owner-a', `Calendar Test A ${RUN}`);
  ownerB = await signupOwner('owner-b', `Calendar Test B ${RUN}`);
  alice = await createAgent(ownerA.token, 'alice');
});

after(async () => {
  try {
    // agent_availability and calendar_connections both cascade from
    // agent_profiles, which cascades from users, so removing the users is
    // enough. Appointments are never created by this suite.
    if (createdUserIds.length > 0) {
      await prisma.users.deleteMany({ where: { id: { in: createdUserIds } } });
    }

    // Organizations that accumulated audit rows cannot be deleted — dropping
    // one would NULL audit_logs.organization_id, and the immutability trigger
    // rejects every UPDATE on that table. Creating an agent writes such a row.
    const audited =
      createdOrgIds.length === 0
        ? []
        : await prisma.audit_logs.findMany({
            where: { organization_id: { in: createdOrgIds } },
            select: { organization_id: true },
            distinct: ['organization_id'],
          });
    const auditedOrgIds = new Set(audited.map((r) => r.organization_id));
    const deletable = createdOrgIds.filter((id) => !auditedOrgIds.has(id));
    if (deletable.length > 0) {
      await prisma.organizations.deleteMany({ where: { id: { in: deletable } } });
    }
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

test('unauthenticated requests are rejected on every calendar route', async () => {
  const routes: Array<[string, string]> = [
    ['GET', '/api/agents/me/calendar'],
    ['GET', '/api/agents/me/availability'],
    ['PUT', '/api/agents/me/availability'],
    ['GET', '/api/agents/me/appointments'],
    ['GET', '/api/appointments'],
    ['GET', '/api/organization/calendar'],
    ['POST', '/api/organization/calendar/connect'],
    ['POST', '/api/organization/calendar/sync'],
    ['DELETE', '/api/organization/calendar'],
    ['GET', '/api/organization/calendar/members'],
    ['POST', '/api/organization/calendar/members/sync'],
    ['GET', '/api/organization/calendar/event-types'],
    ['POST', '/api/organization/calendar/cal/teams'],
    ['POST', '/api/organization/calendar/cal/connect'],
  ];

  for (const [method, path] of routes) {
    const res = await call(method, path);
    assert.equal(res.status, 401, `${method} ${path} -> ${res.text}`);
  }
});

// ---------------------------------------------------------------------------
// The route-shadowing case this file exists for
// ---------------------------------------------------------------------------

test("an agent's own calendar route is not shadowed by the owner's :userId route", async () => {
  const res = await call('GET', '/api/agents/me/calendar', { token: alice.token });

  // A 400 here would mean /api/agents/:userId/calendar answered first and
  // ParseUUIDPipe rejected the literal "me".
  assert.equal(res.status, 200, res.text);
  const body = asRecord(res.body);
  assert.equal(body['organizationConnected'], false, 'this office has connected nothing');
  assert.equal(body['schedulingUserId'], null, 'a fresh agent is on nobody\u2019s team');
  assert.equal(body['provider'], null, 'and no provider is connected to name');
  // The agent surface must never carry the office's credential state: there is
  // nothing here an agent could act on, and canConnect would invite them to try.
  assert.ok(!('canConnect' in body), 'the agent DTO must not expose the office connection');
});

test('an owner has no agent profile, so the agent surface refuses them', async () => {
  const res = await call('GET', '/api/agents/me/calendar', { token: ownerA.token });
  assert.equal(res.status, 403, res.text);
  assert.equal(errCode(res), 'FORBIDDEN');
});

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

test('availability starts as an unsaved default week in the agent timezone', async () => {
  const res = await call('GET', '/api/agents/me/availability', { token: alice.token });
  assert.equal(res.status, 200, res.text);

  const body = asRecord(res.body);
  const days = body['days'] as Array<Record<string, unknown>>;
  assert.equal(days.length, 7);
  assert.ok(typeof body['timezone'] === 'string' && (body['timezone'] as string).length > 0);

  // Nothing is persisted until the agent saves.
  const stored = await prisma.agent_availability.count({
    where: { organization_id: ownerA.orgId },
  });
  assert.equal(stored, 0, 'reading availability must not write rows');
});

test('an agent saves their week and reads it back', async () => {
  const res = await call('PUT', '/api/agents/me/availability', {
    token: alice.token,
    body: { days: week({ 6: { isAvailable: true, startTime: '10:00', endTime: '14:00' } }) },
  });
  assert.equal(res.status, 200, res.text);

  const back = await call('GET', '/api/agents/me/availability', { token: alice.token });
  const days = asRecord(back.body)['days'] as Array<Record<string, unknown>>;
  const saturday = days.find((d) => d['dayOfWeek'] === 6);
  assert.equal(saturday?.['isAvailable'], true);
  assert.equal(saturday?.['startTime'], '10:00');
  assert.equal(saturday?.['endTime'], '14:00');

  const rows = await prisma.agent_availability.findMany({
    where: { organization_id: ownerA.orgId },
  });
  assert.equal(rows.length, 7, 'the whole week is stored, one row per day');
});

test('saving twice replaces the week rather than accumulating rows', async () => {
  const res = await call('PUT', '/api/agents/me/availability', {
    token: alice.token,
    body: { days: week() },
  });
  assert.equal(res.status, 200, res.text);

  const rows = await prisma.agent_availability.count({
    where: { organization_id: ownerA.orgId },
  });
  assert.equal(rows, 7);
});

test('an invalid week is a 400 before anything is written', async () => {
  const bad: Array<[string, unknown]> = [
    // end before start — the database has the same CHECK, but the agent should
    // get a field error rather than a 500 carrying Postgres prose.
    ['end before start', week({ 1: { startTime: '17:00', endTime: '09:00' } })],
    ['only six days', week().slice(0, 6)],
    ['duplicate day', [...week().slice(0, 6), { dayOfWeek: 5, isAvailable: true, startTime: '09:00', endTime: '17:00' }]],
    ['bad time format', week({ 2: { startTime: '9am' as unknown as string } })],
  ];

  for (const [label, days] of bad) {
    const res = await call('PUT', '/api/agents/me/availability', {
      token: alice.token,
      body: { days },
    });
    assert.equal(res.status, 400, `${label} -> ${res.text}`);
    assert.equal(errCode(res), 'VALIDATION_ERROR', label);
  }

  // The last good save is untouched.
  const rows = await prisma.agent_availability.count({
    where: { organization_id: ownerA.orgId },
  });
  assert.equal(rows, 7);
});

// ---------------------------------------------------------------------------
// Owner surface
// ---------------------------------------------------------------------------

test('an agent may not read the organization-wide appointment list', async () => {
  const res = await call('GET', '/api/appointments', { token: alice.token });
  assert.equal(res.status, 403, res.text);
  assert.equal(errCode(res), 'FORBIDDEN');
});

test('an owner reads the appointment list, which is empty here', async () => {
  const res = await call('GET', '/api/appointments', { token: ownerA.token });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body, []);
});

test("an owner reads one agent's calendar by user id", async () => {
  const res = await call('GET', `/api/agents/${alice.userId}/calendar`, { token: ownerA.token });
  assert.equal(res.status, 200, res.text);

  const body = asRecord(res.body);
  assert.equal(body['agentId'] !== undefined, true);
  assert.equal(body['schedulingUserId'], null, 'alice is not linked to a scheduling member');
  assert.deepEqual(body['upcoming'], []);

  const availability = asRecord(body['availability']);
  assert.equal((availability['days'] as unknown[]).length, 7);
});

test("an owner cannot read another organization's agent calendar", async () => {
  const res = await call('GET', `/api/agents/${alice.userId}/calendar`, { token: ownerB.token });
  // Indistinguishable from a user that does not exist: a 403 here would confirm
  // that this id is somebody, which is itself a leak of the other roster.
  assert.equal(res.status, 404, res.text);
});

test('an agent may not read a colleague calendar through the owner route', async () => {
  const res = await call('GET', `/api/agents/${alice.userId}/calendar`, { token: alice.token });
  assert.equal(res.status, 403, res.text);
});

// ---------------------------------------------------------------------------
// The office's Calendly connection
// ---------------------------------------------------------------------------

test('an agent may not touch the office Calendly connection', async () => {
  // The whole point of moving Calendly to the organization is that ONE person
  // holds it. Every route below writes or reveals the office's credential
  // state, so every one of them must be owner-only.
  const routes: Array<[string, string]> = [
    ['GET', '/api/organization/calendar'],
    ['POST', '/api/organization/calendar/connect'],
    ['POST', '/api/organization/calendar/sync'],
    ['DELETE', '/api/organization/calendar'],
    ['GET', '/api/organization/calendar/members'],
    ['POST', '/api/organization/calendar/members/sync'],
    ['GET', '/api/organization/calendar/event-types'],
    ['POST', '/api/organization/calendar/cal/teams'],
    ['POST', '/api/organization/calendar/cal/connect'],
  ];

  for (const [method, path] of routes) {
    const res = await call(method, path, { token: alice.token });
    assert.equal(res.status, 403, `${method} ${path} -> ${res.text}`);
    assert.equal(errCode(res), 'FORBIDDEN');
  }
});

test('an owner reads the office calendar status before anything is connected', async () => {
  const res = await call('GET', '/api/organization/calendar', { token: ownerA.token });
  assert.equal(res.status, 200, res.text);

  const body = asRecord(res.body);
  assert.equal(body['connection'], null, 'this office has connected nothing');
  assert.equal(body['provider'], null, 'and so no provider is live');

  // Both providers are always described, connected or not — the screen has to
  // be able to offer the one that is missing.
  const providers = body['providers'] as Array<Record<string, unknown>>;
  assert.equal(providers.length, 2);
  assert.deepEqual(
    providers.map((p) => p['id']).sort(),
    ['cal', 'calendly'],
  );
  // Cal.com needs no server-side registration, so it is offerable on every
  // deployment. That is the whole reason it is the cheaper way to start.
  const cal = providers.find((p) => p['id'] === 'cal')!;
  assert.equal(cal['canConnect'], true);
});

test('connecting says so plainly when the server has no Calendly credentials', async () => {
  const status = await call('GET', '/api/organization/calendar', { token: ownerA.token });
  const providers = asRecord(status.body)['providers'] as Array<Record<string, unknown>>;
  const configured = providers.find((p) => p['id'] === 'calendly')?.['canConnect'] === true;

  const res = await call('POST', '/api/organization/calendar/connect', { token: ownerA.token });

  if (configured) {
    assert.equal(res.status, 201, res.text);
    assert.ok(
      typeof asRecord(res.body)['authorizeUrl'] === 'string',
      'a configured server returns somewhere to send the browser',
    );
  } else {
    // The deployment has no CALENDLY_CLIENT_ID. That must be an explicit,
    // readable refusal rather than a redirect to a broken consent screen.
    assert.equal(res.status, 400, res.text);
    assert.equal(errCode(res), 'VALIDATION_ERROR');
  }
});

test('syncing without a connected calendar is a 400, not a crash', async () => {
  const res = await call('POST', '/api/organization/calendar/sync', { token: ownerA.token });
  assert.equal(res.status, 400, res.text);
  assert.equal(errCode(res), 'VALIDATION_ERROR');
});

test('the Calendly roster and event types refuse politely with nothing connected', async () => {
  for (const [method, path] of [
    ['GET', '/api/organization/calendar/members'],
    ['POST', '/api/organization/calendar/members/sync'],
    ['GET', '/api/organization/calendar/event-types'],
  ] as Array<[string, string]>) {
    const res = await call(method, path, { token: ownerA.token });
    assert.equal(res.status, 400, `${method} ${path} -> ${res.text}`);
    assert.equal(errCode(res), 'VALIDATION_ERROR');
  }
});

test('disconnecting when nothing is connected succeeds quietly', async () => {
  // Idempotent on purpose: the button is visible whenever the UI thinks there
  // is something to remove, and disagreeing with the UI should not be an error.
  const res = await call('DELETE', '/api/organization/calendar', { token: ownerA.token });
  assert.equal(res.status, 204, res.text);
});

test('a malformed Cal.com key is refused before anything reaches Cal.com', async () => {
  for (const body of [{}, { apiKey: '' }, { apiKey: 'not-a-cal-key' }]) {
    const res = await call('POST', '/api/organization/calendar/cal/teams', {
      token: ownerA.token,
      body,
    });
    assert.equal(res.status, 400, `${JSON.stringify(body)} -> ${res.text}`);
    assert.equal(errCode(res), 'VALIDATION_ERROR');
  }
});

test('connecting Cal.com without choosing a team is a 400', async () => {
  const res = await call('POST', '/api/organization/calendar/cal/connect', {
    token: ownerA.token,
    body: { apiKey: 'cal_live_example' },
  });
  assert.equal(res.status, 400, res.text);
  assert.equal(errCode(res), 'VALIDATION_ERROR');
});

test('an agent has no connect, sync or disconnect route of their own any more', async () => {
  // Calendly is the office's. These used to exist; if one comes back, an agent
  // could authorize a second calendar and the same booking would sync twice.
  for (const [method, path] of [
    ['POST', '/api/agents/me/calendar/connect'],
    ['POST', '/api/agents/me/calendar/sync'],
    ['DELETE', '/api/agents/me/calendar'],
  ] as Array<[string, string]>) {
    const res = await call(method, path, { token: alice.token });
    assert.equal(res.status, 404, `${method} ${path} -> ${res.text}`);
  }
});

test('an agent sees their own appointments, and there are none', async () => {
  const res = await call('GET', '/api/agents/me/appointments', { token: alice.token });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body, []);
});

test('there is no route that takes an agent id on the agent surface', async () => {
  // The same guarantee agent-me.test.ts pins: nothing under /agents/me accepts
  // an identifier, so there is nothing to tamper with.
  for (const path of [
    `/api/agents/me/calendar/${alice.userId}`,
    `/api/agents/me/availability/${alice.userId}`,
  ]) {
    const res = await call('GET', path, { token: alice.token });
    assert.equal(res.status, 404, `${path} -> ${res.text}`);
  }
});
