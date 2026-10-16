import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AuthModule } from '../../auth/auth.module';
import { envSchema } from '../../app.module';
import { SecretBox, providerCredentialAad, sha256Hex } from '../../common/crypto';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService, TENANT_PRISMA, type GuardedPrisma } from '../../prisma/prisma.service';
import { AgentsModule } from '../agents/agents.module';
import { EventsBus } from '../events/events.bus';
import { EventsModule } from '../events/events.module';
import { SheetImportService } from '../google-sheets/sheet-import.service';
import { GoogleSheetsModule } from '../google-sheets/google-sheets.module';
import { LeadsModule } from '../leads/leads.module';
import { CrmConnectionsService } from './crm-connections.service';
import { CRM_PROVIDER_LABELS, crmRowKey, type CrmContact } from './crm-records';
import { CrmRegistry } from './crm-registry';
import { CrmSyncService } from './crm-sync.service';
import { CrmWebhooksController } from './crm-webhooks.controller';
import { CrmWebhooksService } from './crm-webhooks.service';
import { CrmModule } from './crm.module';
import { HubSpotClient } from './hubspot/hubspot.client';
import { CrmApiError, type CrmTokens } from './types';

/**
 * Integration suite for the HubSpot CRM integration, against the REAL database
 * with a FAKE HubSpot. Run with `npm run test:hubspot`.
 *
 * The fake behaves like HubSpot where it matters: contacts page by a cursor,
 * a batch read leaves out ids that no longer exist, tokens are bound to the
 * account they were issued for, and webhooks are signed with the v3 scheme.
 * No real SMS or call can happen: the outreach pollers are off, and the
 * outreach engine is not part of this module.
 */
process.env['STRATEGY_ENGINE'] = '0';
process.env['CALENDAR_SYNC'] = '0';
process.env['WORKER_ENABLED'] = 'false';
process.env['SHEETS_SYNC'] = '0';
process.env['HUBSPOT_ENABLED'] = '1';
// The suite drives the worker itself (drain()); no background timer.
process.env['CRM_POLL_MS'] = '0';
delete process.env['SMTP_HOST'];

/* eslint-disable @typescript-eslint/no-explicit-any */

const RUN = Date.now().toString(36);
const PASSWORD = 'correct-horse-battery-staple';
const API = '/api/integrations/crm/hubspot';
const REVIEW = '/api/integrations/google-sheets/review';
const WEBHOOK_PATH = '/ingest/v1/crm/hubspot/webhook';
const WEBHOOK_URL = `https://api.example.test${WEBHOOK_PATH}`;
const WEBHOOK_SECRET = 'test-hubspot-client-secret';
const IMPORT_REASON = 'Imported from HubSpot — awaiting owner approval';

// Numeric, like HubSpot's, and random so a re-run never meets a live connection from an earlier one.
const portalId = () => String(700_000_000 + Math.floor(Math.random() * 99_000_000));
const P_A = portalId();
const P_A2 = portalId();

// --- the fake HubSpot ------------------------------------------------------------

interface Stored {
  contact: CrmContact;
  modifiedAt: number;
}
const portals = new Map<string, Map<string, Stored>>();
let clock = Date.now();
const calls = { refresh: 0, list: 0, read: 0, revoke: [] as string[], uninstall: 0 };
/** The account (and scopes) the next authorization code belongs to. */
const grant = { portal: '', scopes: ['oauth', 'crm.objects.contacts.read'] };
let seq = 0;
/** Fail the Nth listContacts call from now (1 = the next), once. */
let failList: { at: number; err: CrmApiError } | null = null;
let refreshImpl: ((rt: string) => Promise<CrmTokens>) | null = null;
/** Fail the next readContacts call, once. */
let failRead: CrmApiError | null = null;
const PAGE = 40;

const portalOf = (token: string) => token.split(':')[1];
const store = (portal: string) => {
  if (!portals.has(portal)) portals.set(portal, new Map());
  return portals.get(portal)!;
};
function put(portal: string, id: string, c: Partial<CrmContact>): void {
  const prev = store(portal).get(id)?.contact;
  store(portal).set(id, {
    contact: { externalId: id, firstName: null, lastName: null, email: null, phone: null, extra: {}, ...prev, ...c },
    // HubSpot's clock: real time, strictly increasing.
    modifiedAt: (clock = Math.max(clock + 1, Date.now())),
  });
}
const sorted = (portal: string) => [...store(portal).values()].sort((a, b) => Number(a.contact.externalId) - Number(b.contact.externalId));

const fake = {
  provider: 'HUBSPOT',
  label: CRM_PROVIDER_LABELS.HUBSPOT,
  requiredScopes: ['crm.objects.contacts.read'],
  webhookUrl: WEBHOOK_URL,
  webhookSecret: WEBHOOK_SECRET,
  isConfigured: () => true,
  authorizeUrl: (state: string) => `https://app.hubspot.test/oauth/authorize?state=${encodeURIComponent(state)}`,
  exchangeCode: async (code: string): Promise<CrmTokens> => {
    if (code === 'rejected-code') throw new CrmApiError('REAUTH', 'HubSpot rejected the grant (BAD_AUTH_CODE)', 400);
    seq += 1;
    return { accessToken: `at:${grant.portal}:${seq}`, refreshToken: `rt:${grant.portal}:${seq}`, expiresIn: 1800, scopes: grant.scopes };
  },
  refresh: async (rt: string): Promise<CrmTokens> => {
    calls.refresh += 1;
    if (refreshImpl) return refreshImpl(rt);
    seq += 1;
    return { accessToken: `at:${portalOf(rt)}:${seq}`, refreshToken: rt, expiresIn: 1800, scopes: null };
  },
  identify: async (at: string) => ({
    externalAccountId: portalOf(at),
    accountName: `${portalOf(at)}.hubspot.test`,
    userEmail: 'crm-user@example.test',
    scopes: grant.scopes,
  }),
  revoke: async (rt: string) => {
    calls.revoke.push(rt);
  },
  uninstall: async () => {
    calls.uninstall += 1;
  },
  listContacts: async (at: string, cursor: string | null) => {
    calls.list += 1;
    if (failList) {
      failList.at -= 1;
      if (failList.at === 0) {
        const e = failList.err;
        failList = null;
        throw e;
      }
    }
    const all = sorted(portalOf(at));
    const start = cursor ? Number(cursor) : 0;
    const next = start + PAGE < all.length ? String(start + PAGE) : null;
    return { contacts: all.slice(start, start + PAGE).map((s) => s.contact), nextCursor: next };
  },
  readContacts: async (at: string, ids: string[]) => {
    calls.read += 1;
    if (failRead) {
      const e = failRead;
      failRead = null;
      throw e;
    }
    const s = store(portalOf(at));
    const found = ids.filter((id) => s.has(id)).map((id) => s.get(id)!.contact);
    return { found, missing: ids.filter((id) => !s.has(id)) };
  },
  changedContactsSince: async (at: string, sinceMs: number) => {
    const changed = sorted(portalOf(at)).filter((s) => s.modifiedAt >= sinceMs);
    return { contacts: changed.map((s) => ({ ...s.contact, modifiedAt: s.modifiedAt })), nextCursor: null, capped: false };
  },
};

// --- harness --------------------------------------------------------------------

let app: INestApplication;
let prisma: PrismaService;
let sync: CrmSyncService;
let connections: CrmConnectionsService;
let base: string;
const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];
let box: SecretBox;

async function call(path: string, token?: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: any; text: string }> {
  const res = await fetch(base + path, {
    method: init.method ?? 'GET',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.body ? { 'content-type': 'application/json' } : {}) },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  let body: unknown = {};
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
    body: { email: `hubspot-${RUN}-${tag}@example.invalid`, password: PASSWORD, firstName: 'Own', lastName: 'Er', organizationName: `HubSpot ${tag} ${RUN}` },
  });
  assert.equal(res.status, 201, res.text);
  createdUserIds.push(res.body.user.id);
  createdOrgIds.push(res.body.organization.id);
  return { token: res.body.token as string, orgId: res.body.organization.id as string, userId: res.body.user.id as string };
}

/** The whole OAuth round trip, as the browser would drive it. */
async function connect(owner: { token: string }, portal: string, code = `code-${portal}`) {
  grant.portal = portal;
  const started = await call(`${API}/oauth/start`, owner.token, { method: 'POST' });
  assert.equal(started.status, 200, started.text);
  const state = new URL(started.body.authorizeUrl).searchParams.get('state')!;
  return call(`${API}/oauth/complete`, owner.token, { method: 'POST', body: { code, state } });
}

let eventSeq = 1000;
const ev = (portal: string, type: string, objectId: string, extra: Record<string, unknown> = {}) => ({
  eventId: ++eventSeq,
  subscriptionId: 77,
  portalId: Number(portal),
  appId: 1,
  occurredAt: Date.now(),
  subscriptionType: type,
  attemptNumber: 0,
  objectId: Number(objectId),
  ...extra,
});

/** POST a delivery signed exactly as HubSpot signs one. */
async function webhook(events: unknown[], opts: { ts?: number; secret?: string; body?: string } = {}) {
  const body = opts.body ?? JSON.stringify(events);
  const ts = opts.ts ?? Date.now();
  const sig = createHmac('sha256', opts.secret ?? WEBHOOK_SECRET).update(`POST${WEBHOOK_URL}${body}${ts}`, 'utf8').digest('base64');
  const res = await fetch(base + WEBHOOK_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hubspot-signature-v3': sig, 'x-hubspot-request-timestamp': String(ts) },
    body,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {}, text };
}

const email = (n: number | string) => `hs.${n}.${RUN}@example.test`;
const phone = (n: number) => `512-555-01${String(n % 100).padStart(2, '0')}`;

async function sourceOf(orgId: string) {
  return prisma.lead_sources.findFirstOrThrow({ where: { organization_id: orgId, provider: 'HUBSPOT' }, orderBy: { created_at: 'desc' } });
}
async function leadOf(orgId: string, contactId: string) {
  const src = await sourceOf(orgId);
  const row = await prisma.sheet_import_rows.findFirst({
    where: { organization_id: orgId, lead_source_id: src.id, row_key: crmRowKey('HUBSPOT', 'contact', contactId) },
    include: { leads: true },
  });
  return row;
}
async function credentialOf(orgId: string) {
  return prisma.provider_credentials.findFirst({ where: { organization_id: orgId, provider: 'HUBSPOT', revoked_at: null } });
}
const leadsOf = (orgId: string) => prisma.leads.count({ where: { organization_id: orgId } });
/**
 * Hold a connection's lease as a live "other worker" would, so the background
 * drain that every request nudges cannot run the work before the test has
 * finished arranging it. Released by letting go of the lease.
 */
const hold = async (orgId: string) =>
  prisma.lead_sources.updateMany({ where: { organization_id: orgId, provider: 'HUBSPOT' }, data: { sync_locked_at: new Date(), sync_locked_by: 'crm-test-hold' } });
const letGo = async (orgId: string) =>
  prisma.lead_sources.updateMany({ where: { organization_id: orgId, provider: 'HUBSPOT' }, data: { sync_locked_at: null, sync_locked_by: null } });
/** Make every queued or backed-off run claimable now. */
const runsDueNow = (orgId: string) =>
  prisma.crm_sync_runs.updateMany({ where: { organization_id: orgId, status: { in: ['queued', 'running'] } }, data: { available_at: new Date(Date.now() - 1000) } });

let A = { token: '', orgId: '', userId: '' };
let B = { token: '', orgId: '', userId: '' };
let agentToken = '';
const existing: Record<string, string> = {};

before(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, validate: (raw) => ({ ...raw, ...envSchema.parse(raw) }) }),
      PrismaModule,
      EventsModule,
      AuthModule,
      AgentsModule,
      LeadsModule,
      GoogleSheetsModule,
      CrmModule,
    ],
  })
    .overrideProvider(HubSpotClient)
    .useValue(fake)
    .compile();
  // rawBody: the webhook signature covers the exact bytes, as in server.ts.
  app = moduleRef.createNestApplication({ rawBody: true });
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  prisma = app.get(PrismaService);
  sync = app.get(CrmSyncService);
  connections = app.get(CrmConnectionsService);
  box = new SecretBox(process.env['ENCRYPTION_KEYS']!, process.env['ENCRYPTION_ACTIVE_KEY_ID']!);

  A = await signupOwner('a');
  B = await signupOwner('b');
  // The database is shared with whatever else lives in it: this process only
  // ever works the connections it made.
  sync.claimOnly([A.orgId, B.orgId]);

  const agentEmail = `hubspot-${RUN}-agent@example.invalid`;
  const created = await call('/api/agents', A.token, { method: 'POST', body: { email: agentEmail, password: PASSWORD, firstName: 'Ag', lastName: 'Ent' } });
  assert.equal(created.status, 201, created.text);
  createdUserIds.push(created.body.id);
  const login = await call('/api/auth/login', undefined, { method: 'POST', body: { email: agentEmail, password: PASSWORD } });
  agentToken = login.body.token;

  // Leads A already has, from somewhere else (a form, a call).
  const lead = (data: Record<string, unknown>) => prisma.leads.create({ data: { organization_id: A.orgId, status: 'contacting', ...data } as any });
  existing.link = (await lead({ first_name: 'Linda', email: email('link'), normalized_email: email('link'), email_valid: true, location: 'Austin' })).id;
  existing.conflict = (
    await lead({
      first_name: 'Lynn',
      email: email('conflict'),
      normalized_email: email('conflict'),
      email_valid: true,
      location: 'Round Rock',
      min_budget: 400000,
      custom_fields: { 'Tally answer': 'yes' },
    })
  ).id;
  existing.amb1 = (await lead({ first_name: 'Amb', email: email('amb'), normalized_email: email('amb'), email_valid: true })).id;
  existing.amb2 = (await lead({ first_name: 'Amb2', email: email('amb'), normalized_email: email('amb'), email_valid: true })).id;
  existing.dnc = (await lead({ first_name: 'Opted', phone: '+15125550197', normalized_phone: '+15125550197', phone_valid: true, dnc_status: true, status: 'not_interested' })).id;

  // Portal A: 100 contacts — 90 ordinary, and one of each case worth checking.
  for (let n = 1; n <= 90; n++) put(P_A, String(n), { firstName: `Jane${n}`, lastName: 'Doe', email: email(n), phone: phone(n), extra: { 'HubSpot lifecycle stage': 'Lead' } });
  put(P_A, '91', { firstName: 'No', lastName: 'Contact' }); // refused: nothing to reach them on
  put(P_A, '92', { email: email(92) }); // email only, no name
  put(P_A, '93', { firstName: 'Bad', lastName: 'Phone', email: email(93), phone: '555-CALL' });
  put(P_A, '94', { firstName: 'Linda', lastName: 'Link', email: email('link'), phone: phone(94) }); // links to existing.link
  put(P_A, '95', { firstName: 'Lyn', lastName: 'Hold', email: email('conflict') }); // links to existing.conflict, name differs
  put(P_A, '96', { firstName: 'Ambi', lastName: 'Guous', email: email('amb') }); // two leads share this email
  put(P_A, '97', { firstName: 'Opted', lastName: 'Again', phone: '512-555-0197', email: email(97) }); // an opted-out phone
  put(P_A, '98', { firstName: 'Same', lastName: 'Phone', phone: phone(1), email: email(98) }); // shares contact 1's phone
  put(P_A, '99', { firstName: 'Jane99', lastName: 'Doe', email: email(99), phone: phone(99) });
  put(P_A, '100', { firstName: 'Jane100', lastName: 'Doe', email: email(100), phone: phone(100) });
});

after(async () => {
  try {
    for (const orgId of createdOrgIds) {
      await prisma.webhook_events.deleteMany({ where: { organization_id: orgId } });
      await prisma.crm_sync_runs.deleteMany({ where: { organization_id: orgId } });
      await prisma.sheet_import_rows.deleteMany({ where: { organization_id: orgId } });
      await prisma.leads.deleteMany({ where: { organization_id: orgId } });
      await prisma.lead_sources.deleteMany({ where: { organization_id: orgId } });
      await prisma.provider_credentials.deleteMany({ where: { organization_id: orgId } });
      await prisma.oauth_states.deleteMany({ where: { organization_id: orgId } });
    }
    await prisma.users.deleteMany({ where: { id: { in: createdUserIds } } });
    // Organizations with audit rows stay: the audit log is immutable.
  } finally {
    await app.close();
  }
});

// =================================================================================
// Access
// =================================================================================

test('owner only: an agent is refused everywhere, and no token is refused first', async () => {
  const routes: [string, string, unknown?][] = [
    ['GET', `${API}/config`],
    ['GET', `${API}/status`],
    ['POST', `${API}/oauth/start`],
    ['POST', `${API}/oauth/complete`, { code: 'some-code-123', state: 'x'.repeat(43) }],
    ['POST', `${API}/sync`],
    ['GET', `${API}/runs`],
    ['GET', `${API}/runs/00000000-0000-7000-8000-000000000000`],
    ['DELETE', `${API}/connection`],
  ];
  for (const [method, path, body] of routes) {
    const asAgent = await call(path, agentToken, { method, body });
    assert.equal(asAgent.status, 403, `${method} ${path} as agent: ${asAgent.text}`);
    const anonymous = await call(path, undefined, { method, body });
    assert.equal(anonymous.status, 401, `${method} ${path} without a token: ${anonymous.text}`);
  }
});

test('an unknown CRM is not found, and a switched-off one looks the same', async () => {
  const r = await call('/api/integrations/crm/pipedrive/status', A.token);
  assert.equal(r.status, 404, r.text);
  const registry = new CrmRegistry(fake as unknown as HubSpotClient, new ConfigService({ HUBSPOT_ENABLED: '0' }));
  assert.throws(() => registry.get('hubspot'), (e: any) => e.getStatus() === 404);
  assert.equal(registry.active().length, 0);
});

test('before connecting: not connected, configured, and nothing to sync', async () => {
  const cfg = await call(`${API}/config`, A.token);
  assert.deepEqual(cfg.body, { provider: 'HUBSPOT', displayName: 'HubSpot', configured: true });
  const s = await call(`${API}/status`, A.token);
  assert.equal(s.body.status, 'not_connected');
  const r = await call(`${API}/sync`, A.token, { method: 'POST' });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.body.error.code, 'CRM_NOT_CONNECTED');
});

// =================================================================================
// OAuth
// =================================================================================

test('OAuth state: unknown, someone else’s, expired and reused states are all refused', async () => {
  const unknown = await call(`${API}/oauth/complete`, A.token, { method: 'POST', body: { code: 'code-x-123', state: 'y'.repeat(43) } });
  assert.equal(unknown.status, 400, unknown.text);
  assert.equal(unknown.body.error.code, 'OAUTH_STATE_INVALID');

  // B's authorization cannot be finished by A: a state cannot switch organizations.
  const startedB = await call(`${API}/oauth/start`, B.token, { method: 'POST' });
  const stateB = new URL(startedB.body.authorizeUrl).searchParams.get('state')!;
  const crossed = await call(`${API}/oauth/complete`, A.token, { method: 'POST', body: { code: 'code-x-123', state: stateB } });
  assert.equal(crossed.status, 403, crossed.text);
  assert.equal(crossed.body.error.code, 'OAUTH_SESSION_MISMATCH');

  // The state value is never stored, only its hash.
  const stored = await prisma.oauth_states.findMany({ where: { organization_id: B.orgId } });
  assert.ok(stored.length >= 1 && stored.every((s) => s.id !== stateB && s.id === sha256Hex(stateB)));

  const started = await call(`${API}/oauth/start`, A.token, { method: 'POST' });
  const state = new URL(started.body.authorizeUrl).searchParams.get('state')!;
  await prisma.oauth_states.update({ where: { id: sha256Hex(state) }, data: { expires_at: new Date(Date.now() - 1000) } });
  const expired = await call(`${API}/oauth/complete`, A.token, { method: 'POST', body: { code: 'code-x-123', state } });
  assert.equal(expired.status, 400, expired.text);
  assert.equal(expired.body.error.code, 'OAUTH_STATE_EXPIRED');

  // A rejected code still spends its state: the same state cannot be tried again.
  const again = await call(`${API}/oauth/start`, A.token, { method: 'POST' });
  const state2 = new URL(again.body.authorizeUrl).searchParams.get('state')!;
  const rejected = await call(`${API}/oauth/complete`, A.token, { method: 'POST', body: { code: 'rejected-code', state: state2 } });
  assert.equal(rejected.status, 400, rejected.text);
  assert.equal(rejected.body.error.code, 'OAUTH_CODE_REJECTED');
  const reused = await call(`${API}/oauth/complete`, A.token, { method: 'POST', body: { code: 'code-x-123', state: state2 } });
  assert.equal(reused.status, 400, reused.text);
  assert.equal(reused.body.error.code, 'OAUTH_STATE_USED');

  assert.equal(await prisma.provider_credentials.count({ where: { organization_id: A.orgId } }), 0, 'a refused authorization left a record');
});

test('OAuth: an owner demoted while the consent screen was open cannot finish it', async () => {
  const started = await call(`${API}/oauth/start`, A.token, { method: 'POST' });
  const state = new URL(started.body.authorizeUrl).searchParams.get('state')!;
  await prisma.organization_members.updateMany({ where: { organization_id: A.orgId, user_id: A.userId }, data: { role: 'agent' } });
  try {
    const r = await call(`${API}/oauth/complete`, A.token, { method: 'POST', body: { code: `code-${P_A}`, state } });
    assert.equal(r.status, 403, r.text);
  } finally {
    await prisma.organization_members.updateMany({ where: { organization_id: A.orgId, user_id: A.userId }, data: { role: 'owner' } });
  }
  assert.equal(await prisma.provider_credentials.count({ where: { organization_id: A.orgId } }), 0);
});

test('OAuth: a grant missing the contacts scope is refused and handed back', async () => {
  grant.scopes = ['oauth'];
  const before = calls.revoke.length;
  try {
    const r = await connect(A, P_A);
    assert.equal(r.status, 400, r.text);
    assert.equal(r.body.error.code, 'CRM_SCOPE_NOT_GRANTED');
  } finally {
    grant.scopes = ['oauth', 'crm.objects.contacts.read'];
  }
  assert.equal(calls.revoke.length, before + 1, 'the unusable grant was not revoked');
  assert.equal(await prisma.provider_credentials.count({ where: { organization_id: A.orgId } }), 0);
});

test('connect: the grant is stored encrypted, the import source and the first run are created in one go', async () => {
  const r = await connect(A, P_A);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.status, 'connected');
  assert.equal(r.body.account.id, P_A);
  assert.equal(r.body.account.name, `${P_A}.hubspot.test`);
  assert.equal(r.body.activeRun.kind, 'initial');
  assert.equal(r.body.activeRun.status, 'queued');
  assert.doesNotMatch(r.text, /\b(rt|at):\d{9}/, 'a token reached the browser');

  const cred = (await credentialOf(A.orgId))!;
  assert.equal(cred.status, 'ACTIVE');
  assert.doesNotMatch(cred.credential_enc, /rt:/, 'the refresh token is stored in the clear');
  assert.match(box.decrypt(cred.credential_enc, providerCredentialAad(A.orgId, cred.id)), /^rt:/);
  const src = await sourceOf(A.orgId);
  assert.equal(src.external_form_id, P_A);
  assert.equal(src.connection_method, 'SYNC');
  assert.equal(src.source_type, 'other');
  assert.equal(src.provider_credential_id, cred.id);
  const audit = await prisma.audit_logs.findFirst({ where: { organization_id: A.orgId, action: 'crm.connected' } });
  assert.equal(audit?.actor_id, A.userId);
});

test('connecting the same account again refreshes it in place; a different account is refused; another organization cannot take it', async () => {
  const again = await connect(A, P_A);
  assert.equal(again.status, 200, again.text);
  assert.equal(await prisma.provider_credentials.count({ where: { organization_id: A.orgId, revoked_at: null } }), 1);
  assert.equal(await prisma.lead_sources.count({ where: { organization_id: A.orgId, provider: 'HUBSPOT' } }), 1);
  assert.equal(await prisma.crm_sync_runs.count({ where: { organization_id: A.orgId, status: { in: ['queued', 'running'] } } }), 1, 'a second run was queued');

  const before = calls.revoke.length;
  const other = await connect(A, P_A2);
  assert.equal(other.status, 409, other.text);
  assert.equal(other.body.error.code, 'CRM_ACCOUNT_CONFLICT');
  assert.equal(calls.revoke.length, before + 1, 'the refused grant was not revoked');

  const stolen = await connect(B, P_A);
  assert.equal(stolen.status, 409, stolen.text);
  assert.equal(stolen.body.error.code, 'CRM_ACCOUNT_IN_USE');
  assert.doesNotMatch(stolen.text, new RegExp(A.orgId), 'the other organization was named');
  assert.equal(await prisma.provider_credentials.count({ where: { organization_id: B.orgId } }), 0);
});

test('two tabs finishing the same authorization at once: one connection, never two', async () => {
  grant.portal = P_A;
  const states = await Promise.all(
    [1, 2].map(async () => {
      const s = await call(`${API}/oauth/start`, A.token, { method: 'POST' });
      return new URL(s.body.authorizeUrl).searchParams.get('state')!;
    }),
  );
  const results = await Promise.all(states.map((state, i) => call(`${API}/oauth/complete`, A.token, { method: 'POST', body: { code: `code-tab-${i}`, state } })));
  for (const r of results) assert.equal(r.status, 200, r.text);
  assert.equal(await prisma.provider_credentials.count({ where: { organization_id: A.orgId, revoked_at: null } }), 1);
  assert.equal(await prisma.lead_sources.count({ where: { organization_id: A.orgId, provider: 'HUBSPOT' } }), 1);
  // Only the first connect's import ever exists — each completion nudges the
  // worker, so it may already have finished; what must never happen is a second.
  assert.equal(await prisma.crm_sync_runs.count({ where: { organization_id: A.orgId } }), 1);
});

// =================================================================================
// Initial import
// =================================================================================

test('initial import: paged, every new lead paused for review, existing leads linked rather than duplicated', async () => {
  await sync.drain();
  const s = await call(`${API}/status`, A.token);
  assert.equal(s.body.status, 'connected', s.text);
  assert.equal(s.body.activeRun, null);
  const run = s.body.lastRun;
  assert.equal(run.status, 'succeeded', JSON.stringify(run));
  assert.equal(run.pages, 3);
  assert.equal(run.counts.fetched, 100);
  assert.equal(run.counts.skipped, 1, 'the contact with no way to reach them');
  assert.equal(run.counts.linked, 2, 'the two contacts whose email belongs to exactly one existing lead');
  assert.equal(run.counts.created, 97);
  assert.equal(run.counts.conflicts, 1, 'the linked lead whose name differs');
  assert.equal(run.counts.duplicates, 3, 'ambiguous email, opted-out phone, shared phone');
  assert.ok(s.body.lastSuccessfulSyncAt);

  const src = await sourceOf(A.orgId);
  const imported = await prisma.leads.findMany({ where: { organization_id: A.orgId, lead_source_id: src.id } });
  assert.equal(imported.length, 97);
  for (const l of imported) {
    assert.equal(l.status, 'new');
    assert.equal(l.automation_paused, true, `lead ${l.external_lead_id} is not paused`);
    assert.ok(l.review_reasons.includes(IMPORT_REASON));
    assert.equal(l.consent_status, 'pending');
    assert.equal(l.location, null, 'a CRM field reached an EstatePulse-owned column');
  }
  // Nothing became visible to the outreach watcher.
  assert.equal(await prisma.leads.count({ where: { organization_id: A.orgId, status: 'new', automation_paused: false, dnc_status: false, first_contact_at: null } }), 0);

  const c1 = (await leadOf(A.orgId, '1'))!.leads!;
  assert.equal(c1.normalized_phone, '+15125550101');
  assert.equal(c1.normalized_email, email(1));
  assert.equal(c1.external_lead_id, '1');
  assert.deepEqual(c1.custom_fields, { 'HubSpot lifecycle stage': 'Lead' });

  assert.ok((await leadOf(A.orgId, '92'))!.leads!.review_reasons.some((r) => r.startsWith('No name in HubSpot')));
  assert.equal((await leadOf(A.orgId, '93'))!.leads!.normalized_phone, null);
  assert.equal((await leadOf(A.orgId, '97'))!.leads!.dnc_status, true, 'an opted-out number lost its opt-out');
  assert.ok((await leadOf(A.orgId, '96'))!.leads!.review_reasons.some((r) => r.startsWith('Possible duplicate')));
  assert.ok((await leadOf(A.orgId, '98'))!.leads!.review_reasons.some((r) => r.startsWith('Possible duplicate')));
  assert.equal(await leadOf(A.orgId, '91'), null);
});

test('linking: blanks are filled on the existing lead; a real difference is held, and nothing else is touched', async () => {
  const link = await prisma.leads.findUniqueOrThrow({ where: { id: existing.link } });
  assert.equal(link.first_name, 'Linda');
  assert.equal(link.last_name, 'Link', 'a blank was not filled from HubSpot');
  assert.equal(link.normalized_phone, '+15125550194');
  assert.equal(link.status, 'contacting', 'linking changed the status');
  assert.equal(link.automation_paused, false, 'linking paused a lead that was being worked');
  assert.equal(link.location, 'Austin');
  assert.ok(!link.review_reasons.includes(IMPORT_REASON));
  const linkRow = (await leadOf(A.orgId, '94'))!;
  assert.equal(linkRow.lead_id, existing.link);
  assert.equal(linkRow.review_state, 'approved');

  const conflict = await prisma.leads.findUniqueOrThrow({ where: { id: existing.conflict } });
  assert.equal(conflict.first_name, 'Lynn', 'a linked lead was overwritten');
  assert.equal(conflict.last_name, null);

  // Ambiguous: a third lead, not a link to either of the two.
  assert.notEqual((await leadOf(A.orgId, '96'))!.lead_id, existing.amb1);
  assert.notEqual((await leadOf(A.orgId, '96'))!.lead_id, existing.amb2);

  const src = await sourceOf(A.orgId);
  const changes = await call(`${REVIEW}/changes?sourceId=${src.id}`, A.token);
  assert.equal(changes.status, 200, changes.text);
  const item = changes.body.items.find((i: any) => i.lead?.id === existing.conflict);
  assert.ok(item, changes.text);
  // Only the CRM's own fields are a difference: the lead's location and budget are not.
  assert.deepEqual(item.diff.map((d: any) => d.field).sort(), ['first_name', 'last_name']);
  assert.equal(await prisma.audit_logs.count({ where: { organization_id: A.orgId, action: 'crm.contact_linked' } }), 2);
});

test('applying a held change writes only the CRM’s fields, and keeps everything else the lead had', async () => {
  const row = (await leadOf(A.orgId, '95'))!;
  const r = await call(`${REVIEW}/changes/resolve`, A.token, { method: 'POST', body: { rowIds: [row.id], action: 'apply' } });
  assert.equal(r.status, 200, r.text);
  const lead = await prisma.leads.findUniqueOrThrow({ where: { id: existing.conflict } });
  assert.equal(lead.first_name, 'Lyn');
  assert.equal(lead.last_name, 'Hold');
  assert.equal(lead.location, 'Round Rock');
  assert.equal(Number(lead.min_budget), 400000);
  assert.deepEqual(lead.custom_fields, { 'Tally answer': 'yes' });
  assert.equal(lead.status, 'contacting');
  const after = (await leadOf(A.orgId, '95'))!;
  assert.equal(after.changed_after_review_at, null);
  assert.equal((after.synced_values as any).first_name, 'Lyn');
});

test('Import Review lists HubSpot leads as their own kind; other organizations see none of it', async () => {
  const q = await call(`${REVIEW}?source=hubspot&limit=100`, A.token);
  assert.equal(q.status, 200, q.text);
  assert.equal(q.body.total, 97);
  assert.ok(q.body.items.every((i: any) => i.source.kind === 'hubspot'));

  const theirs = await call(`${REVIEW}?source=hubspot`, B.token);
  assert.equal(theirs.body.total, 0);
  const s = await call(`${API}/status`, B.token);
  assert.equal(s.body.status, 'not_connected');
  assert.equal(s.body.account, null);
  const runId = (await prisma.crm_sync_runs.findFirstOrThrow({ where: { organization_id: A.orgId } })).id;
  const peek = await call(`${API}/runs/${runId}`, B.token);
  assert.equal(peek.status, 404, peek.text);
  assert.equal((await call(`${API}/runs`, B.token)).body.runs.length, 0);
  assert.equal((await call(`${API}/sync`, B.token, { method: 'POST' })).status, 409);
  assert.equal((await call(`${API}/connection`, B.token, { method: 'DELETE' })).status, 404);
  assert.equal((await call(`${API}/runs/${runId}`, A.token)).status, 200);
});

test('importing again creates nothing; "Sync now" twice runs once', async () => {
  const before = await leadsOf(A.orgId);
  const first = await call(`${API}/sync`, A.token, { method: 'POST' });
  assert.equal(first.status, 202, first.text);
  assert.equal(first.body.run.kind, 'full');
  const second = await call(`${API}/sync`, A.token, { method: 'POST' });
  assert.equal(second.status, 200, second.text);
  assert.equal(second.body.alreadyActive, true);
  assert.equal(second.body.run.id, first.body.run.id);

  await sync.drain();
  const run = await call(`${API}/runs/${first.body.run.id}`, A.token);
  assert.equal(run.body.status, 'succeeded', run.text);
  assert.equal(run.body.counts.created, 0);
  assert.equal(run.body.counts.updated, 0);
  assert.equal(run.body.counts.linked, 0);
  assert.equal(run.body.counts.missing, 0);
  assert.equal(await leadsOf(A.orgId), before, 'a re-import created leads');
  const history = await call(`${API}/runs`, A.token);
  assert.equal(history.body.runs.length, 2);
});

test('two workers at once: every contact is still imported exactly once', async () => {
  for (let n = 101; n <= 160; n++) put(P_A, String(n), { firstName: `Par${n}`, lastName: 'Allel', email: email(n) });
  const r = await call(`${API}/sync`, A.token, { method: 'POST' });
  assert.equal(r.status, 202, r.text);
  const second = new CrmSyncService(
    app.get(PrismaService),
    app.get<GuardedPrisma>(TENANT_PRISMA),
    connections,
    app.get(CrmRegistry),
    app.get(SheetImportService),
    app.get(EventsBus),
    app.get(ConfigService),
  );
  second.claimOnly([A.orgId, B.orgId]);
  await Promise.all([sync.drain(), second.drain()]);
  await sync.drain();
  const src = await sourceOf(A.orgId);
  for (let n = 101; n <= 160; n++) {
    assert.equal(await prisma.leads.count({ where: { organization_id: A.orgId, lead_source_id: src.id, external_lead_id: String(n) } }), 1, `contact ${n}`);
  }
  assert.equal((await prisma.crm_sync_runs.findUniqueOrThrow({ where: { id: r.body.run.id } })).status, 'succeeded');
});

// =================================================================================
// Failures, resumption, webhooks during an import
// =================================================================================

test('a rate limit part-way: the run backs off, a webhook is handled meanwhile, and the import resumes from its cursor without duplicates', async () => {
  const src = await sourceOf(A.orgId);
  await hold(A.orgId);
  const r = await call(`${API}/sync`, A.token, { method: 'POST' });
  failList = { at: 2, err: new CrmApiError('RATE_LIMITED', 'TEN_SECONDLY_ROLLING', 429, 30_000) };
  const listedBefore = calls.list;
  await letGo(A.orgId);
  await sync.drain();
  let run = await prisma.crm_sync_runs.findUniqueOrThrow({ where: { id: r.body.run.id } });
  assert.equal(run.status, 'running');
  assert.equal(run.pages, 1, 'the page before the failure was not saved');
  assert.equal(run.cursor, String(PAGE));
  assert.equal(run.attempts, 1);
  assert.equal(run.error_code, 'CRM_RATE_LIMITED');
  assert.ok(run.available_at > new Date(Date.now() + 20_000), 'Retry-After was not honoured');
  const status = await call(`${API}/status`, A.token);
  assert.equal(status.body.activeRun.attempts, 1);
  assert.ok(status.body.activeRun.nextAttemptAt);

  // Meanwhile a contact is created in HubSpot and a webhook says so.
  put(P_A, '161', { firstName: 'Mid', lastName: 'Run', email: email(161) });
  const w = await webhook([ev(P_A, 'contact.creation', '161')]);
  assert.equal(w.status, 200, w.text);
  assert.equal(w.body.accepted, 1);
  await sync.drain();
  assert.ok(await leadOf(A.orgId, '161'), 'the webhook waited for the import');
  assert.equal((await prisma.crm_sync_runs.findUniqueOrThrow({ where: { id: r.body.run.id } })).pages, 1, 'the backed-off run ran early');

  await runsDueNow(A.orgId);
  await sync.drain();
  run = await prisma.crm_sync_runs.findUniqueOrThrow({ where: { id: r.body.run.id } });
  assert.equal(run.status, 'succeeded');
  assert.equal(run.attempts, 0);
  assert.equal(run.created, 0, 'the resumed run imported something twice');
  assert.ok(calls.list - listedBefore < 2 * Math.ceil(161 / PAGE), 'the run started over instead of resuming');
  assert.equal(await prisma.leads.count({ where: { organization_id: A.orgId, lead_source_id: src.id, external_lead_id: '161' } }), 1);
});

test('a worker that died holding the lease: it is taken over once stale, never while live', async () => {
  const src = await sourceOf(A.orgId);
  await prisma.lead_sources.update({ where: { id: src.id }, data: { sync_locked_at: new Date(), sync_locked_by: 'crm-dead-worker' } });
  const r = await call(`${API}/sync`, A.token, { method: 'POST' });
  await sync.drain();
  assert.equal((await prisma.crm_sync_runs.findUniqueOrThrow({ where: { id: r.body.run.id } })).status, 'queued', 'a live lease was ignored');
  await prisma.lead_sources.update({ where: { id: src.id }, data: { sync_locked_at: new Date(Date.now() - 10 * 60_000) } });
  await sync.drain();
  assert.equal((await prisma.crm_sync_runs.findUniqueOrThrow({ where: { id: r.body.run.id } })).status, 'succeeded');
  assert.equal((await prisma.lead_sources.findUniqueOrThrow({ where: { id: src.id } })).sync_locked_by, null, 'the lease was not released');
});

test('a run that keeps failing stops after its retries and says so', async () => {
  const src = await sourceOf(A.orgId);
  // Seven failures already behind it; the eighth is the last.
  const id = randomUUID();
  await prisma.crm_sync_runs.create({
    data: { id, organization_id: A.orgId, lead_source_id: src.id, provider: 'HUBSPOT', kind: 'full', status: 'running', started_at: new Date(), attempts: 7 },
  });
  failList = { at: 1, err: new CrmApiError('UNAVAILABLE', 'HubSpot did not respond', 503) };
  await sync.drain();
  const run = await prisma.crm_sync_runs.findUniqueOrThrow({ where: { id } });
  assert.equal(run.status, 'failed');
  assert.equal(run.error_code, 'RETRIES_EXHAUSTED');
  assert.ok(run.finished_at);
  const s = await call(`${API}/status`, A.token);
  assert.equal(s.body.status, 'error');
  assert.equal(s.body.lastRun.error.code, 'RETRIES_EXHAUSTED');
  assert.ok(await prisma.audit_logs.findFirst({ where: { organization_id: A.orgId, action: 'crm_sync.failed' } }));
  // And a new request starts cleanly.
  const again = await call(`${API}/sync`, A.token, { method: 'POST' });
  assert.equal(again.status, 202, again.text);
  await sync.drain();
  assert.equal((await call(`${API}/status`, A.token)).body.status, 'connected');
});

// =================================================================================
// Webhooks
// =================================================================================

test('webhook authentication: a bad signature, a stale timestamp or a tampered body stores nothing', async () => {
  const before = await prisma.webhook_events.count({ where: { organization_id: A.orgId } });
  const events = [ev(P_A, 'contact.propertyChange', '2', { propertyName: 'lastname' })];
  assert.equal((await webhook(events, { secret: 'wrong' })).status, 401);
  assert.equal((await webhook(events, { ts: Date.now() - 6 * 60_000 })).status, 401);
  const body = JSON.stringify(events);
  const ts = Date.now();
  const sig = createHmac('sha256', WEBHOOK_SECRET).update(`POST${WEBHOOK_URL}${body}${ts}`).digest('base64');
  const tampered = await fetch(base + WEBHOOK_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hubspot-signature-v3': sig, 'x-hubspot-request-timestamp': String(ts) },
    body: body.replace(`"objectId":2`, `"objectId":3`),
  });
  assert.equal(tampered.status, 401);
  const unsigned = await fetch(base + WEBHOOK_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal(unsigned.status, 401);
  assert.equal(await prisma.webhook_events.count({ where: { organization_id: A.orgId } }), before);
});

test('webhooks: garbage is refused, unknown types and unknown accounts are acknowledged and dropped', async () => {
  assert.equal((await webhook([], { body: '{"not":"an array"}' })).status, 400);
  const unknownType = await webhook([ev(P_A, 'deal.creation', '5')]);
  assert.equal(unknownType.status, 200, unknownType.text);
  assert.equal(unknownType.body.ignored, 1);
  const before = await prisma.webhook_events.count({ where: { provider: 'HUBSPOT', organization_id: { in: [A.orgId, B.orgId] } } });
  const stranger = await webhook([ev('123456789', 'contact.creation', '5')]);
  assert.equal(stranger.status, 200, stranger.text);
  assert.equal(stranger.body.ignored, 1);
  assert.equal(await prisma.webhook_events.count({ where: { provider: 'HUBSPOT', organization_id: { in: [A.orgId, B.orgId] } } }), before);
});

test('webhooks: a delivery that cannot be stored answers 503, so HubSpot retries it', async () => {
  const svc = app.get(CrmWebhooksService);
  const original = svc.ingestHubSpot.bind(svc);
  svc.ingestHubSpot = async () => {
    throw new Error('database unavailable');
  };
  try {
    const r = await webhook([ev(P_A, 'contact.creation', '1')]);
    assert.equal(r.status, 503);
  } finally {
    svc.ingestHubSpot = original;
  }
});

test('webhooks: a redelivery is a duplicate; events are applied as HubSpot is NOW, whatever order they arrive in', async () => {
  const before = (await leadOf(A.orgId, '3'))!.leads!;
  put(P_A, '3', { lastName: 'Second' });
  const newer = ev(P_A, 'contact.propertyChange', '3', { propertyName: 'lastname', propertyValue: 'Second', occurredAt: Date.now() });
  put(P_A, '3', { lastName: 'Third' });
  const older = ev(P_A, 'contact.propertyChange', '3', { propertyName: 'lastname', propertyValue: 'First', occurredAt: Date.now() - 60_000 });
  const r1 = await webhook([newer, older]);
  assert.equal(r1.body.accepted, 2, r1.text);
  const redelivered = await webhook([{ ...newer, attemptNumber: 1 }]);
  assert.equal(redelivered.status, 200);
  assert.equal(redelivered.body.duplicates, 1);
  assert.equal(redelivered.body.accepted, 0);
  const stored = await prisma.webhook_events.findFirstOrThrow({ where: { organization_id: A.orgId, provider: 'HUBSPOT', event_type: 'contact.propertyChange' } });
  assert.doesNotMatch(JSON.stringify(stored.payload), /Second|First/, 'a property value was stored');

  await sync.drain();
  const after = (await leadOf(A.orgId, '3'))!.leads!;
  assert.equal(before.id, after.id);
  assert.equal(after.last_name, 'Third', 'an older event overwrote a newer state');
  const done = await prisma.webhook_events.count({ where: { organization_id: A.orgId, provider: 'HUBSPOT', queue_state: 'DONE' } });
  assert.ok(done >= 3);
  assert.equal(await prisma.webhook_events.count({ where: { organization_id: A.orgId, provider: 'HUBSPOT', queue_state: { in: ['PENDING', 'PROCESSING'] } } }), 0);
});

test('a delivery a dead worker left mid-processing is picked up again', async () => {
  const src = await sourceOf(A.orgId);
  put(P_A, '18', { lastName: 'Orphaned' });
  const id = randomUUID();
  await prisma.webhook_events.create({
    data: {
      id,
      organization_id: A.orgId,
      lead_source_id: src.id,
      provider: 'HUBSPOT',
      event_type: 'contact.propertyChange',
      dedupe_key: `hs:orphan-${RUN}`,
      payload: { contactIds: ['18'] },
      queue_state: 'PROCESSING',
      processing_status: 'processing',
      attempts: 1,
      locked_by: 'crm-dead-worker',
      locked_at: new Date(Date.now() - 10 * 60_000),
      available_at: new Date(Date.now() - 10 * 60_000),
    },
  });
  await sync.drain();
  assert.equal((await prisma.webhook_events.findUniqueOrThrow({ where: { id } })).queue_state, 'DONE');
  assert.equal((await leadOf(A.orgId, '18'))!.leads!.last_name, 'Orphaned');
});

test('a rate limit never dead-letters a delivery — a deletion has no other way in; a permanent error does, after its attempts', async () => {
  const src = await sourceOf(A.orgId);
  const make = async (contactId: string) => {
    const id = randomUUID();
    await prisma.webhook_events.create({
      data: {
        id,
        organization_id: A.orgId,
        lead_source_id: src.id,
        provider: 'HUBSPOT',
        event_type: 'contact.deletion',
        dedupe_key: `hs:${id}`,
        payload: { contactIds: [contactId] },
        queue_state: 'PENDING',
        processing_status: 'received',
        attempts: 6,
        max_attempts: 6,
        available_at: new Date(Date.now() - 1000),
      },
    });
    return id;
  };
  const limited = await make('19');
  failRead = new CrmApiError('RATE_LIMITED', 'DAILY', 429, 3_600_000);
  await sync.drain();
  let row = await prisma.webhook_events.findUniqueOrThrow({ where: { id: limited } });
  assert.equal(row.queue_state, 'PENDING', 'a rate-limited deletion was given up on');
  assert.ok(row.available_at! > new Date(Date.now() + 50 * 60_000), 'the daily limit’s wait was not honoured');

  await prisma.webhook_events.update({ where: { id: limited }, data: { available_at: new Date(Date.now() - 1000) } });
  failRead = new CrmApiError('BAD_REQUEST', 'refused', 400);
  await sync.drain();
  row = await prisma.webhook_events.findUniqueOrThrow({ where: { id: limited } });
  assert.equal(row.queue_state, 'DEAD_LETTER');
  assert.equal(row.outcome, 'ERROR');
  assert.ok(row.error_message);
});

test('webhooks: a correctly signed body that is not JSON is refused with 400, never a 500', async () => {
  const r = await webhook([], { body: '{not json' });
  assert.equal(r.status, 400, r.text);
});

test('webhooks: one delivery for a connected and an unknown account keeps the known half', async () => {
  put(P_A, '21', { lastName: 'Mixed' });
  const r = await webhook([ev(P_A, 'contact.propertyChange', '21', { propertyName: 'lastname' }), ev('123456780', 'contact.creation', '5')]);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.accepted, 1);
  assert.equal(r.body.ignored, 1);
  await sync.drain();
  assert.equal((await leadOf(A.orgId, '21'))!.leads!.last_name, 'Mixed');
});

test('webhooks: the same delivery arriving twice at the same moment is stored once', async () => {
  const events = [ev(P_A, 'contact.propertyChange', '22', { propertyName: 'lastname' })];
  const [a, b] = await Promise.all([webhook(events), webhook(events)]);
  assert.equal(a.status, 200, a.text);
  assert.equal(b.status, 200, b.text);
  assert.equal(a.body.accepted + b.body.accepted, 1);
  assert.equal(a.body.duplicates + b.body.duplicates, 1);
  await sync.drain();
});

test('webhooks: a 150-contact delivery is read from HubSpot in batches of 100', async () => {
  const ids = Array.from({ length: 150 }, (_, i) => String(13 + i));
  const reads = calls.read;
  const r = await webhook(ids.map((id) => ev(P_A, 'contact.propertyChange', id, { propertyName: 'lastname' })));
  assert.equal(r.body.accepted, 150, r.text);
  await sync.drain();
  assert.equal(calls.read - reads, 2);
  assert.equal(await prisma.webhook_events.count({ where: { organization_id: A.orgId, provider: 'HUBSPOT', queue_state: 'PENDING' } }), 0);
});

test('odd values — very long fields, emoji, upper-case email, a foreign phone — land without a database error, trimmed to fit', async () => {
  put(P_A, '170', {
    firstName: 'J'.repeat(300),
    lastName: '🏡 Núñez-O’Brien',
    email: `  ODD.170.${RUN.toUpperCase()}@EXAMPLE.TEST `,
    phone: '+44 20 7946 0958',
    extra: { 'HubSpot lifecycle stage': 'x'.repeat(2000) },
  });
  await webhook([ev(P_A, 'contact.creation', '170')]);
  await sync.drain();
  const l = (await leadOf(A.orgId, '170'))!.leads!;
  assert.equal(l.first_name!.length, 100);
  assert.equal(l.last_name, '🏡 Núñez-O’Brien');
  assert.equal(l.normalized_email, `odd.170.${RUN}@example.test`);
  assert.equal(l.normalized_phone, '+442079460958');
  assert.equal(((l.custom_fields as any)['HubSpot lifecycle stage'] as string).length, 500);
  assert.equal(l.automation_paused, true);
});

test('linking ignores email case: an existing lead is matched, not duplicated', async () => {
  const lead = await prisma.leads.create({
    data: { organization_id: A.orgId, first_name: 'Casey', email: `case.${RUN}@example.test`, normalized_email: `case.${RUN}@example.test`, email_valid: true, status: 'contacting' },
  });
  const before = await leadsOf(A.orgId);
  put(P_A, '171', { firstName: 'Casey', lastName: 'Upper', email: `CASE.${RUN.toUpperCase()}@Example.TEST` });
  await webhook([ev(P_A, 'contact.creation', '171')]);
  await sync.drain();
  assert.equal(await leadsOf(A.orgId), before, 'a duplicate lead was created');
  const row = (await leadOf(A.orgId, '171'))!;
  assert.equal(row.lead_id, lead.id);
  assert.equal(row.leads!.last_name, 'Upper', 'a blank was not filled');
});

test('a contact that loses every way to reach them is skipped; its lead is kept as it was, and not called missing', async () => {
  const before = (await leadOf(A.orgId, '23'))!;
  put(P_A, '23', { email: null, phone: null, lastName: 'Unreachable' });
  await webhook([ev(P_A, 'contact.propertyChange', '23', { propertyName: 'email' })]);
  await sync.drain();
  const after = (await leadOf(A.orgId, '23'))!;
  assert.equal(after.lead_id, before.lead_id);
  assert.equal(after.leads!.normalized_email, before.leads!.normalized_email);
  assert.equal(after.leads!.last_name, before.leads!.last_name);
  assert.equal(after.missing_since, null);
  put(P_A, '23', { email: email(23), phone: phone(23), lastName: 'Doe' });
});

test('a webhook cannot reach another organization’s leads', async () => {
  const leadsB = await leadsOf(B.orgId);
  put(P_A, '4', { lastName: 'Changed' });
  await webhook([ev(P_A, 'contact.propertyChange', '4', { propertyName: 'lastname' })]);
  await sync.drain();
  assert.equal(await leadsOf(B.orgId), leadsB);
  assert.equal((await leadOf(A.orgId, '4'))!.leads!.last_name, 'Changed');
});

// =================================================================================
// After approval: the three-way merge
// =================================================================================

test('approved leads: a HubSpot change is applied when nothing here changed — and an empty value never erases one', async () => {
  const rows = await Promise.all(['1', '2', '5'].map((id) => leadOf(A.orgId, id)));
  const approved = await call(`${REVIEW}/approve`, A.token, { method: 'POST', body: { rowIds: rows.map((r) => r!.id) } });
  assert.equal(approved.status, 200, approved.text);
  assert.equal(approved.body.approved, 3);
  const released = await prisma.leads.findUniqueOrThrow({ where: { id: rows[0]!.lead_id! } });
  assert.equal(released.automation_paused, false);

  put(P_A, '1', { lastName: 'Married', phone: null, extra: { 'HubSpot lifecycle stage': 'Customer' } });
  await webhook([ev(P_A, 'contact.propertyChange', '1', { propertyName: 'lastname' })]);
  await sync.drain();
  const lead = await prisma.leads.findUniqueOrThrow({ where: { id: rows[0]!.lead_id! } });
  assert.equal(lead.last_name, 'Married');
  assert.equal(lead.normalized_phone, '+15125550101', 'an empty HubSpot phone erased the lead’s');
  assert.deepEqual(lead.custom_fields, { 'HubSpot lifecycle stage': 'Customer' });
  assert.equal(lead.status, 'new');
  assert.equal(lead.automation_paused, false, 'an update paused the lead');
  assert.equal((await leadOf(A.orgId, '1'))!.changed_after_review_at, null);
});

test('approved leads: a field changed on BOTH sides is held for the owner; "keep" settles it for good', async () => {
  const row = (await leadOf(A.orgId, '2'))!;
  // An edit on this side…
  await prisma.leads.update({ where: { id: row.lead_id! }, data: { phone: '+15125550188', normalized_phone: '+15125550188' } });
  // …and a different one in HubSpot.
  put(P_A, '2', { phone: '512-555-0177' });
  await webhook([ev(P_A, 'contact.propertyChange', '2', { propertyName: 'phone' })]);
  await sync.drain();
  let lead = await prisma.leads.findUniqueOrThrow({ where: { id: row.lead_id! } });
  assert.equal(lead.normalized_phone, '+15125550188', 'a conflicting HubSpot value overwrote the lead');
  const held = (await leadOf(A.orgId, '2'))!;
  assert.ok(held.changed_after_review_at);

  const src = await sourceOf(A.orgId);
  const changes = await call(`${REVIEW}/changes?sourceId=${src.id}`, A.token);
  const item = changes.body.items.find((i: any) => i.rowId === row.id);
  assert.deepEqual(item.diff.map((d: any) => d.field), ['phone']);

  const kept = await call(`${REVIEW}/changes/resolve`, A.token, { method: 'POST', body: { rowIds: [row.id], action: 'keep' } });
  assert.equal(kept.status, 200, kept.text);
  lead = await prisma.leads.findUniqueOrThrow({ where: { id: row.lead_id! } });
  assert.equal(lead.normalized_phone, '+15125550188');

  // A later HubSpot change to a DIFFERENT field is applied; the kept phone is not raised again.
  put(P_A, '2', { lastName: 'Renamed' });
  await webhook([ev(P_A, 'contact.propertyChange', '2', { propertyName: 'lastname' })]);
  await sync.drain();
  lead = await prisma.leads.findUniqueOrThrow({ where: { id: row.lead_id! } });
  assert.equal(lead.last_name, 'Renamed');
  assert.equal(lead.normalized_phone, '+15125550188');
  assert.equal((await leadOf(A.orgId, '2'))!.changed_after_review_at, null, 'the kept change was raised again');
});

test('approved leads: a new phone that belongs to another lead is held, not applied', async () => {
  const row = (await leadOf(A.orgId, '5'))!;
  put(P_A, '5', { phone: phone(6) });
  await webhook([ev(P_A, 'contact.propertyChange', '5', { propertyName: 'phone' })]);
  await sync.drain();
  const lead = await prisma.leads.findUniqueOrThrow({ where: { id: row.lead_id! } });
  assert.equal(lead.normalized_phone, '+15125550105');
  assert.ok((await leadOf(A.orgId, '5'))!.changed_after_review_at);
});

test('the Leads list shows a HubSpot lead once approved, labelled as HubSpot; pending ones stay in Import Review', async () => {
  const leads = await call('/api/v1/leads?limit=200', A.token);
  assert.equal(leads.status, 200, leads.text);
  const byId = new Map(leads.body.map((l: any) => [l.id, l]));
  const approved = byId.get((await leadOf(A.orgId, '1'))!.lead_id!) as any;
  assert.ok(approved, 'an approved HubSpot lead is missing from Leads');
  assert.equal(approved.source?.provider, 'HUBSPOT');
  assert.ok(!byId.has((await leadOf(A.orgId, '7'))!.lead_id!), 'a lead still awaiting review is listed in Leads');
});

test('pending drafts follow HubSpot; a rejected import stays rejected', async () => {
  put(P_A, '7', { firstName: 'Draft', lastName: 'Edited' });
  await webhook([ev(P_A, 'contact.propertyChange', '7', { propertyName: 'firstname' })]);
  await sync.drain();
  const draft = (await leadOf(A.orgId, '7'))!;
  assert.equal(draft.review_state, 'pending');
  assert.equal(draft.leads!.first_name, 'Draft');

  const rejected = await call(`${REVIEW}/reject`, A.token, { method: 'POST', body: { rowIds: [(await leadOf(A.orgId, '8'))!.id] } });
  assert.equal(rejected.body.rejected, 1, rejected.text);
  const lead8 = (await leadOf(A.orgId, '8'))!.leads!;
  assert.equal(lead8.status, 'closed');
  assert.ok(!lead8.review_reasons.includes(IMPORT_REASON));
  put(P_A, '8', { lastName: 'Rejected-edit' });
  await webhook([ev(P_A, 'contact.propertyChange', '8', { propertyName: 'lastname' })]);
  await sync.drain();
  const after = (await leadOf(A.orgId, '8'))!;
  assert.equal(after.leads!.status, 'closed');
  assert.equal(after.leads!.last_name, 'Doe');
});

// =================================================================================
// Deletions, merges, and records gone on either side
// =================================================================================

test('deleted and merged in HubSpot: marked missing, the leads kept; a restore brings them back', async () => {
  store(P_A).delete('9');
  store(P_A).delete('11');
  await webhook([ev(P_A, 'contact.deletion', '9'), ev(P_A, 'contact.merge', '10', { primaryObjectId: 10, mergedObjectIds: [11] })]);
  await sync.drain();
  const nine = (await leadOf(A.orgId, '9'))!;
  assert.ok(nine.missing_since, 'a deleted contact was not marked');
  assert.ok(nine.leads, 'a lead was deleted');
  assert.ok((await leadOf(A.orgId, '11'))!.missing_since);
  assert.equal((await leadOf(A.orgId, '10'))!.missing_since, null);

  put(P_A, '9', { firstName: 'Jane9', lastName: 'Doe', email: email(9), phone: phone(9) });
  await webhook([ev(P_A, 'contact.restore', '9')]);
  await sync.drain();
  assert.equal((await leadOf(A.orgId, '9'))!.missing_since, null);
});

test('a complete re-read marks contacts deleted without a webhook as missing', async () => {
  store(P_A).delete('12');
  const r = await call(`${API}/sync`, A.token, { method: 'POST' });
  await sync.drain();
  const run = await call(`${API}/runs/${r.body.run.id}`, A.token);
  assert.equal(run.body.counts.missing, 1, run.text);
  assert.ok((await leadOf(A.orgId, '12'))!.missing_since);
  assert.equal((await leadOf(A.orgId, '13'))!.missing_since, null);
});

test('a lead deleted here comes back on the next sync as a new lead awaiting review — never a duplicate', async () => {
  const row = (await leadOf(A.orgId, '14'))!;
  await prisma.leads.delete({ where: { id: row.lead_id! } });
  assert.equal((await leadOf(A.orgId, '14'))!.lead_id, null);
  const r = await call(`${API}/sync`, A.token, { method: 'POST' });
  await sync.drain();
  const back = (await leadOf(A.orgId, '14'))!;
  assert.ok(back.lead_id && back.lead_id !== row.lead_id);
  assert.equal(back.review_state, 'pending');
  assert.equal(back.leads!.automation_paused, true);
  assert.equal((await call(`${API}/runs/${r.body.run.id}`, A.token)).body.counts.created, 1);
});

test('reconciliation catches a change whose webhook never arrived', async () => {
  const src = await sourceOf(A.orgId);
  put(P_A, '15', { lastName: 'Missed-webhook' });
  await prisma.lead_sources.update({ where: { id: src.id }, data: { sync_next_at: new Date(Date.now() - 1000) } });
  await sync.drain();
  assert.equal((await leadOf(A.orgId, '15'))!.leads!.last_name, 'Missed-webhook');
  const after = await prisma.lead_sources.findUniqueOrThrow({ where: { id: src.id } });
  assert.ok(after.sync_next_at! > new Date(), 'the next reconciliation was not scheduled');
  assert.ok(Number(after.sync_remote_version) > 0);
});

// =================================================================================
// Tokens
// =================================================================================

test('tokens: concurrent callers share one refresh; a rotated refresh token is kept', async () => {
  const cred = (await credentialOf(A.orgId))!;
  (connections as any).accessTokens.clear();
  const rotated = `rt:${P_A}:rotated`;
  refreshImpl = async () => {
    await new Promise((r) => setTimeout(r, 50));
    return { accessToken: `at:${P_A}:fresh`, refreshToken: rotated, expiresIn: 1800, scopes: ['oauth', 'crm.objects.contacts.read'] };
  };
  const before = calls.refresh;
  try {
    const tokens = await Promise.all(Array.from({ length: 5 }, () => connections.withAccessToken(fake as any, A.orgId, cred.id, async (t) => t)));
    assert.equal(calls.refresh - before, 1, 'concurrent callers refreshed separately');
    assert.ok(tokens.every((t) => t === `at:${P_A}:fresh`));
  } finally {
    refreshImpl = null;
  }
  const after = (await credentialOf(A.orgId))!;
  assert.equal(after.credential_hash, sha256Hex(rotated));
  assert.equal(box.decrypt(after.credential_enc, providerCredentialAad(A.orgId, after.id)), rotated);
});

test('tokens: a refresh token another instance rotated a moment ago is retried with the newer one, not declared dead', async () => {
  const cred = (await credentialOf(A.orgId))!;
  (connections as any).accessTokens.clear();
  const newer = `rt:${P_A}:rotated-elsewhere`;
  refreshImpl = async (rt) => {
    if (rt !== newer) {
      await prisma.provider_credentials.update({
        where: { id: cred.id },
        data: { credential_enc: box.encrypt(newer, providerCredentialAad(A.orgId, cred.id)), credential_hash: sha256Hex(newer) },
      });
      throw new CrmApiError('REAUTH', 'invalid_grant', 400);
    }
    return { accessToken: `at:${P_A}:after-rotation`, refreshToken: newer, expiresIn: 1800, scopes: null };
  };
  try {
    const t = await connections.withAccessToken(fake as any, A.orgId, cred.id, async (token) => token);
    assert.equal(t, `at:${P_A}:after-rotation`);
  } finally {
    refreshImpl = null;
  }
  assert.equal((await credentialOf(A.orgId))!.status, 'ACTIVE');
});

test('a call refused for a missing scope parks the connection once — no retry loop', async () => {
  put(P_A, '20', { lastName: 'Scoped' });
  failRead = new CrmApiError('REAUTH', "MISSING_SCOPES: This app hasn't been granted all required scopes", 403);
  const reads = calls.read;
  await webhook([ev(P_A, 'contact.propertyChange', '20', { propertyName: 'lastname' })]);
  await sync.drain();
  assert.equal(calls.read - reads, 1, 'the refused call was retried in a loop');
  const cred = (await credentialOf(A.orgId))!;
  assert.equal(cred.status, 'INVALID');
  assert.equal(cred.last_error_code, 'CRM_SCOPE_NOT_GRANTED');
  assert.equal((await call(`${API}/status`, A.token)).body.status, 'reauthorization_required');
  assert.equal(await prisma.webhook_events.count({ where: { organization_id: A.orgId, provider: 'HUBSPOT', queue_state: 'PENDING' } }), 1, 'the delivery was not kept for after the reconnect');

  // Reconnecting with the scope granted picks the delivery back up.
  const re = await connect(A, P_A);
  assert.equal(re.status, 200, re.text);
  await sync.drain();
  assert.equal((await leadOf(A.orgId, '20'))!.leads!.last_name, 'Scoped');
});

test('reauthorization: a dead grant parks the connection and fails the run; reconnecting resumes it', async () => {
  (connections as any).accessTokens.clear();
  refreshImpl = async () => {
    throw new CrmApiError('REAUTH', 'HubSpot rejected the grant (invalid_grant)', 400);
  };
  const r = await call(`${API}/sync`, A.token, { method: 'POST' });
  try {
    await sync.drain();
  } finally {
    refreshImpl = null;
  }
  const run = await prisma.crm_sync_runs.findUniqueOrThrow({ where: { id: r.body.run.id } });
  assert.equal(run.status, 'failed');
  assert.equal(run.error_code, 'CRM_REAUTH_REQUIRED');
  const s = await call(`${API}/status`, A.token);
  assert.equal(s.body.status, 'reauthorization_required');
  assert.equal(s.body.lastError.code, 'CRM_REAUTH_REQUIRED');
  assert.ok(await prisma.audit_logs.findFirst({ where: { organization_id: A.orgId, action: 'crm.reauthorization_required' } }));
  const blocked = await call(`${API}/sync`, A.token, { method: 'POST' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'CRM_REAUTH_REQUIRED');

  // Deliveries for a parked connection wait for it.
  put(P_A, '16', { lastName: 'While-parked' });
  const w = await webhook([ev(P_A, 'contact.propertyChange', '16', { propertyName: 'lastname' })]);
  assert.equal(w.body.accepted, 1, w.text);
  await sync.drain();
  assert.notEqual((await leadOf(A.orgId, '16'))!.leads!.last_name, 'While-parked');

  const before = await leadsOf(A.orgId);
  const re = await connect(A, P_A);
  assert.equal(re.status, 200, re.text);
  assert.equal(re.body.status, 'connected');
  assert.equal(re.body.activeRun.kind, 'full');
  await sync.drain();
  assert.equal((await leadOf(A.orgId, '16'))!.leads!.last_name, 'While-parked');
  assert.equal(await leadsOf(A.orgId), before, 'reconnecting duplicated leads');
});

// =================================================================================
// Disconnect and reconnect
// =================================================================================

test('disconnect: syncing stops, the grant is forgotten and handed back, the leads stay', async () => {
  const leads = await leadsOf(A.orgId);
  const src = await sourceOf(A.orgId);
  // Queued work that has not run yet when the owner disconnects.
  await hold(A.orgId);
  put(P_A, '17', { lastName: 'Queued' });
  await webhook([ev(P_A, 'contact.propertyChange', '17', { propertyName: 'lastname' })]);
  const run = await call(`${API}/sync`, A.token, { method: 'POST' });
  const [revoked, uninstalled] = [calls.revoke.length, calls.uninstall];

  const r = await call(`${API}/connection`, A.token, { method: 'DELETE' });
  assert.equal(r.status, 204, r.text);
  await letGo(A.orgId);
  const cred = await prisma.provider_credentials.findFirstOrThrow({ where: { organization_id: A.orgId, provider: 'HUBSPOT' }, orderBy: { updated_at: 'desc' } });
  assert.equal(cred.status, 'REVOKED');
  assert.equal(cred.credential_enc, '');
  assert.ok(cred.revoked_at);
  assert.equal(calls.revoke.length, revoked + 1);
  assert.equal(calls.uninstall, uninstalled + 1);
  const after = await prisma.lead_sources.findUniqueOrThrow({ where: { id: src.id } });
  assert.equal(after.is_active, false);
  assert.equal(after.sync_next_at, null);
  assert.equal((await prisma.crm_sync_runs.findUniqueOrThrow({ where: { id: run.body.run.id } })).status, 'cancelled');
  assert.equal(await prisma.webhook_events.count({ where: { organization_id: A.orgId, provider: 'HUBSPOT', queue_state: 'PENDING' } }), 0);
  assert.equal(await leadsOf(A.orgId), leads, 'disconnecting deleted leads');
  assert.ok(await prisma.audit_logs.findFirst({ where: { organization_id: A.orgId, action: 'crm.disconnected', actor_id: A.userId } }));

  const s = await call(`${API}/status`, A.token);
  assert.equal(s.body.status, 'disconnected');
  assert.equal((await call(`${API}/sync`, A.token, { method: 'POST' })).status, 409);
  assert.equal((await call(`${API}/connection`, A.token, { method: 'DELETE' })).status, 404);

  // HubSpot keeps nothing flowing in: a late delivery is dropped.
  const late = await webhook([ev(P_A, 'contact.propertyChange', '17', { propertyName: 'lastname' })]);
  assert.equal(late.status, 200);
  assert.equal(late.body.ignored, 1);
  await sync.drain();
  assert.notEqual((await leadOf(A.orgId, '17'))!.leads!.last_name, 'Queued');
});

test('reconnect after a disconnect: the same source and tracking rows carry on — no duplicates — and the account can now move', async () => {
  const leads = await leadsOf(A.orgId);
  const src = await sourceOf(A.orgId);
  const r = await connect(A, P_A);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.sourceId, src.id);
  await sync.drain();
  assert.equal(await leadsOf(A.orgId), leads);
  assert.equal((await leadOf(A.orgId, '17'))!.leads!.last_name, 'Queued');
  assert.equal(await prisma.lead_sources.count({ where: { organization_id: A.orgId, provider: 'HUBSPOT' } }), 1);

  // Once A lets go of it, the account may be connected elsewhere — never silently.
  assert.equal((await call(`${API}/connection`, A.token, { method: 'DELETE' })).status, 204);
  const moved = await connect(B, P_A);
  assert.equal(moved.status, 200, moved.text);
  await sync.drain();
  // B's leads are B's: imported fresh, with nothing of A's linked or reached.
  assert.equal(await prisma.leads.count({ where: { organization_id: B.orgId } }), store(P_A).size - 1);
  assert.equal(await prisma.sheet_import_rows.count({ where: { organization_id: B.orgId, lead_id: { in: Object.values(existing) } } }), 0);
});

test('switched off (HUBSPOT_ENABLED not 1): the webhook answers 404 and the worker does nothing', async () => {
  const off = new CrmRegistry(fake as unknown as HubSpotClient, new ConfigService({ HUBSPOT_ENABLED: '0' }));
  const controller = new CrmWebhooksController(off, app.get(CrmWebhooksService));
  let status = 0;
  const res: any = { status: (s: number) => ((status = s), res), json: () => res, set: () => res };
  await controller.hubspot({ method: 'POST', originalUrl: WEBHOOK_PATH, rawBody: Buffer.from('[]'), headers: {} } as any, res);
  assert.equal(status, 404);

  const idle = new CrmSyncService(app.get(PrismaService), app.get<GuardedPrisma>(TENANT_PRISMA), connections, off, app.get(SheetImportService), app.get(EventsBus), app.get(ConfigService));
  idle.claimOnly([A.orgId, B.orgId]);
  const src = await sourceOf(B.orgId);
  await prisma.lead_sources.update({ where: { id: src.id }, data: { sync_next_at: new Date(Date.now() - 1000) } });
  const before = { list: calls.list, read: calls.read, refresh: calls.refresh };
  await idle.drain();
  assert.deepEqual({ list: calls.list, read: calls.read, refresh: calls.refresh }, before, 'a switched-off worker called HubSpot');
  await prisma.lead_sources.update({ where: { id: src.id }, data: { sync_next_at: null } });
});

// =================================================================================
// The database itself
// =================================================================================

test('the database refuses a second active run, and an account live in two organizations', async () => {
  const srcB = await sourceOf(B.orgId);
  await prisma.crm_sync_runs.create({ data: { id: randomUUID(), organization_id: B.orgId, lead_source_id: srcB.id, provider: 'HUBSPOT', kind: 'full' } });
  await assert.rejects(
    prisma.crm_sync_runs.create({ data: { id: randomUUID(), organization_id: B.orgId, lead_source_id: srcB.id, provider: 'HUBSPOT', kind: 'full' } }),
    (e: any) => e.code === 'P2002',
  );
  await prisma.crm_sync_runs.updateMany({ where: { organization_id: B.orgId, status: 'queued' }, data: { status: 'cancelled', finished_at: new Date() } });

  await assert.rejects(
    prisma.provider_credentials.create({
      data: {
        id: randomUUID(),
        organization_id: A.orgId,
        provider: 'HUBSPOT',
        credential_enc: 'x',
        credential_hash: 'y'.repeat(64),
        credential_prefix: 'oauth',
        credential_last4: '',
        external_account_id: P_A,
      },
    }),
    (e: any) => e.code === 'P2002',
  );
  await assert.rejects(
    prisma.crm_sync_runs.create({ data: { id: randomUUID(), organization_id: B.orgId, lead_source_id: srcB.id, provider: 'HUBSPOT', kind: 'weekly' } }),
    (e: any) => /crm_sync_runs_kind_check/.test(String(e.message)),
  );
});
