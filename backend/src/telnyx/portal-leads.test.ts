import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import bcrypt from 'bcrypt';
import { AuthModule } from '../auth/auth.module';
import { envSchema } from '../app.module';
import { LeadStatus } from '../common/domain';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { TelnyxModule } from './telnyx.module';

/**
 * Integration suite for PortalLeadsController — the legacy lead list and the
 * two manual engine triggers — against the real database. Run with
 * `npm run test:portal-leads`.
 *
 * The triggers take a lead id from the URL. The organization comes from the
 * session, and a lead id from another organization must be a 404 that changes
 * nothing — the same answer as a lead that does not exist.
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
const createdSourceIds: string[] = [];

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

// --- the legacy list: GET /api/leads ------------------------------------------

/** An agent member of `orgId` with a profile, signed in. */
async function signedInAgent(orgId: string, tag: string) {
  const user = await prisma.users.create({
    data: { email: emailFor(tag), first_name: 'Agent', last_name: tag, password_hash: await bcrypt.hash(PASSWORD, 4) },
    select: { id: true },
  });
  createdUserIds.push(user.id);
  await prisma.organization_members.create({ data: { organization_id: orgId, user_id: user.id, role: 'agent', status: 'active' } });
  const profile = await prisma.agent_profiles.create({
    data: { organization_id: orgId, user_id: user.id, display_name: `Agent ${tag}` },
    select: { id: true },
  });
  const login = await call('/api/auth/login', undefined, { method: 'POST', body: { email: emailFor(tag), password: PASSWORD } });
  assert.equal(login.status, 200, login.text);
  return { userId: user.id, profileId: profile.id, token: login.body.token as string };
}

async function leadSource(
  orgId: string,
  code: string,
  sourceType: string,
  extra: { provider?: string; connection_method?: string } = {},
): Promise<string> {
  const row = await prisma.lead_sources.create({
    data: { organization_id: orgId, name: code, code: `${code}-${RUN}`, source_type: sourceType, ...extra },
    select: { id: true },
  });
  createdSourceIds.push(row.id);
  return row.id;
}

async function lead(data: Parameters<PrismaService['leads']['create']>[0]['data']): Promise<string> {
  const row = await prisma.leads.create({ data, select: { id: true } });
  createdLeadIds.push(row.id);
  return row.id;
}

test("list: every lead in the caller's organization, newest first, each legacy field exactly as sent", async () => {
  const owner = await signupOwner('list-owner');
  const agent = await signedInAgent(owner.orgId, 'list-agent');
  const website = await leadSource(owner.orgId, 'website', 'website');
  const zillow = await leadSource(owner.orgId, 'zillow', 'zillow');

  // Every column the response reads, set; and some it does not read, too.
  const full = await lead({
    organization_id: owner.orgId,
    lead_source_id: website,
    first_name: 'Bea',
    last_name: 'Buyer',
    email: 'bea@example.invalid',
    phone: '+15125550123',
    status: 'qualified',
    score: 42.5,
    temperature: 'hot',
    timeline: '1-3 months',
    min_budget: 250000.5,
    max_budget: 450000,
    financing_status: 'Pre-approved',
    location: 'Austin, TX — Zilker',
    bedrooms: 3,
    motivation: 'Relocating for work',
    consent_status: 'granted',
    takeover_user_id: agent.userId,
    last_contact_at: new Date('2026-07-04T12:00:00.000Z'),
    created_at: new Date('2026-07-04T00:00:00.000Z'),
    updated_at: new Date('2026-07-04T00:05:00.000Z'),
    ai_summary: 'Not part of this response',
    extracted_intel: { budget: 450000 },
    custom_fields: { hasAgent: false },
    consent_text: 'I agree to be contacted',
  });
  await prisma.lead_assignments.create({
    data: { organization_id: owner.orgId, lead_id: full, agent_id: agent.profileId, assignment_type: 'manual' },
  });
  // Nothing optional set; a legacy 'booked'.
  const bare = await lead({
    organization_id: owner.orgId,
    lead_source_id: zillow,
    status: 'booked',
    created_at: new Date('2026-07-03T00:00:00.000Z'),
    updated_at: new Date('2026-07-03T00:00:00.000Z'),
  });
  // Legacy 'lost' reads as dnc with the flag, not_interested without it.
  const optedOut = await lead({
    organization_id: owner.orgId,
    first_name: 'Otto',
    status: 'lost',
    dnc_status: true,
    created_at: new Date('2026-07-02T00:00:00.000Z'),
    updated_at: new Date('2026-07-02T00:00:00.000Z'),
  });
  const gaveUp = await lead({
    organization_id: owner.orgId,
    first_name: 'Gail',
    status: 'lost',
    consent_status: 'revoked',
    automation_paused: true,
    created_at: new Date('2026-07-01T00:00:00.000Z'),
    updated_at: new Date('2026-07-01T00:00:00.000Z'),
  });

  // The legacy constants every lead carries. Source is not one of them: it is
  // the lead's own (see the next test).
  const fixed = { leadType: 'buyer', propertyType: '', preapprovalStatus: false };
  const expected = JSON.stringify({
    leads: [
      {
        id: full,
        organizationId: owner.orgId,
        // The takeover user, not the current assignment.
        assignedAgentId: agent.userId,
        firstName: 'Bea',
        lastName: 'Buyer',
        email: 'bea@example.invalid',
        phone: '+15125550123',
        source: 'website',
        status: 'qualified',
        leadType: fixed.leadType,
        preferredLocation: 'Austin, TX — Zilker',
        budgetMin: 250000.5,
        budgetMax: 450000,
        propertyType: fixed.propertyType,
        bedrooms: 3,
        timeline: '1-3 months',
        financingStatus: 'Pre-approved',
        preapprovalStatus: fixed.preapprovalStatus,
        score: 42.5,
        temperature: 'hot',
        consentStatus: 'granted',
        dncStatus: false,
        automationPaused: false,
        createdAt: '2026-07-04T00:00:00.000Z',
        updatedAt: '2026-07-04T00:05:00.000Z',
        lastContactedAt: '2026-07-04T12:00:00.000Z',
        notes: 'Relocating for work',
      },
      ...(
        [
          [bare, '', 'zillow', 'appointment_booked', 'pending', false, false, '2026-07-03T00:00:00.000Z'],
          [optedOut, 'Otto', 'manual', 'dnc', 'pending', true, false, '2026-07-02T00:00:00.000Z'],
          [gaveUp, 'Gail', 'manual', 'not_interested', 'revoked', false, true, '2026-07-01T00:00:00.000Z'],
        ] as const
      ).map(([id, firstName, source, status, consentStatus, dncStatus, automationPaused, at]) => ({
        id,
        organizationId: owner.orgId,
        assignedAgentId: '',
        firstName,
        lastName: '',
        email: '',
        phone: '',
        source,
        status,
        leadType: fixed.leadType,
        preferredLocation: '',
        budgetMin: 0,
        budgetMax: 0,
        propertyType: fixed.propertyType,
        bedrooms: 0,
        timeline: '',
        financingStatus: '',
        preapprovalStatus: fixed.preapprovalStatus,
        score: 0,
        temperature: 'cold',
        consentStatus,
        dncStatus,
        automationPaused,
        createdAt: at,
        updatedAt: at,
        // lastContactedAt and notes are absent, not null, when unset.
      })),
    ],
  });

  const res = await call('/api/leads', owner.token);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.text, expected);

  // Any member of the organization gets the same list — this route has never
  // narrowed by role.
  const asAgent = await call('/api/leads', agent.token);
  assert.equal(asAgent.status, 200, asAgent.text);
  assert.equal(asAgent.text, expected);
});

// Regression: every lead used to read source 'Website', whatever it came from,
// and the lead detail modal showed that instead of the pipeline's badge.
test('list: each lead carries its own source, labelled as the pipeline badges it', async () => {
  const owner = await signupOwner('list-sources');
  const pasted = await leadSource(owner.orgId, 'pasted', 'webhook');
  const viaApi = await leadSource(owner.orgId, 'via-api', 'webhook', { provider: 'TALLY', connection_method: 'API' });
  const foreign = await leadSource(ownerB.orgId, 'foreign', 'website');

  const leads = {
    [await lead({ organization_id: owner.orgId, lead_source_id: pasted })]: 'webhook',
    [await lead({ organization_id: owner.orgId, lead_source_id: viaApi })]: 'tally',
    [await lead({ organization_id: owner.orgId })]: 'manual',
    // Another organization's source never labels this organization's lead.
    [await lead({ organization_id: owner.orgId, lead_source_id: foreign })]: 'manual',
  };

  const res = await call('/api/leads', owner.token);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(
    Object.fromEntries(res.body.leads.map((l: { id: string; source: string }) => [l.id, l.source])),
    leads,
  );
});

test('list: an organization with no leads is an empty list', async () => {
  const owner = await signupOwner('list-empty');
  const res = await call('/api/leads', owner.token);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.text, '{"leads":[]}');
});

test('list: each organization sees only its own leads', async () => {
  const [a, b] = await Promise.all([call('/api/leads', ownerA.token), call('/api/leads', ownerB.token)]);
  assert.equal(a.status, 200, a.text);
  assert.equal(b.status, 200, b.text);
  const ids = (res: { body: { leads: Array<{ id: string }> } }) => res.body.leads.map((l) => l.id).sort();

  assert.deepEqual(ids(a), [leadToEnroll, leadToQualify].sort());
  assert.deepEqual(ids(b), [leadOtherOrg]);
  assert.ok(a.body.leads.every((l: { organizationId: string }) => l.organizationId === ownerA.orgId));
  assert.ok(b.body.leads.every((l: { organizationId: string }) => l.organizationId === ownerB.orgId));
});

test('list: the 500 newest, and no query parameter changes that', async () => {
  const owner = await signupOwner('list-many');
  const start = Date.parse('2026-08-01T00:00:00.000Z');
  // Shuffled insert order, distinct creation times.
  await prisma.leads.createMany({
    data: Array.from({ length: 502 }, (_, i) => (i * 31) % 502).map((m) => ({
      organization_id: owner.orgId,
      status: LeadStatus.NEW,
      first_name: `Lead${m}`,
      created_at: new Date(start + m * 60e3),
    })),
  });
  createdLeadIds.push(
    ...(await prisma.leads.findMany({ where: { organization_id: owner.orgId }, select: { id: true } })).map((l) => l.id),
  );

  const res = await call('/api/leads', owner.token);
  assert.equal(res.status, 200, res.text.slice(0, 200));
  assert.deepEqual(
    res.body.leads.map((l: { createdAt: string }) => l.createdAt),
    Array.from({ length: 500 }, (_, i) => new Date(start + (501 - i) * 60e3).toISOString()),
  );

  for (const query of ['?limit=5', '?take=1000', `?organizationId=${ownerB.orgId}`]) {
    const again = await call(`/api/leads${query}`, owner.token);
    assert.equal(again.status, 200, again.text.slice(0, 200));
    assert.equal(again.text, res.text, query);
  }
});

test('list: no session, or a garbage one, is a 401', async () => {
  const none = await call('/api/leads');
  assert.equal(none.status, 401, none.text);
  const garbage = await call('/api/leads', 'not-a-token');
  assert.equal(garbage.status, 401, garbage.text);
});
