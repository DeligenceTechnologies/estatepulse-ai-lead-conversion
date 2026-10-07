import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AuthModule } from '../auth/auth.module';
import { envSchema } from '../app.module';
import { LeadStatus } from '../common/domain';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { TelnyxModule } from './telnyx.module';

/**
 * Integration suite for the two manual engine triggers on PortalLeadsController,
 * against the real database. Run with `npm run test:portal-leads`.
 *
 * Both take a lead id from the URL. The organization comes from the session,
 * and a lead id from another organization must be a 404 that changes nothing —
 * the same answer as a lead that does not exist.
 */

// Nothing here may start the background pollers against the shared database,
// whatever the developer's .env says.
process.env['STRATEGY_ENGINE'] = '0';
process.env['CALENDAR_SYNC'] = '0';
process.env['WORKER_ENABLED'] = 'false';

const RUN = Date.now().toString(36);
const emailFor = (tag: string): string => `portal-leads-${RUN}-${tag}@example.invalid`;
const PASSWORD = 'correct-horse-battery-staple';
const MISSING_LEAD = '00000000-0000-4000-8000-000000000000';

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
    body: { email: emailFor(tag), password: PASSWORD, firstName: 'Own', lastName: 'Er', organizationName: `PortalLeads ${tag} ${RUN}` },
  });
  assert.equal(res.status, 201, res.text);
  createdUserIds.push(res.body.user.id);
  createdOrgIds.push(res.body.organization.id);
  return { token: res.body.token as string, orgId: res.body.organization.id as string };
}

async function newLead(orgId: string, name: string): Promise<string> {
  const lead = await prisma.leads.create({
    data: { organization_id: orgId, status: LeadStatus.NEW, first_name: name },
    select: { id: true },
  });
  createdLeadIds.push(lead.id);
  return lead.id;
}

const leadState = (id: string) =>
  prisma.leads.findUniqueOrThrow({
    where: { id },
    select: { status: true, temperature: true, first_contact_at: true, ai_summary: true },
  });

let ownerA = { token: '', orgId: '' };
let ownerB = { token: '', orgId: '' };
let leadToEnroll = '';
let leadToQualify = '';
let leadOtherOrg = '';

before(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, validate: (raw) => ({ ...raw, ...envSchema.parse(raw) }) }),
      PrismaModule,
      AuthModule,
      TelnyxModule,
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

  // A strategy with no steps: enrolling still claims the lead and marks it
  // contacting, but schedules no text or call.
  const strategy = await call('/api/strategy', ownerA.token, { method: 'PUT', body: { steps: [] } });
  assert.equal(strategy.status, 200, strategy.text);

  leadToEnroll = await newLead(ownerA.orgId, 'Enrollme');
  leadToQualify = await newLead(ownerA.orgId, 'Qualifyme');
  leadOtherOrg = await newLead(ownerB.orgId, 'Otherorg');
});

after(async () => {
  try {
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

test('enroll: a lead in the caller\'s organization is enrolled', async () => {
  const res = await call(`/api/leads/${leadToEnroll}/enroll`, ownerA.token, { method: 'POST' });
  assert.equal(res.status, 202, res.text);
  assert.deepEqual(res.body, { ok: true });

  const lead = await leadState(leadToEnroll);
  assert.notEqual(lead.first_contact_at, null);
  assert.equal(lead.status, LeadStatus.CONTACTING);
});

test('enroll: a lead from another organization is a 404 and is not touched', async () => {
  const before = await leadState(leadOtherOrg);
  const res = await call(`/api/leads/${leadOtherOrg}/enroll`, ownerA.token, { method: 'POST' });
  assert.equal(res.status, 404, res.text);

  const lead = await leadState(leadOtherOrg);
  assert.deepEqual(lead, before);
  assert.equal(lead.first_contact_at, null);
  assert.equal(lead.status, LeadStatus.NEW);
});

test('enroll: a lead that does not exist is the same 404', async () => {
  const res = await call(`/api/leads/${MISSING_LEAD}/enroll`, ownerA.token, { method: 'POST' });
  assert.equal(res.status, 404, res.text);
});

test('qualified: a lead in the caller\'s organization is qualified', async () => {
  const res = await call(`/api/leads/${leadToQualify}/qualified`, ownerA.token, {
    method: 'POST',
    body: { temperature: 'hot', summary: 'Wants to buy this month' },
  });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body, { ok: true });

  const lead = await leadState(leadToQualify);
  assert.equal(lead.status, LeadStatus.QUALIFIED);
  assert.equal(lead.temperature, 'hot');
  assert.equal(lead.ai_summary, 'Wants to buy this month');
});

test('qualified: a lead from another organization is a 404 and is not touched', async () => {
  const before = await leadState(leadOtherOrg);
  const res = await call(`/api/leads/${leadOtherOrg}/qualified`, ownerA.token, {
    method: 'POST',
    body: { temperature: 'hot', summary: 'cross-tenant write' },
  });
  assert.equal(res.status, 404, res.text);
  assert.deepEqual(await leadState(leadOtherOrg), before);
});

test('qualified: a lead that does not exist is the same 404', async () => {
  const res = await call(`/api/leads/${MISSING_LEAD}/qualified`, ownerA.token, {
    method: 'POST',
    body: { temperature: 'warm' },
  });
  assert.equal(res.status, 404, res.text);
});
