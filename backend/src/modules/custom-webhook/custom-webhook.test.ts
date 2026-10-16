import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { createHmac } from 'node:crypto';
import { AuthModule } from '../../auth/auth.module';
import { envSchema } from '../../app.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { newId } from '../../common/ids';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { AgentsModule } from '../agents/agents.module';
import { EventsModule } from '../events/events.module';
import { PHONE_UNPARSED_REASON } from '../google-sheets/sheet-rows';
import { LeadSourcesModule } from '../lead-sources/lead-sources.module';
import { AWAITING_MAPPING, CUSTOM_PROVIDER, HELD_CAP, SETUP_REVIEW_REASON } from './constants';
import { CustomWebhookModule } from './custom-webhook.module';

/**
 * Integration suite for custom webhooks, against the REAL database:
 * listening -> held delivery -> sample -> mapping -> dry run -> activation ->
 * leads, plus every auth mode, dedupe, the deliveries read-back, tenancy and
 * the rollout flag. Run with `npm run test:custom-webhook`.
 *
 * The worker runs in-process (it is what turns a delivery into a lead); every
 * outreach poller stays off, so nothing can text or call anyone.
 */
process.env['STRATEGY_ENGINE'] = '0';
process.env['CALENDAR_SYNC'] = '0';
// Set, not deleted: ConfigModule re-reads backend/.env, where these may be on.
process.env['SHEETS_SYNC'] = '0';
process.env['SHEETS_VERSION_PROBE'] = '0';
process.env['WORKER_ENABLED'] = 'true';
process.env['WORKER_POLL_INTERVAL_MS'] = '1000';
process.env['CUSTOM_WEBHOOK_ENABLED'] = '1';
delete process.env['SMTP_HOST'];
// The worker polls beside the requests here, so the two pooled connections
// test-setup leaves a plain suite are not enough: an interactive transaction
// (signup, agent creation) would wait on the worker's claim and time out.
if (process.env['DATABASE_URL']) {
  const url = new URL(process.env['DATABASE_URL']);
  url.searchParams.set('connection_limit', '5');
  process.env['DATABASE_URL'] = url.toString();
}

/* eslint-disable @typescript-eslint/no-explicit-any */

const RUN = Date.now().toString(36);
const PASSWORD = 'correct-horse-battery-staple';
const API = '/api/v1/custom-webhooks';

let app: INestApplication;
let prisma: PrismaService;
let base: string;
const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];

let A = { token: '', orgId: '', userId: '' };
let B = { token: '', orgId: '', userId: '' };
let agentA = '';

interface Made {
  id: string;
  token: string;
  secret: string | null;
}
/** The main source: header secret + delivery-id header. */
let main: Made = { id: '', token: '', secret: null };
/** Delivery ids as the tests go, for later assertions. */
const seen: Record<string, string> = {};

async function call(path: string, token?: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(base + path, {
    method: init.method ?? 'GET',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  let body: any = {};
  try {
    body = JSON.parse(text);
  } catch {
    /* raw text stays in the assertion message */
  }
  return { status: res.status, body, text };
}

/** Posts raw bytes to the public custom route. */
async function deliver(token: string, raw: string, headers: Record<string, string> = {}, contentType = 'application/json') {
  const res = await fetch(`${base}/ingest/v1/custom/${token}`, {
    method: 'POST',
    headers: { 'content-type': contentType, ...headers },
    body: raw,
  });
  const text = await res.text();
  let body: any = {};
  try {
    body = JSON.parse(text);
  } catch {
    /* raw text stays in the assertion message */
  }
  return { status: res.status, body, text };
}

async function signupOwner(tag: string) {
  const res = await call('/api/auth/signup', undefined, {
    method: 'POST',
    body: {
      email: `custom-webhook-${RUN}-${tag}@example.invalid`,
      password: PASSWORD,
      firstName: 'Own',
      lastName: 'Er',
      organizationName: `CustomWebhook ${tag} ${RUN}`,
    },
  });
  assert.equal(res.status, 201, res.text);
  createdUserIds.push(res.body.user.id);
  createdOrgIds.push(res.body.organization.id);
  return { token: res.body.token as string, orgId: res.body.organization.id as string, userId: res.body.user.id as string };
}

async function createAgent(ownerToken: string, tag: string): Promise<string> {
  const email = `custom-webhook-${RUN}-agent-${tag}@example.invalid`;
  const created = await call('/api/agents', ownerToken, { method: 'POST', body: { email, password: PASSWORD, firstName: 'Ag', lastName: tag } });
  assert.equal(created.status, 201, created.text);
  createdUserIds.push(created.body.id);
  const login = await call('/api/auth/login', undefined, { method: 'POST', body: { email, password: PASSWORD } });
  assert.equal(login.status, 200, login.text);
  return login.body.token as string;
}

async function createWebhook(token: string, body: Record<string, unknown>): Promise<Made & { body: any }> {
  const res = await call(API, token, { method: 'POST', body });
  assert.equal(res.status, 201, res.text);
  return { id: res.body.id, token: String(res.body.webhookUrl).split('/').pop()!, secret: res.body.secret ?? null, body: res.body };
}

/** Polls until the worker has finished with a delivery. */
async function processed(eventId: string, timeoutMs = 25_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const row = await prisma.webhook_events.findUnique({ where: { id: eventId } });
    if (row && row.queue_state !== 'PENDING' && row.queue_state !== 'PROCESSING') return row;
    if (Date.now() > until) throw new Error(`delivery ${eventId} still ${row?.queue_state ?? 'missing'} after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PAYLOAD1 = {
  name: 'Ann Lee',
  contact: { phone: '(512) 555-0101', email: 'Ann@Example.com' },
  budget: '400k-500k',
  beds: 3,
  notes: 'wants a yard',
  consent: 'yes',
  meta: { utm_source: 'facebook', source: 'fb-ads' },
  tags: ['buyer', 'relocating'],
};
const PAYLOAD2 = {
  name: 'Raj Patel',
  contact: { phone: '512-555-0102', email: 'raj@example.com' },
  budget: 'Under 300k',
  beds: 2,
  notes: 'first home',
  consent: 'no',
  meta: { utm_source: 'google', source: 'g-ads' },
  tags: [],
};
const FIELDS = [
  { path: 'name', target: 'full_name' },
  { path: 'contact.phone', target: 'phone' },
  { path: 'contact.email', target: 'email' },
  { path: 'budget', target: 'budget_range' },
  { path: 'beds', target: 'bedrooms' },
  { path: 'notes', target: 'motivation' },
  { path: 'consent', target: 'consent_status' },
  { path: 'meta.utm_source', target: 'utm_source' },
  { path: 'meta.source', target: '__custom__', customName: 'Source' },
];
const sortFields = (f: any[]) => [...f].sort((a, b) => a.path.localeCompare(b.path) || a.target.localeCompare(b.target));
const sortedTargets = (a: any) => ({ ...a, targetFields: [...a.targetFields].sort() });

const mainHeaders = (deliveryId: string, secret = main.secret!) => ({ 'x-webhook-secret': secret, 'x-delivery-id': deliveryId });

before(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, validate: (raw) => ({ ...raw, ...envSchema.parse(raw) }) }),
      PrismaModule,
      EventsModule,
      AuthModule,
      AgentsModule,
      LeadSourcesModule,
      CustomWebhookModule,
    ],
  }).compile();
  // rawBody: the HMAC modes sign the exact bytes, as server.ts provides them.
  app = moduleRef.createNestApplication({ rawBody: true });
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  prisma = app.get(PrismaService);

  A = await signupOwner('a');
  B = await signupOwner('b');
  agentA = await createAgent(A.token, 'one');
});

after(async () => {
  try {
    for (const orgId of createdOrgIds) {
      await prisma.webhook_events.deleteMany({ where: { organization_id: orgId } });
      await prisma.leads.deleteMany({ where: { organization_id: orgId } });
      await prisma.domain_events.deleteMany({ where: { organization_id: orgId } });
      await prisma.lead_source_field_mappings.deleteMany({ where: { organization_id: orgId } });
      await prisma.lead_sources.deleteMany({ where: { organization_id: orgId } });
    }
    await prisma.users.deleteMany({ where: { id: { in: createdUserIds } } });
    // Orgs with audit rows cannot be deleted (immutable audit log).
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

test('the flag probe answers an owner, and only an owner', async () => {
  assert.deepEqual((await call(`${API}/config`, A.token)).body, { enabled: true });
  assert.equal((await call(`${API}/config`)).status, 401);
  assert.equal((await call(`${API}/config`, 'not-a-token')).status, 401);
  assert.equal((await call(`${API}/config`, agentA)).status, 403);
});

test('creating a webhook mints a URL and a one-time secret, and starts it listening', async () => {
  const res = await call(API, A.token, {
    method: 'POST',
    body: { name: 'Zapier leads', auth: { mode: 'header_secret', headerName: 'X-Webhook-Secret' }, deliveryIdHeader: 'X-Delivery-Id' },
  });
  assert.equal(res.status, 201, res.text);
  const b = res.body;
  assert.match(b.webhookUrl, /\/ingest\/v1\/custom\/whk_live_[0-9A-HJKMNP-TV-Z]{20}$/);
  assert.match(b.secret, /^whsec_/);
  assert.equal(b.provider, CUSTOM_PROVIDER);
  assert.equal(b.connectionMethod, 'MANUAL');
  assert.equal(b.ingestStatus, 'AWAITING_FIRST_EVENT');
  assert.equal(b.mappingStatus, 'UNCONFIGURED');
  assert.ok(b.signingSecretPreview);
  assert.deepEqual(b.custom, {
    auth: { mode: 'header_secret', headerName: 'x-webhook-secret' },
    deliveryIdHeader: 'x-delivery-id',
    dropped: 0,
    activated: false,
    held: 0,
    mappingConfigured: false,
    mappingVersion: 0,
    fields: [],
  });
  assert.ok(!/secret_enc|ingest_token_enc|custom_config/.test(res.text));
  main = { id: b.id, token: String(b.webhookUrl).split('/').pop()!, secret: b.secret };

  // Read back: never the secret again.
  const got = await call(`${API}/${main.id}`, A.token);
  assert.equal(got.status, 200, got.text);
  assert.equal(got.body.secret, undefined);
  assert.equal(got.body.webhookUrl, b.webhookUrl);

  // It is an ordinary lead source to the rest of the app.
  const list = await call('/api/v1/lead-sources', A.token);
  const mine = (list.body as any[]).find((s) => s.id === main.id);
  assert.ok(mine);
  assert.equal(mine.provider, CUSTOM_PROVIDER);
  assert.equal(mine.webhookUrl, b.webhookUrl);
});

test('a webhook needs a name and a complete auth setting', async () => {
  assert.equal((await call(API, A.token, { method: 'POST', body: { name: '' } })).status, 400);
  assert.equal((await call(API, A.token, { method: 'POST', body: { name: 'x', auth: { mode: 'hmac' } } })).status, 400);
  assert.equal((await call(API, A.token, { method: 'POST', body: { name: 'x', auth: { mode: 'basic' } } })).status, 400);
  assert.equal((await call(API, A.token, { method: 'POST', body: { name: 'x', deliveryIdHeader: 'bad header!' } })).status, 400);
  assert.equal((await call(API, agentA, { method: 'POST', body: { name: 'x' } })).status, 403);
});

test('a delivery while listening is stored and held, not processed, and the source moves on to mapping', async () => {
  const raw = JSON.stringify(PAYLOAD1);
  const res = await deliver(main.token, raw, mainHeaders('d-1'));
  assert.equal(res.status, 202, res.text);
  assert.equal(res.body.received, true);
  assert.equal(res.body.held, true);
  assert.equal(res.body.reason, 'awaiting_mapping');
  seen.held = res.body.deliveryId;

  const row = await prisma.webhook_events.findUnique({ where: { id: seen.held } });
  assert.ok(row);
  assert.equal(row.organization_id, A.orgId);
  assert.equal(row.lead_source_id, main.id);
  assert.equal(row.provider, CUSTOM_PROVIDER);
  assert.equal(row.event_type, 'custom.delivery');
  assert.equal(row.external_event_id, null);
  assert.equal(row.dedupe_key, 'custom:d-1');
  assert.equal(row.queue_state, 'PENDING');
  assert.equal(row.outcome, null);
  assert.equal(row.outcome_reason, AWAITING_MAPPING);
  assert.ok(row.available_at && row.available_at.getTime() > Date.now() + 365 * 24 * 3600_000, 'held far in the future');
  assert.equal(row.signature_state, 'VALID');
  assert.equal(row.signature_verified, true);
  assert.equal(row.raw_body, raw);
  assert.equal(row.content_length, Buffer.byteLength(raw));
  assert.deepEqual(row.payload, PAYLOAD1);
  const headers = row.headers as Record<string, string>;
  assert.equal(headers['x-webhook-secret'], '[present, redacted]');
  assert.equal(headers['x-delivery-id'], 'd-1');
  assert.ok(headers['content-type']);

  const src = await prisma.lead_sources.findUnique({ where: { id: main.id } });
  assert.equal(src?.ingest_status, 'NEEDS_MAPPING');
  assert.ok(src?.last_event_at);

  // The worker never touches a held row.
  await sleep(1500);
  assert.equal((await prisma.webhook_events.findUnique({ where: { id: seen.held } }))?.queue_state, 'PENDING');
  assert.equal(await prisma.leads.count({ where: { organization_id: A.orgId } }), 0);

  const got = await call(`${API}/${main.id}`, A.token);
  assert.equal(got.body.custom.held, 1);
  assert.equal(got.body.ingestStatus, 'NEEDS_MAPPING');
});

test('the same delivery id again is a 200 duplicate', async () => {
  const res = await deliver(main.token, JSON.stringify(PAYLOAD1), mainHeaders('d-1'));
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body, { received: true, duplicate: true, deliveryId: seen.held });
  assert.equal(await prisma.webhook_events.count({ where: { lead_source_id: main.id } }), 1);
});

test('a wrong or missing secret is quarantined with 401 and never processed', async () => {
  const raw = JSON.stringify({ ...PAYLOAD1, name: 'Intruder' });
  const wrong = await deliver(main.token, raw, mainHeaders('d-bad', 'whsec_not_it'));
  assert.equal(wrong.status, 401, wrong.text);
  assert.equal(wrong.body.error, 'invalid_signature');
  const row = await prisma.webhook_events.findUnique({ where: { id: wrong.body.deliveryId } });
  assert.equal(row?.outcome, 'QUARANTINED_SIGNATURE');
  assert.equal(row?.signature_state, 'INVALID');
  assert.equal(row?.queue_state, 'FAILED');
  assert.equal(row?.raw_body, raw);

  const missing = await deliver(main.token, raw, { 'x-delivery-id': 'd-missing' });
  assert.equal(missing.status, 401, missing.text);
  assert.equal(missing.body.error, 'signature_required');
  assert.equal((await prisma.webhook_events.findUnique({ where: { id: missing.body.deliveryId } }))?.signature_state, 'MISSING');

  await sleep(1200);
  assert.equal(await prisma.leads.count({ where: { organization_id: A.orgId } }), 0);
});

test('the sample is the held payload flattened to paths, with a suggested mapping', async () => {
  const res = await call(`${API}/${main.id}/sample`, A.token);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body.delivery, { id: seen.held, receivedAt: res.body.delivery.receivedAt, held: true });
  assert.equal(res.body.truncated, false);
  const byPath = Object.fromEntries((res.body.paths as any[]).map((p) => [p.path, p]));
  assert.deepEqual(byPath['contact.phone'], { path: 'contact.phone', value: '(512) 555-0101', type: 'string' });
  assert.deepEqual(byPath['beds'], { path: 'beds', value: '3', type: 'number' });
  assert.deepEqual(byPath['tags'], { path: 'tags', value: 'buyer, relocating', type: 'list' });
  assert.ok(byPath['tags[1]']);
  assert.ok(byPath['meta.source']);
  const suggested = Object.fromEntries((res.body.suggested as any[]).map((s) => [s.path, s.target]));
  assert.equal(suggested['contact.email'], 'email');
  assert.equal(suggested['contact.phone'], 'phone');
  assert.equal(suggested['name'], 'full_name');
  assert.deepEqual(res.body.custom.fields, []);
});

test('a mapping must read every path and name a contact field', async () => {
  const noContact = await call(`${API}/${main.id}/mapping`, A.token, { method: 'PUT', body: { fields: [{ path: 'name', target: 'full_name' }] } });
  assert.equal(noContact.status, 400, noContact.text);
  assert.equal(noContact.body.error.code, 'VALIDATION_ERROR');
  assert.deepEqual(noContact.body.error.details, [{ path: 'fields', message: 'Map at least one contact field: phone or email' }]);

  const badPath = await call(`${API}/${main.id}/mapping`, A.token, { method: 'PUT', body: { fields: [{ path: 'a..b', target: 'phone' }] } });
  assert.equal(badPath.status, 400, badPath.text);
  assert.equal(badPath.body.error.details[0].path, 'fields.0.path');

  const twice = await call(`${API}/${main.id}/mapping`, A.token, {
    method: 'PUT',
    body: { fields: [{ path: 'a', target: 'phone' }, { path: 'b', target: 'phone' }] },
  });
  assert.equal(twice.status, 400, twice.text);

  assert.equal((await call(`${API}/${main.id}/mapping`, A.token, { method: 'PUT', body: { fields: [] } })).status, 400);
  assert.equal((await call(`${API}/${main.id}/mapping`, A.token, { method: 'PUT', body: { fields: [{ path: 'p', target: 'timeline' }] } })).status, 400);
  assert.equal((await call(`${API}/${main.id}/mapping`, B.token, { method: 'PUT', body: { fields: FIELDS } })).status, 404);
  assert.equal((await call(`${API}/${main.id}/mapping`, agentA, { method: 'PUT', body: { fields: FIELDS } })).status, 403);
  assert.equal((await prisma.lead_sources.findUnique({ where: { id: main.id } }))?.mapping_status, 'UNCONFIGURED');
});

test('a draft mapping can be tried against the held payload before anything is saved', async () => {
  const res = await call(`${API}/${main.id}/test`, A.token, { method: 'POST', body: { fields: FIELDS } });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.delivery.id, seen.held);
  const p = res.body.preview;
  assert.equal(p.wouldCreate, true);
  assert.equal(p.status, 'new');
  assert.deepEqual(p.values, {
    first_name: 'Ann',
    last_name: 'Lee',
    phone: '+15125550101',
    email: 'ann@example.com',
    min_budget: 400000,
    max_budget: 500000,
    bedrooms: 3,
    motivation: 'wants a yard',
    consent_status: true,
    utm_source: 'facebook',
  });
  assert.deepEqual(p.customFields, { Source: 'fb-ads' });
  assert.deepEqual(p.reviewReasons, []);

  // Nothing saved yet, so a dry run of "the saved mapping" has nothing to run.
  const saved = await call(`${API}/${main.id}/test`, A.token, { method: 'POST' });
  assert.equal(saved.status, 409, saved.text);
  assert.equal(await prisma.lead_source_field_mappings.count({ where: { lead_source_id: main.id } }), 0);
});

test('saving the mapping stores it, reads back as chosen, and still holds deliveries until switched on', async () => {
  const res = await call(`${API}/${main.id}/mapping`, A.token, { method: 'PUT', body: { fields: FIELDS } });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.mappingStatus, 'CONFIGURED');
  assert.equal(res.body.custom.mappingConfigured, true);
  assert.equal(res.body.custom.mappingVersion, 1);
  assert.equal(res.body.custom.activated, false);
  assert.deepEqual(sortFields(res.body.custom.fields), sortFields(FIELDS));

  const rows = await prisma.lead_source_field_mappings.findMany({ where: { lead_source_id: main.id } });
  assert.equal(rows.length, 11); // full name and budget range are two rows each
  assert.ok(rows.every((r) => r.origin === 'USER' && r.is_active));

  const dry = await call(`${API}/${main.id}/test`, A.token, { method: 'POST' });
  assert.equal(dry.status, 200, dry.text);
  assert.equal(dry.body.preview.values.phone, '+15125550101');

  const held = await deliver(main.token, JSON.stringify({ ...PAYLOAD1, name: 'Second Held' }), mainHeaders('d-2'));
  assert.equal(held.status, 202, held.text);
  assert.equal(held.body.held, true);
  seen.held2 = held.body.deliveryId;
  assert.equal((await call(`${API}/${main.id}`, A.token)).body.custom.held, 2);
});

test('switching on releases the held deliveries as paused, flagged leads — never auto-contacted', async () => {
  assert.equal((await call(`${API}/${main.id}/activate`, B.token, { method: 'POST' })).status, 404);
  const res = await call(`${API}/${main.id}/activate`, A.token, { method: 'POST' });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.released, 2);
  assert.equal(res.body.custom.activated, true);
  assert.equal(res.body.ingestStatus, 'ACTIVE');

  const row = await processed(seen.held);
  assert.equal(row.queue_state, 'DONE');
  assert.equal(row.outcome, 'PROCESSED');
  assert.ok(row.lead_id);
  const lead = await prisma.leads.findUnique({ where: { id: row.lead_id! } });
  assert.ok(lead);
  assert.equal(lead.lead_source_id, main.id);
  assert.equal(lead.first_name, 'Ann');
  assert.equal(lead.last_name, 'Lee');
  assert.equal(lead.normalized_phone, '+15125550101');
  assert.equal(lead.phone_valid, true);
  assert.equal(lead.normalized_email, 'ann@example.com');
  assert.equal(lead.email_valid, true);
  assert.equal(Number(lead.min_budget), 400000);
  assert.equal(Number(lead.max_budget), 500000);
  assert.equal(lead.bedrooms, 3);
  assert.equal(lead.motivation, 'wants a yard');
  assert.equal(lead.consent_status, 'granted');
  assert.equal(lead.utm_source, 'facebook');
  assert.deepEqual(lead.custom_fields, { Source: 'fb-ads' });
  assert.equal(lead.status, 'new');
  // The point of the hold: captured before anyone mapped it, so paused and flagged.
  assert.equal(lead.automation_paused, true);
  assert.equal(lead.needs_review, true);
  assert.deepEqual(lead.review_reasons, [SETUP_REVIEW_REASON]);
  assert.ok(await prisma.lead_submissions.findUnique({ where: { webhook_event_id: row.id } }));

  const second = await processed(seen.held2);
  assert.ok(second.lead_id);
  assert.equal((await prisma.leads.findUnique({ where: { id: second.lead_id! } }))?.automation_paused, true);
  assert.equal(await prisma.leads.count({ where: { lead_source_id: main.id } }), 2);

  const audit = await prisma.audit_logs.findFirst({ where: { organization_id: A.orgId, action: 'custom_webhook.activated' } });
  assert.ok(audit);
  assert.equal(audit.actor_id, A.userId);
  assert.equal((await call(`${API}/${main.id}`, A.token)).body.custom.held, 0);
});

test('a live delivery after switch-on becomes an ordinary lead', async () => {
  const res = await deliver(main.token, JSON.stringify(PAYLOAD2), mainHeaders('d-3'));
  assert.equal(res.status, 202, res.text);
  assert.deepEqual(res.body, { received: true, deliveryId: res.body.deliveryId });
  seen.live = res.body.deliveryId;

  const row = await processed(seen.live);
  assert.equal(row.outcome, 'PROCESSED');
  assert.ok(Array.isArray(row.mapping_trace));
  const lead = await prisma.leads.findUnique({ where: { id: row.lead_id! } });
  assert.ok(lead);
  assert.equal(lead.first_name, 'Raj');
  assert.equal(lead.normalized_phone, '+15125550102');
  assert.equal(Number(lead.min_budget), 0);
  assert.equal(Number(lead.max_budget), 300000);
  assert.equal(lead.consent_status, 'pending');
  assert.equal(lead.automation_paused, false);
  assert.equal(lead.needs_review, false);
  assert.deepEqual(lead.review_reasons, []);
  assert.equal(lead.status, 'new');
  assert.ok((await prisma.lead_sources.findUnique({ where: { id: main.id } }))?.last_success_at);
});

test('form-encoded bodies are read too, nested fields included', async () => {
  const raw = 'name=Bo+Form&contact%5Bphone%5D=512-555-0199&contact%5Bemail%5D=bo%40example.com&beds=4';
  const res = await deliver(main.token, raw, mainHeaders('d-4'), 'application/x-www-form-urlencoded');
  assert.equal(res.status, 202, res.text);
  const row = await processed(res.body.deliveryId);
  assert.equal(row.raw_body, raw);
  assert.equal(row.outcome, 'PROCESSED');
  const lead = await prisma.leads.findUnique({ where: { id: row.lead_id! } });
  assert.equal(lead?.first_name, 'Bo');
  assert.equal(lead?.last_name, 'Form');
  assert.equal(lead?.normalized_phone, '+15125550199');
  assert.equal(lead?.normalized_email, 'bo@example.com');
  assert.equal(lead?.bedrooms, 4);
});

test('a payload with neither phone nor email ends as NEEDS_IDENTITY: stored, no lead, no crash', async () => {
  const before = await prisma.leads.count({ where: { organization_id: A.orgId } });
  const res = await deliver(main.token, JSON.stringify({ name: 'Nobody', notes: 'no contact' }), mainHeaders('d-5'));
  assert.equal(res.status, 202, res.text);
  const row = await processed(res.body.deliveryId);
  assert.equal(row.queue_state, 'DONE');
  assert.equal(row.outcome, 'NEEDS_IDENTITY');
  assert.equal(row.outcome_reason, 'no_phone_or_email');
  assert.equal(row.lead_id, null);
  assert.equal(await prisma.leads.count({ where: { organization_id: A.orgId } }), before);
});

test('an unparseable phone makes a flagged lead that must not be dialled', async () => {
  const res = await deliver(main.token, JSON.stringify({ name: 'Bad Phone', contact: { phone: '12345' } }), mainHeaders('d-6'));
  assert.equal(res.status, 202, res.text);
  const row = await processed(res.body.deliveryId);
  assert.equal(row.outcome, 'PROCESSED_WITH_WARNINGS');
  const lead = await prisma.leads.findUnique({ where: { id: row.lead_id! } });
  assert.equal(lead?.phone, '12345');
  assert.equal(lead?.phone_valid, false);
  assert.equal(lead?.status, 'invalid');
  assert.equal(lead?.needs_review, true);
  assert.ok(lead?.review_reasons.includes(PHONE_UNPARSED_REASON));
  assert.equal(lead?.automation_paused, false);
});

test('deliveries read back as paths joined to the mapping, in the same shape as a form source', async () => {
  const res = await call(`/api/v1/lead-sources/${main.id}/deliveries`, A.token);
  assert.equal(res.status, 200, res.text);
  const rows = res.body as any[];
  const KEYS = [
    'id', 'receivedAt', 'providerEventId', 'signatureState', 'usedPreviousSecret', 'queueState', 'outcome',
    'outcomeReason', 'errorMessage', 'bodyBytes', 'formName', 'answers', 'parseError', 'mapping',
  ];
  for (const r of rows) {
    assert.deepEqual(Object.keys(r), KEYS);
    assert.equal(r.parseError, null);
    assert.equal(r.providerEventId, null);
  }
  const live = rows.find((r) => r.id === seen.live);
  assert.ok(live);
  assert.equal(live.outcome, 'PROCESSED');
  const answers = Object.fromEntries(live.answers.map((a: any) => [a.label, sortedTargets(a)]));
  assert.deepEqual(answers['contact.phone'], { label: 'contact.phone', type: 'STRING', value: '512-555-0102', targetFields: ['phone'], mappingOutcome: 'mapped', warnings: [] });
  assert.deepEqual(answers['name'].targetFields, ['first_name', 'last_name']);
  assert.deepEqual(answers['budget'].targetFields, ['max_budget', 'min_budget']);
  // An extra field: kept on the lead under the owner's name, shown as "extra".
  assert.deepEqual(answers['meta.source'], { label: 'meta.source', type: 'STRING', value: 'g-ads', targetFields: [], mappingOutcome: 'unmapped', warnings: [] });
  // A leaf nobody mapped: shown, went nowhere.
  assert.deepEqual(answers['beds'].targetFields, ['bedrooms']);
  assert.equal(answers['tags'].mappingOutcome, null);
  assert.equal(live.mapping.mapped, 10);
  assert.equal(live.mapping.unmapped, 1);

  const held = rows.find((r) => r.id === seen.held);
  assert.equal(held.outcome, 'PROCESSED');
  assert.equal(held.signatureState, 'VALID');
  const quarantined = rows.find((r) => r.outcome === 'QUARANTINED_SIGNATURE');
  assert.ok(quarantined);
  assert.equal(quarantined.mapping, null);
  assert.ok(quarantined.answers.length > 0);
  assert.ok(!/whsec_|secret_enc/.test(res.text));
});

test('without a delivery-id header the bytes are the identity; each auth mode verifies', async () => {
  const open = await createWebhook(A.token, { name: 'Open', auth: { mode: 'none' } });
  assert.equal(open.secret, null);
  const raw = JSON.stringify({ name: 'Open One', contact: { email: 'open@example.com' } });
  const first = await deliver(open.token, raw);
  assert.equal(first.status, 202, first.text);
  assert.equal(first.body.held, true);
  const again = await deliver(open.token, raw);
  assert.equal(again.status, 200, again.text);
  assert.equal(again.body.duplicate, true);
  const row = await prisma.webhook_events.findUnique({ where: { id: first.body.deliveryId } });
  assert.match(row?.dedupe_key ?? '', /^sha256:[0-9a-f]{64}$/);
  assert.equal(row?.signature_state, 'NOT_CONFIGURED');

  const hmac = await createWebhook(A.token, { name: 'Signed', auth: { mode: 'hmac', headerName: 'X-Signature', algorithm: 'sha256', encoding: 'hex', prefix: 'sha256=' } });
  assert.match(hmac.secret ?? '', /^whsec_/);
  const body = JSON.stringify({ name: 'Signed One', contact: { phone: '+15125550155' } });
  const sig = createHmac('sha256', hmac.secret!).update(body).digest('hex');
  assert.equal((await deliver(hmac.token, body, { 'x-signature': `sha256=${sig}` })).status, 202);
  assert.equal((await deliver(hmac.token, body, { 'x-signature': sig })).status, 200); // same bytes: a duplicate, still verified
  const bad = await deliver(hmac.token, body + ' ', { 'x-signature': `sha256=${sig}` });
  assert.equal(bad.status, 401, bad.text);
  assert.equal(bad.body.error, 'invalid_signature');

  const basic = await createWebhook(A.token, { name: 'Basic', auth: { mode: 'basic', username: 'zapier' } });
  const auth = (pass: string) => ({ authorization: `Basic ${Buffer.from(`zapier:${pass}`).toString('base64')}` });
  assert.equal((await deliver(basic.token, body, auth(basic.secret!))).status, 202);
  const wrong = await deliver(basic.token, body + ' ', auth('nope'));
  assert.equal(wrong.status, 401, wrong.text);
  assert.equal((await deliver(basic.token, body + '  ')).body.error, 'signature_required');
  const stored = await prisma.webhook_events.findFirst({ where: { lead_source_id: basic.id, signature_state: 'VALID' } });
  assert.equal((stored?.headers as Record<string, string>)['authorization'], '[present, redacted]');
});

test('pausing holds deliveries; resuming accepts them again', async () => {
  assert.equal((await call(`/api/v1/lead-sources/${main.id}/pause`, A.token, { method: 'POST', body: { paused: true } })).status, 201);
  const held = await deliver(main.token, JSON.stringify(PAYLOAD2), mainHeaders('d-paused'));
  assert.equal(held.status, 202, held.text);
  assert.equal(held.body.reason, 'source_paused');
  assert.equal((await call(`/api/v1/lead-sources/${main.id}/pause`, A.token, { method: 'POST', body: { paused: false } })).status, 201);
  const live = await deliver(main.token, JSON.stringify({ ...PAYLOAD2, name: 'After Pause' }), mainHeaders('d-resumed'));
  assert.equal(live.status, 202, live.text);
  assert.equal(live.body.held, undefined);
  await processed(live.body.deliveryId);
});

test('changing the auth mode issues a fresh secret and keeps the old one for the grace window', async () => {
  const res = await call(`${API}/${main.id}/auth`, A.token, {
    method: 'PATCH',
    body: { auth: { mode: 'hmac', headerName: 'X-Sig', algorithm: 'sha256', encoding: 'base64' } },
  });
  assert.equal(res.status, 200, res.text);
  assert.match(res.body.secret, /^whsec_/);
  assert.notEqual(res.body.secret, main.secret);
  assert.deepEqual(res.body.custom.auth, { mode: 'hmac', headerName: 'x-sig', algorithm: 'sha256', encoding: 'base64' });
  assert.equal(res.body.custom.deliveryIdHeader, 'x-delivery-id');

  const body = JSON.stringify({ ...PAYLOAD2, name: 'New Secret' });
  const fresh = createHmac('sha256', res.body.secret).update(body).digest('base64');
  assert.equal((await deliver(main.token, body, { 'x-sig': fresh, 'x-delivery-id': 'd-auth-1' })).status, 202);
  const old = createHmac('sha256', main.secret!).update(body).digest('base64');
  const graced = await deliver(main.token, body, { 'x-sig': old, 'x-delivery-id': 'd-auth-2' });
  assert.equal(graced.status, 202, graced.text);
  assert.equal((await prisma.webhook_events.findUnique({ where: { id: graced.body.deliveryId } }))?.used_previous_secret, true);
  assert.equal((await deliver(main.token, body, { 'x-webhook-secret': main.secret!, 'x-delivery-id': 'd-auth-3' })).status, 401);
  main.secret = res.body.secret;
  assert.equal((await call(`${API}/${main.id}/auth`, B.token, { method: 'PATCH', body: { auth: { mode: 'none' } } })).status, 404);
});

test('an unsupported body, an empty body, an unknown token and a token of another kind are refused', async () => {
  assert.equal((await deliver(main.token, 'name=x', {}, 'text/plain')).status, 415);
  const empty = await fetch(`${base}/ingest/v1/custom/${main.token}`, { method: 'POST', headers: { 'content-type': 'application/json' } });
  assert.equal(empty.status, 400);
  assert.deepEqual(await empty.json(), { error: 'empty_body' });
  assert.deepEqual((await deliver('whk_live_ZZZZZZZZZZZZZZZZZZZZ', '{}')).body, { error: 'not_found' });
  assert.equal((await deliver('nope', '{}')).status, 404);

  // A Tally source's token on the custom route is simply not found.
  const tally = await call('/api/v1/lead-sources', A.token, { method: 'POST', body: { name: 'A Tally form' } });
  assert.equal(tally.status, 201, tally.text);
  const tallyToken = String(tally.body.webhookUrl).split('/').pop()!;
  assert.equal((await deliver(tallyToken, '{}')).status, 404);

  // A JSON body that is not an object or array never reaches us: the body
  // parser refuses it (strict JSON) with a 400, and nothing is stored.
  const notObject = await deliver(main.token, '"just a string"', { 'x-delivery-id': 'd-str', 'x-sig': createHmac('sha256', main.secret!).update('"just a string"').digest('base64') });
  assert.equal(notObject.status, 400, notObject.text);
  assert.equal(await prisma.webhook_events.count({ where: { lead_source_id: main.id, dedupe_key: 'custom:d-str' } }), 0);
});

test('a listening source holds at most the cap; past it deliveries are dropped and counted', async () => {
  const capped = await createWebhook(A.token, { name: 'Forgotten', auth: { mode: 'none' } });
  const far = new Date(Date.now() + 100 * 365 * 24 * 3600_000);
  await prisma.webhook_events.createMany({
    data: Array.from({ length: HELD_CAP }, (_, i) => ({
      id: newId(),
      organization_id: A.orgId,
      lead_source_id: capped.id,
      provider: CUSTOM_PROVIDER,
      event_type: 'custom.delivery',
      dedupe_key: `custom:seed-${i}`,
      payload: { i },
      queue_state: 'PENDING',
      outcome_reason: AWAITING_MAPPING,
      available_at: far,
    })),
  });
  const res = await deliver(capped.token, JSON.stringify({ name: 'One Too Many' }));
  assert.equal(res.status, 202, res.text);
  assert.deepEqual(res.body, { received: false, dropped: true, reason: 'setup_backlog_full' });
  assert.equal(await prisma.webhook_events.count({ where: { lead_source_id: capped.id } }), HELD_CAP);
  const got = await call(`${API}/${capped.id}`, A.token);
  assert.equal(got.body.custom.dropped, 1);
  assert.equal(got.body.custom.held, HELD_CAP);
});

test('another organization sees none of it', async () => {
  for (const path of [`${API}/${main.id}`, `${API}/${main.id}/sample`]) {
    assert.equal((await call(path, B.token)).status, 404, path);
  }
  assert.equal((await call(`${API}/${main.id}/test`, B.token, { method: 'POST' })).status, 404);
  const list = await call('/api/v1/lead-sources', B.token);
  assert.ok(!(list.body as any[]).some((s) => s.id === main.id));
  assert.equal((await call(`/api/v1/lead-sources/${main.id}/deliveries`, B.token)).text, '[]');
});

test('switched off, neither the management routes nor the ingest route exist', async () => {
  process.env['CUSTOM_WEBHOOK_ENABLED'] = '0';
  process.env['WORKER_ENABLED'] = 'false';
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, validate: (raw) => ({ ...raw, ...envSchema.parse(raw) }) }),
      PrismaModule,
      EventsModule,
      AuthModule,
      LeadSourcesModule,
      CustomWebhookModule,
    ],
  }).compile();
  const off = moduleRef.createNestApplication({ rawBody: true });
  off.useGlobalFilters(new AllExceptionsFilter());
  await off.init();
  await off.listen(0, '127.0.0.1');
  const offBase = await off.getUrl();
  try {
    const config = await fetch(`${offBase}${API}/config`, { headers: { authorization: `Bearer ${A.token}` } });
    assert.equal(config.status, 404);
    assert.equal(((await config.json()) as any).error.code, 'CUSTOM_WEBHOOK_DISABLED');
    const create = await fetch(`${offBase}${API}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${A.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    assert.equal(create.status, 404);
    const ingest = await fetch(`${offBase}/ingest/v1/custom/${main.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-delivery-id': 'd-off' },
      body: JSON.stringify(PAYLOAD2),
    });
    assert.equal(ingest.status, 404);
    assert.deepEqual(await ingest.json(), { error: 'not_found' });
    assert.equal(await prisma.webhook_events.count({ where: { lead_source_id: main.id, dedupe_key: 'custom:d-off' } }), 0);
    // The ordinary lead-source routes are untouched by the flag.
    const list = await fetch(`${offBase}/api/v1/lead-sources`, { headers: { authorization: `Bearer ${A.token}` } });
    assert.equal(list.status, 200);
  } finally {
    await off.close();
    process.env['CUSTOM_WEBHOOK_ENABLED'] = '1';
    process.env['WORKER_ENABLED'] = 'true';
  }
});
