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
import { LeadSourcesModule } from './lead-sources.module';

/**
 * Integration suite for GET /api/v1/lead-sources/:id/deliveries — a source's
 * recent webhook deliveries, parsed — and GET /api/v1/lead-sources — the
 * organization's sources with their counts — against the real database. Run
 * with `npm run test:lead-source-deliveries`.
 *
 * The read is scoped by the caller's organization AND the source id, so a
 * source that is not theirs — another tenant's, or one that does not exist —
 * reads as a source with no deliveries: an empty list, never another tenant's
 * rows.
 */

const RUN = Date.now().toString(36);
const emailFor = (tag: string): string => `deliveries-${RUN}-${tag}@example.invalid`;
const PASSWORD = 'correct-horse-battery-staple';

let app: INestApplication;
let prisma: PrismaService;
let base: string;

const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];
const createdSourceIds: string[] = [];

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

const deliveriesOf = (sourceId: string, token?: string, query = '') =>
  call(`/api/v1/lead-sources/${sourceId}/deliveries${query}`, token);

async function signupOwner(tag: string) {
  const res = await call('/api/auth/signup', undefined, {
    method: 'POST',
    body: { email: emailFor(tag), password: PASSWORD, firstName: 'Own', lastName: 'Er', organizationName: `Deliveries ${tag} ${RUN}` },
  });
  assert.equal(res.status, 201, res.text);
  const body = JSON.parse(res.text);
  createdUserIds.push(body.user.id);
  createdOrgIds.push(body.organization.id);
  return { token: body.token as string, orgId: body.organization.id as string };
}

async function createSource(token: string, name: string): Promise<string> {
  const res = await call('/api/v1/lead-sources', token, { method: 'POST', body: { name } });
  assert.equal(res.status, 201, res.text);
  const id = JSON.parse(res.text).id as string;
  createdSourceIds.push(id);
  return id;
}

/** A Tally FORM_RESPONSE with a text, an email and a single-choice answer. */
const tallyPayload = (n: number) => ({
  eventId: `evt_${RUN}_${n}`,
  eventType: 'FORM_RESPONSE',
  createdAt: '2026-09-15T10:00:00.000Z',
  data: {
    responseId: `resp_${n}`,
    submissionId: `sub_${n}`,
    respondentId: 'rsp_1',
    formId: 'form_1',
    formName: 'Buyer Inquiry',
    createdAt: '2026-09-15T09:59:58.000Z',
    fields: [
      { key: 'question_1', label: 'Your name', type: 'INPUT_TEXT', value: 'Brandon Hayes' },
      { key: 'question_2', label: 'Email address', type: 'INPUT_EMAIL', value: 'b.hayes@example.com' },
      {
        key: 'question_3',
        label: 'When are you looking to move?',
        type: 'MULTIPLE_CHOICE',
        value: ['opt_a'],
        options: [
          { id: 'opt_a', text: 'ASAP / under 30 days' },
          { id: 'opt_b', text: '1-3 months' },
        ],
      },
    ],
  },
});

const delivery = (orgId: string, sourceId: string, receivedAt: string, extra: Record<string, unknown> = {}) =>
  prisma.webhook_events.create({
    data: {
      organization_id: orgId,
      lead_source_id: sourceId,
      provider: 'tally',
      event_type: 'FORM_RESPONSE',
      payload: tallyPayload(Date.parse(receivedAt)),
      received_at: new Date(receivedAt),
      ...extra,
    },
  });

let ownerA = { token: '', orgId: '' };
let ownerB = { token: '', orgId: '' };
let sourceFull = '';
let sourceEmpty = '';
let sourceOtherOrg = '';
/** sourceFull's response, exactly as it must be sent. */
let fullBody = '';

before(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, validate: (raw) => ({ ...raw, ...envSchema.parse(raw) }) }),
      PrismaModule,
      AuthModule,
      LeadSourcesModule,
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
  sourceFull = await createSource(ownerA.token, 'Full');
  sourceEmpty = await createSource(ownerA.token, 'Empty');
  sourceOtherOrg = await createSource(ownerB.token, 'Other');

  // Inserted oldest first, so the order in the response is the query's doing.
  // Every column the response never shows is filled in too.
  const pending = await delivery(ownerA.orgId, sourceFull, '2026-10-01T09:00:00.000Z', {
    queue_state: 'PENDING',
    signature_state: 'MISSING',
    content_length: 512,
    raw_body: '{"raw":"bytes"}',
    headers: { 'content-type': 'application/json' },
  });
  const processed = await delivery(ownerA.orgId, sourceFull, '2026-10-01T10:00:00.000Z', {
    external_event_id: `evt-${RUN}`,
    queue_state: 'DONE',
    outcome: 'PROCESSED_WITH_WARNINGS',
    outcome_reason: 'phone normalized',
    error_message: null,
    signature_state: 'VALID',
    used_previous_secret: true,
    content_length: 1024,
    raw_body: '{"raw":"bytes"}',
    warnings: ['w1'],
    mapping_trace: [
      { sourceFieldKey: 'question_1', targetField: 'first_name', outcome: 'mapped' },
      { sourceFieldKey: 'question_1', targetField: 'last_name', outcome: 'mapped' },
      { sourceFieldKey: 'question_2', targetField: 'email', outcome: 'mapped', warning: 'Lower-cased' },
      { sourceFieldKey: 'question_3', targetField: null, outcome: 'unmapped' },
      { sourceFieldKey: 'question_9', targetField: 'max_budget', outcome: 'transform_error', warning: 'Not a number' },
    ],
  });

  const answers = (trace: boolean) => [
    {
      label: 'Your name',
      type: 'INPUT_TEXT',
      value: 'Brandon Hayes',
      targetFields: trace ? ['first_name', 'last_name'] : [],
      mappingOutcome: trace ? 'mapped' : null,
      warnings: [],
    },
    {
      label: 'Email address',
      type: 'INPUT_EMAIL',
      value: 'b.hayes@example.com',
      targetFields: trace ? ['email'] : [],
      mappingOutcome: trace ? 'mapped' : null,
      warnings: trace ? ['Lower-cased'] : [],
    },
    {
      label: 'When are you looking to move?',
      type: 'MULTIPLE_CHOICE',
      value: 'ASAP / under 30 days',
      targetFields: [],
      mappingOutcome: trace ? 'unmapped' : null,
      warnings: [],
    },
  ];
  fullBody = JSON.stringify([
    {
      id: processed.id,
      receivedAt: '2026-10-01T10:00:00.000Z',
      providerEventId: `evt-${RUN}`,
      signatureState: 'VALID',
      usedPreviousSecret: true,
      queueState: 'DONE',
      outcome: 'PROCESSED_WITH_WARNINGS',
      outcomeReason: 'phone normalized',
      errorMessage: null,
      bodyBytes: 1024,
      formName: 'Buyer Inquiry',
      answers: answers(true),
      parseError: null,
      mapping: { mapped: 3, unmapped: 1, errored: 1, warnings: 2 },
    },
    {
      id: pending.id,
      receivedAt: '2026-10-01T09:00:00.000Z',
      providerEventId: null,
      signatureState: 'MISSING',
      usedPreviousSecret: false,
      queueState: 'PENDING',
      outcome: null,
      outcomeReason: null,
      errorMessage: null,
      bodyBytes: 512,
      formName: 'Buyer Inquiry',
      answers: answers(false),
      parseError: null,
      mapping: null,
    },
  ]);

  await delivery(ownerB.orgId, sourceOtherOrg, '2026-10-01T11:00:00.000Z');
});

after(async () => {
  try {
    // Leads and deliveries before their sources, sources before the users and orgs.
    await prisma.leads.deleteMany({ where: { organization_id: { in: createdOrgIds } } });
    await prisma.webhook_events.deleteMany({ where: { lead_source_id: { in: createdSourceIds } } });
    await prisma.lead_sources.deleteMany({ where: { id: { in: createdSourceIds } } });
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

test('a source with deliveries: newest first, parsed and joined to the mapping trace, exactly as sent', async () => {
  const res = await deliveriesOf(sourceFull, ownerA.token);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.text, fullBody);
});

test('a source with no deliveries is an empty list', async () => {
  const res = await deliveriesOf(sourceEmpty, ownerA.token);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.text, '[]');
});

test("another organization's source reads as empty, in both directions, while each still sees its own", async () => {
  for (const [sourceId, token] of [
    [sourceOtherOrg, ownerA.token],
    [sourceFull, ownerB.token],
  ] as const) {
    const res = await deliveriesOf(sourceId, token);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.text, '[]');
  }

  const own = await deliveriesOf(sourceOtherOrg, ownerB.token);
  assert.equal(own.status, 200, own.text);
  assert.equal(JSON.parse(own.text).length, 1);
});

test('an unknown source is an empty list, and a malformed id a 400', async () => {
  const unknown = await deliveriesOf('00000000-0000-4000-8000-000000000000', ownerA.token);
  assert.equal(unknown.status, 200, unknown.text);
  assert.equal(unknown.text, '[]');

  const malformed = await deliveriesOf('not-a-uuid', ownerA.token);
  assert.equal(malformed.status, 400, malformed.text);
  assert.equal(malformed.text, '{"error":{"code":"VALIDATION_ERROR","message":"Validation failed (uuid is expected)"}}');
});

test('no credential, or a garbage one, is a 401', async () => {
  const none = await deliveriesOf(sourceFull);
  assert.equal(none.status, 401, none.text);
  const garbage = await deliveriesOf(sourceFull, 'not-a-token');
  assert.equal(garbage.status, 401, garbage.text);
});

test('25 by default, ?limit= narrows it, and nothing past 100', async () => {
  const sourceId = await createSource(ownerA.token, 'Busy');
  const start = Date.parse('2026-10-02T00:00:00.000Z');
  // Shuffled insert order, distinct receipt times.
  await prisma.webhook_events.createMany({
    data: Array.from({ length: 103 }, (_, i) => (i * 29) % 103).map((m) => ({
      organization_id: ownerA.orgId,
      lead_source_id: sourceId,
      provider: 'tally',
      event_type: 'FORM_RESPONSE',
      payload: tallyPayload(m),
      received_at: new Date(start + m * 60e3),
    })),
  });
  const newest = (n: number) => Array.from({ length: n }, (_, i) => new Date(start + (102 - i) * 60e3).toISOString());
  const receivedAt = (text: string) => (JSON.parse(text) as Array<{ receivedAt: string }>).map((d) => d.receivedAt);

  for (const [query, expected] of [
    ['', newest(25)],
    ['?limit=5', newest(5)],
    ['?limit=100', newest(100)],
    ['?limit=500', newest(100)],
  ] as const) {
    const res = await deliveriesOf(sourceId, ownerA.token, query);
    assert.equal(res.status, 200, `${query}: ${res.text.slice(0, 200)}`);
    assert.deepEqual(receivedAt(res.text), expected, query);
  }
});

test('a payload that is not a Tally webhook is listed with its parse error, not dropped', async () => {
  const sourceId = await createSource(ownerA.token, 'Odd');
  await delivery(ownerA.orgId, sourceId, '2026-10-03T00:00:00.000Z', { payload: { not: 'tally' } });

  const res = await deliveriesOf(sourceId, ownerA.token);
  assert.equal(res.status, 200, res.text);
  const [row] = JSON.parse(res.text) as Array<{ answers: unknown[]; parseError: string | null; formName: unknown; mapping: unknown }>;
  assert.deepEqual(row!.answers, []);
  assert.match(row!.parseError ?? '', /^Not a recognisable Tally webhook payload: /);
  assert.equal(row!.formName, null);
  assert.equal(row!.mapping, null);
});

// --- the list: GET /api/v1/lead-sources ------------------------------------------

/** An agent member of `orgId`, signed in. */
async function signedInAgent(orgId: string, tag: string): Promise<string> {
  const user = await prisma.users.create({
    data: { email: emailFor(tag), first_name: 'Agent', last_name: tag, password_hash: await bcrypt.hash(PASSWORD, 4) },
    select: { id: true },
  });
  createdUserIds.push(user.id);
  await prisma.organization_members.create({ data: { organization_id: orgId, user_id: user.id, role: 'agent', status: 'active' } });
  const res = await call('/api/auth/login', undefined, { method: 'POST', body: { email: emailFor(tag), password: PASSWORD } });
  assert.equal(res.status, 200, res.text);
  return JSON.parse(res.text).token as string;
}

test('the list: live webhook sources, newest first, each as its own page shows it plus its delivery and lead counts', async () => {
  // Leads from one source, and some from none; an archived source and a
  // non-webhook source, neither of which is listed.
  await prisma.leads.createMany({
    data: [
      ...Array.from({ length: 3 }, (_, i) => ({ organization_id: ownerA.orgId, lead_source_id: sourceFull, status: 'new', first_name: `Full${i}` })),
      { organization_id: ownerA.orgId, status: 'new', first_name: 'Sourceless' },
    ],
  });
  const archived = await createSource(ownerA.token, 'Disconnected');
  await prisma.webhook_events.create({ data: { organization_id: ownerA.orgId, lead_source_id: archived, provider: 'tally', event_type: 'FORM_RESPONSE', payload: tallyPayload(1) } });
  await prisma.lead_sources.update({ where: { id: archived }, data: { archived_at: new Date(), is_active: false } });
  const manual = await prisma.lead_sources.create({
    data: { organization_id: ownerA.orgId, name: 'Manual entry', code: `manual-${RUN}`, source_type: 'manual' },
    select: { id: true },
  });
  createdSourceIds.push(manual.id);

  // What the list must hold, worked out independently: every live webhook
  // source of the organization, newest first, each exactly as GET /:id shows
  // it, with counts read straight from the tables.
  const live = await prisma.lead_sources.findMany({
    where: { organization_id: ownerA.orgId, source_type: 'webhook', archived_at: null },
    orderBy: { created_at: 'desc' },
    select: { id: true },
  });
  assert.ok(live.length >= 3 && !live.some((s) => s.id === archived || s.id === manual.id));
  const expected: unknown[] = [];
  for (const { id } of live) {
    const page = await call(`/api/v1/lead-sources/${id}`, ownerA.token);
    assert.equal(page.status, 200, page.text);
    expected.push({
      ...JSON.parse(page.text),
      deliveryCount: await prisma.webhook_events.count({ where: { organization_id: ownerA.orgId, lead_source_id: id } }),
      leadCount: await prisma.leads.count({ where: { organization_id: ownerA.orgId, lead_source_id: id } }),
    });
  }

  const res = await call('/api/v1/lead-sources', ownerA.token);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.text, JSON.stringify(expected));
  const full = (JSON.parse(res.text) as Array<{ id: string; deliveryCount: number; leadCount: number }>).find((s) => s.id === sourceFull);
  assert.deepEqual([full?.deliveryCount, full?.leadCount], [2, 3]);
  // Never a secret.
  assert.ok(!/signing_secret|secret_enc|ingest_token_enc/.test(res.text));
});

test('the list: an agent of the organization reads the same list', async () => {
  const agentToken = await signedInAgent(ownerA.orgId, 'list-agent');
  const [asOwner, asAgent] = await Promise.all([call('/api/v1/lead-sources', ownerA.token), call('/api/v1/lead-sources', agentToken)]);
  assert.equal(asAgent.status, 200, asAgent.text);
  assert.equal(asAgent.text, asOwner.text);
});

test("the list: each organization sees only its own sources; one with none gets an empty list", async () => {
  const b = await call('/api/v1/lead-sources', ownerB.token);
  assert.equal(b.status, 200, b.text);
  assert.deepEqual(
    (JSON.parse(b.text) as Array<{ id: string; deliveryCount: number; leadCount: number }>).map((s) => [s.id, s.deliveryCount, s.leadCount]),
    [[sourceOtherOrg, 1, 0]],
  );
  const empty = await signupOwner('list-empty');
  const none = await call('/api/v1/lead-sources', empty.token);
  assert.equal(none.status, 200, none.text);
  assert.equal(none.text, '[]');
});

test('the list: no credential, or a garbage one, is a 401', async () => {
  assert.equal((await call('/api/v1/lead-sources')).status, 401);
  assert.equal((await call('/api/v1/lead-sources', 'not-a-token')).status, 401);
});
