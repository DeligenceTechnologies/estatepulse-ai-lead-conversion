import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AuthModule } from '../../auth/auth.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { EventsModule } from '../events/events.module';
import { LeadsModule } from './leads.module';

/**
 * Integration suite for GET /api/v1/leads against the real database. Run with
 * `npm run test:leads-list`.
 *
 * Pins the response contract — fields, nulls, filters, ordering, `limit`, the
 * current agent, the source badge and the repeat-contact count — and that
 * another organization's leads are never listed or counted.
 */

process.env['STRATEGY_ENGINE'] = '0';
process.env['CALENDAR_SYNC'] = '0';
process.env['WORKER_ENABLED'] = 'false';

const RUN = Date.now().toString(36);
const emailFor = (tag: string): string => `leads-list-${RUN}-${tag}@example.invalid`;
const PASSWORD = 'correct-horse-battery-staple';

const KEYS = [
  'id', 'firstName', 'lastName', 'email', 'phone', 'phoneValid', 'emailValid', 'needsReview', 'reviewReasons',
  'status', 'statusReason', 'temperature', 'score', 'location', 'timeline', 'buyingIntent', 'financingStatus',
  'minBudget', 'maxBudget', 'bedrooms', 'motivation', 'consentStatus', 'dncStatus', 'customFields',
  'submissionCount', 'contactLeadCount', 'source', 'assignedAgent', 'createdAt', 'updatedAt',
];

let app: INestApplication;
let prisma: PrismaService;
let base: string;

const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];

type Lead = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function list(qs: string, token: string): Promise<{ status: number; body: Lead[]; text: string }> {
  const res = await fetch(`${base}/api/v1/leads${qs}`, { headers: { authorization: `Bearer ${token}` } });
  const text = await res.text();
  let body: Lead[] = [];
  try {
    body = JSON.parse(text);
  } catch {
    // raw text is still in the assertion message
  }
  return { status: res.status, body, text };
}

async function signupOwner(tag: string) {
  const res = await fetch(`${base}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: emailFor(tag), password: PASSWORD, firstName: 'Own', lastName: tag,
      organizationName: `LeadsList ${tag} ${RUN}`, teamSize: 'solo',
    }),
  });
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  createdUserIds.push(body.user.id);
  createdOrgIds.push(body.organization.id);
  return { token: body.token as string, orgId: body.organization.id as string, profileId: body.agentProfileId as string };
}

let A = { token: '', orgId: '', profileId: '' };
let B = { token: '', orgId: '', profileId: '' };
let sourceId = '';
const id: Record<string, string> = {};
const t0 = Date.now() - 3600e3;

/** Created oldest first, one minute apart, so newest-first order is known. */
async function lead(name: string, minute: number, data: Record<string, unknown> = {}, orgId = A.orgId) {
  const row = await prisma.leads.create({
    data: { organization_id: orgId, first_name: name, created_at: new Date(t0 + minute * 60e3), ...data },
    select: { id: true },
  });
  id[name] = row.id;
}

before(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, AuthModule, EventsModule, LeadsModule],
  }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  prisma = app.get(PrismaService);

  A = await signupOwner('a');
  B = await signupOwner('b');

  const source = await prisma.lead_sources.create({
    data: { organization_id: A.orgId, name: 'Buyer Inquiry', code: `leads-list-${RUN}`, source_type: 'webhook', provider: 'tally', connection_method: 'API' },
  });
  sourceId = source.id;

  const PHONE = '+15125550199';
  const EMAIL = `shared-${RUN}@example.invalid`;
  await lead('bare', 0);
  await lead('phone1', 1, { normalized_phone: PHONE, phone: PHONE, lead_source_id: sourceId });
  await lead('phone2', 2, { normalized_phone: PHONE, phone: PHONE });
  await lead('phone3', 3, { normalized_phone: PHONE, phone: PHONE, normalized_email: EMAIL });
  await lead('email1', 4, { normalized_email: EMAIL, email: EMAIL, status: 'booked' });
  await lead('emptyPhone', 5, { normalized_phone: '', normalized_email: EMAIL, status: 'appointment_booked' });
  await lead('rich', 6, {
    lead_source_id: sourceId, status: 'qualified', temperature: 'hot', score: '42.50', min_budget: '250000.00',
    max_budget: '400000.50', bedrooms: 3, custom_fields: { k: 1 }, review_reasons: ['phone_invalid'],
    needs_review: true, submission_count: 3, ai_summary: 'why',
  });
  // Org B shares A's phone and email: never listed for A, never counted for A.
  await lead('otherOrg', 7, { normalized_phone: PHONE, normalized_email: EMAIL }, B.orgId);

  // 'rich' has a retired assignment and a current one; only the current shows.
  await prisma.lead_assignments.create({
    data: { organization_id: A.orgId, lead_id: id['rich']!, agent_id: A.profileId, assignment_type: 'round_robin', is_current: false, assigned_at: new Date(t0), unassigned_at: new Date(t0 + 1000) },
  });
  await prisma.lead_assignments.create({
    data: { organization_id: A.orgId, lead_id: id['rich']!, agent_id: A.profileId, assignment_type: 'manual', assigned_at: new Date(t0 + 2000) },
  });
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

const names = (rows: Lead[]): string[] => rows.map((l) => l['firstName'] as string);
const byName = (rows: Lead[], name: string): Lead => rows.find((l) => l['firstName'] === name)!;

test('lists only the caller\'s organization, newest first', async () => {
  const res = await list('', A.token);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(names(res.body), ['rich', 'emptyPhone', 'email1', 'phone3', 'phone2', 'phone1', 'bare']);

  const other = await list('', B.token);
  assert.deepEqual(names(other.body), ['otherOrg']);
});

test('response shape: exact keys, nullable relations serialize as null', async () => {
  const { body } = await list('', A.token);
  for (const l of body) assert.deepEqual(Object.keys(l), KEYS);

  const bare = byName(body, 'bare');
  assert.equal(bare['source'], null);
  assert.equal(bare['assignedAgent'], null);
  assert.equal(bare['score'], 0);
  assert.equal(bare['minBudget'], null);
  assert.equal(bare['contactLeadCount'], 1);
  assert.deepEqual(bare['reviewReasons'], []);
  assert.deepEqual(bare['customFields'], {});

  const rich = byName(body, 'rich');
  assert.deepEqual(rich['source'], { id: sourceId, name: 'Buyer Inquiry', type: 'webhook', provider: 'tally', connectionMethod: 'API' });
  assert.equal(rich['score'], 42.5);
  assert.equal(rich['minBudget'], 250000);
  assert.equal(rich['maxBudget'], 400000.5);
  assert.equal(rich['bedrooms'], 3);
  assert.equal(rich['submissionCount'], 3);
  assert.equal(rich['statusReason'], 'why');
  assert.deepEqual(rich['customFields'], { k: 1 });
  assert.deepEqual(rich['reviewReasons'], ['phone_invalid']);
});

test('assignedAgent is the current assignment only', async () => {
  const rich = byName((await list('', A.token)).body, 'rich');
  assert.deepEqual(rich['assignedAgent'], {
    id: A.profileId,
    name: 'Own a',
    assignmentType: 'manual',
    assignedAt: new Date(t0 + 2000).toISOString(),
  });
});

test('contactLeadCount: phone first, then email, scoped to the organization', async () => {
  const { body } = await list('', A.token);
  const count = (n: string) => byName(body, n)['contactLeadCount'];
  assert.equal(count('phone1'), 3);
  assert.equal(count('phone2'), 3);
  assert.equal(count('phone3'), 3, 'a usable phone wins over a shared email');
  // email1 + emptyPhone + phone3 share the email; org B's copy is not counted.
  assert.equal(count('email1'), 3);
  assert.equal(count('emptyPhone'), 3, 'an empty phone falls back to email');
  assert.equal(count('rich'), 1);
});

test('status filter, including the legacy alias', async () => {
  const booked = await list('?status=appointment_booked', A.token);
  assert.equal(booked.status, 200, booked.text);
  assert.deepEqual(names(booked.body), ['emptyPhone', 'email1']);
  assert.ok(booked.body.every((l) => l['status'] === 'appointment_booked'));

  assert.deepEqual(names((await list('?status=qualified', A.token)).body), ['rich']);
});

test('sourceId filter', async () => {
  const res = await list(`?sourceId=${sourceId}`, A.token);
  assert.deepEqual(names(res.body), ['rich', 'phone1']);
  assert.ok(res.body.every((l) => l['source']?.id === sourceId));
});

test('limit keeps newest-first order', async () => {
  const res = await list('?limit=2', A.token);
  assert.deepEqual(names(res.body), ['rich', 'emptyPhone']);
});

test('empty result is an empty array', async () => {
  const res = await list('?status=closed', A.token);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body, []);
  assert.deepEqual((await list('?limit=0', A.token)).body, []);
});

test('another organization\'s source id lists nothing', async () => {
  const res = await list(`?sourceId=${sourceId}`, B.token);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body, []);
});
