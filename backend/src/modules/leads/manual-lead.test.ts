import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AuthModule } from '../../auth/auth.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { AgentsModule } from '../agents/agents.module';
import { EventsModule } from '../events/events.module';
import { DUPLICATE_REASON } from '../google-sheets/sheet-import.service';
import { LeadsModule } from './leads.module';
import { MANUAL_SOURCE_CODE, NOT_CONNECTED_NOTE } from './manual-lead.service';

/**
 * Integration suite for POST /api/v1/leads (a lead typed in by hand), against
 * the real database, in the shape of lead-assignment.test.ts.
 *
 * Run with `npm run test:manual-lead`.
 */

const RUN = Date.now().toString(36);
const emailFor = (tag: string): string => `manuallead-${RUN}-${tag}@example.invalid`;
const PASSWORD = 'correct-horse-battery-staple';
/** Distinct per run so a duplicate is one this run made, never a leftover. */
const PHONE = `+1512555${String(Date.now() % 10_000).padStart(4, '0')}`;

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

async function call(method: string, path: string, opts: { body?: unknown; token?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.token !== undefined) headers['authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(base + path, { method, headers, ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }) });
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
const details = (res: Res): { path: string; message: string }[] =>
  (asRecord(asRecord(res.body)['error'])['details'] as { path: string; message: string }[] | undefined) ?? [];

async function signupOwner(tag: string, org: string): Promise<{ token: string; userId: string; orgId: string }> {
  const res = await call('POST', '/api/auth/signup', {
    body: { email: emailFor(tag), password: PASSWORD, firstName: 'Own', lastName: 'Er', organizationName: org },
  });
  assert.equal(res.status, 201, `signup(${tag}) failed: ${res.text}`);
  const user = asRecord(asRecord(res.body)['user']);
  const organization = asRecord(asRecord(res.body)['organization']);
  createdUserIds.push(user['id'] as string);
  createdOrgIds.push(organization['id'] as string);
  return { token: asRecord(res.body)['token'] as string, userId: user['id'] as string, orgId: organization['id'] as string };
}

async function createAgent(ownerToken: string, tag: string): Promise<{ token: string }> {
  const created = await call('POST', '/api/agents', {
    token: ownerToken,
    body: { email: emailFor(tag), password: PASSWORD, firstName: 'Ag', lastName: tag },
  });
  assert.equal(created.status, 201, `create agent(${tag}) failed: ${created.text}`);
  createdUserIds.push(asRecord(created.body)['id'] as string);
  const login = await call('POST', '/api/auth/login', { body: { email: emailFor(tag), password: PASSWORD } });
  assert.equal(login.status, 200, login.text);
  return { token: asRecord(login.body)['token'] as string };
}

const add = (token: string | undefined, body: unknown): Promise<Res> => call('POST', '/api/v1/leads', { token, body });

let ownerA = { token: '', userId: '', orgId: '' };
let ownerB = { token: '', userId: '', orgId: '' };
let agent = { token: '' };

before(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, AuthModule, EventsModule, AgentsModule, LeadsModule],
  }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  prisma = app.get(PrismaService);

  ownerA = await signupOwner('owner-a', `ManualLead Test A ${RUN}`);
  ownerB = await signupOwner('owner-b', `ManualLead Test B ${RUN}`);
  agent = await createAgent(ownerA.token, 'agent');
  // A has a line (the row the lead watcher polls for); B has none.
  await prisma.integrations.create({
    data: { organization_id: ownerA.orgId, provider: 'telnyx', integration_type: 'voice', status: 'active', metadata: { test: RUN } },
  });
});

after(async () => {
  try {
    if (createdOrgIds.length > 0) {
      await prisma.leads.deleteMany({ where: { organization_id: { in: createdOrgIds } } });
      await prisma.lead_sources.deleteMany({ where: { organization_id: { in: createdOrgIds } } });
      await prisma.integrations.deleteMany({ where: { organization_id: { in: createdOrgIds } } });
    }
    if (createdUserIds.length > 0) await prisma.users.deleteMany({ where: { id: { in: createdUserIds } } });
    // Organizations with audit rows cannot be removed (the audit log is immutable) — same handling as lead-assignment.test.ts.
    const audited = await prisma.audit_logs.findMany({
      where: { organization_id: { in: createdOrgIds } },
      select: { organization_id: true },
      distinct: ['organization_id'],
    });
    const keep = new Set(audited.map((r) => r.organization_id));
    const removable = createdOrgIds.filter((id) => !keep.has(id));
    if (removable.length > 0) await prisma.organizations.deleteMany({ where: { id: { in: removable } } });
  } finally {
    await app.close();
  }
});

test('owner adds a lead with a dialable phone: saved new, outreach on, under the one manual source', async () => {
  const res = await add(ownerA.token, {
    firstName: ' Jessica ',
    lastName: 'Taylor',
    phone: '(512) 555-0188',
    email: 'Jessica.Taylor@Example.com',
    location: 'North Austin',
    budget: '$500k - 700k',
    bedrooms: '4',
    motivation: 'Relocating for work',
  });
  assert.equal(res.status, 201, res.text);
  const body = asRecord(res.body);
  assert.equal(body['contacting'], true);
  assert.deepEqual(body['warnings'], []);

  const lead = await prisma.leads.findUnique({ where: { id: body['id'] as string } });
  assert.ok(lead);
  assert.equal(lead.organization_id, ownerA.orgId);
  assert.equal(lead.first_name, 'Jessica');
  assert.equal(lead.normalized_phone, '+15125550188');
  assert.equal(lead.phone_valid, true);
  assert.equal(lead.normalized_email, 'jessica.taylor@example.com');
  assert.equal(lead.location, 'North Austin');
  assert.equal(Number(lead.min_budget), 500_000);
  assert.equal(Number(lead.max_budget), 700_000);
  assert.equal(lead.bedrooms, 4);
  assert.equal(lead.motivation, 'Relocating for work');
  assert.equal(lead.status, 'new');
  assert.equal(lead.automation_paused, false);
  assert.equal(lead.dnc_status, false);
  assert.equal(lead.needs_review, false);
  assert.equal(lead.temperature, 'cold');

  const source = await prisma.lead_sources.findFirst({ where: { organization_id: ownerA.orgId, code: MANUAL_SOURCE_CODE } });
  assert.ok(source);
  assert.equal(lead.lead_source_id, source.id);
  assert.equal(source.source_type, 'manual');
  assert.equal(source.connection_method, 'MANUAL');

  const audit = await prisma.audit_logs.findFirst({ where: { organization_id: ownerA.orgId, entity_id: lead.id, action: 'lead.added_by_hand' } });
  assert.ok(audit);
  assert.equal(audit.actor_id, ownerA.userId);
});

test('the same contact again is saved as its own lead, flagged as a possible duplicate', async () => {
  const first = await add(ownerA.token, { firstName: 'Dup', phone: PHONE });
  assert.equal(first.status, 201, first.text);
  const second = await add(ownerA.token, { firstName: 'Dup', phone: PHONE });
  assert.equal(second.status, 201, second.text);
  assert.deepEqual(asRecord(second.body)['warnings'], [DUPLICATE_REASON]);
  assert.notEqual(asRecord(second.body)['id'], asRecord(first.body)['id']);

  // One source for every lead typed in, not one per lead.
  const sources = await prisma.lead_sources.count({ where: { organization_id: ownerA.orgId, code: MANUAL_SOURCE_CODE } });
  assert.equal(sources, 1);
});

test('the phone is required and must be dialable; the email is optional', async () => {
  const before = await prisma.leads.count({ where: { organization_id: ownerA.orgId } });
  // Missing, email or not; present but not a number: all refused at the phone field.
  for (const body of [
    { firstName: 'Nophone' },
    { firstName: 'Emailonly', email: `emailonly-${RUN}@example.invalid` },
    { firstName: 'Bad', phone: '12', email: `bad-${RUN}@example.invalid` },
    { firstName: 'Blank', phone: '   ' },
  ]) {
    const res = await add(ownerA.token, body);
    assert.equal(res.status, 400, res.text);
    assert.deepEqual(
      details(res).map((d) => d.path),
      ['phone'],
      res.text,
    );
  }
  assert.equal(await prisma.leads.count({ where: { organization_id: ownerA.orgId } }), before, 'nothing was saved');

  const ok = await add(ownerA.token, { firstName: 'Phoneonly', phone: '(512) 555-0199' });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(asRecord(ok.body)['contacting'], true);
});

test('a local number from another country: read in the chosen region; an unknown region is refused', async () => {
  const res = await add(ownerA.token, { firstName: 'Priya', phone: '98765 43210', region: 'in' });
  assert.equal(res.status, 201, res.text);
  assert.equal(asRecord(res.body)['contacting'], true);
  const lead = await prisma.leads.findUnique({ where: { id: asRecord(res.body)['id'] as string } });
  assert.equal(lead?.normalized_phone, '+919876543210');

  const bad = await add(ownerA.token, { firstName: 'Priya', phone: '98765 43210', region: 'XX' });
  assert.equal(bad.status, 400, bad.text);
  assert.deepEqual(
    details(bad).map((d) => d.path),
    ['region'],
  );
});

test('GET regions: the office’s own region first, every country with its calling code', async () => {
  const res = await call('GET', '/api/v1/leads/regions', { token: ownerA.token });
  assert.equal(res.status, 200, res.text);
  const body = res.body as { default: string; codes: { callingCode: string; countries: string[] }[] };
  assert.equal(body.default, 'US');
  const byCode = new Map(body.codes.map((c) => [c.callingCode, c.countries]));
  // A shared code names its main country first.
  assert.equal(byCode.get('1')?.[0], 'US');
  assert.equal(byCode.get('44')?.[0], 'GB');
  assert.deepEqual(byCode.get('91'), ['IN']);
  assert.ok(body.codes.length > 200);
  assert.equal((await call('GET', '/api/v1/leads/regions', { token: agent.token })).status, 403);
});

test('invalid bodies: a blank name and an organization in the body are both 400', async () => {
  assert.equal((await add(ownerA.token, { firstName: '   ', phone: PHONE })).status, 400);
  assert.equal((await add(ownerA.token, { firstName: 'X', phone: PHONE, organizationId: ownerB.orgId })).status, 400);
});

test('an agent cannot add leads; no session cannot either', async () => {
  assert.equal((await add(agent.token, { firstName: 'X', phone: PHONE })).status, 403);
  assert.equal((await add(undefined, { firstName: 'X', phone: PHONE })).status, 401);
});

test('tenant isolation, and an office without a line: saved eligible, nobody contacted, the owner told', async () => {
  const res = await add(ownerB.token, { firstName: 'Other', phone: PHONE });
  assert.equal(res.status, 201, res.text);
  // B has never seen this phone: no duplicate flag, even though A holds it twice. B has no Telnyx: told so.
  assert.deepEqual(asRecord(res.body)['warnings'], [NOT_CONNECTED_NOTE]);
  assert.equal(asRecord(res.body)['contacting'], false);
  const lead = await prisma.leads.findUnique({ where: { id: asRecord(res.body)['id'] as string } });
  assert.equal(lead?.organization_id, ownerB.orgId);
  // Not paused: connecting Telnyx later is enough for the watcher to start it.
  assert.equal(lead?.automation_paused, false);
  const list = await call('GET', '/api/v1/leads', { token: ownerA.token });
  assert.equal(list.status, 200, list.text);
  assert.ok(!(list.body as { id: string }[]).some((l) => l.id === lead?.id), 'B’s lead must not be in A’s list');
});
