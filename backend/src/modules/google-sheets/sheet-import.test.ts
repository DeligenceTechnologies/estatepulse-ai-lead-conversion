import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuthModule } from '../../auth/auth.module';
import { envSchema } from '../../app.module';
import { SecretBox, providerCredentialAad } from '../../common/crypto';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { newId } from '../../common/ids';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService, TENANT_PRISMA, type GuardedPrisma } from '../../prisma/prisma.service';
import { EventsBus } from '../events/events.bus';
import { AgentsModule } from '../agents/agents.module';
import { EventsModule } from '../events/events.module';
import { LeadsModule } from '../leads/leads.module';
import { GoogleConnectionsService } from './google-connections.service';
import { DRIVE_FILE_SCOPE, GoogleApiError, GoogleClient, SPREADSHEET_MIME } from './google.client';
import { GoogleSheetsModule } from './google-sheets.module';
import { SheetImportService } from './sheet-import.service';
import { REJECTED_REASON } from './sheet-review.service';
import { IMPORT_REVIEW_REASON, PHONE_UNPARSED_REASON } from './sheet-rows';
import { SheetsEnabledGuard } from './sheets-enabled.guard';

/**
 * Integration suite for Google Sheets import and review, against the REAL
 * database with a FAKE Google. Run with `npm run test:sheet-import`.
 *
 * The fake behaves like the Sheets API where it matters: it omits trailing
 * empty rows inside a requested range, and the Drive version moves on every
 * edit. No real SMS or call can happen: the outreach pollers are off, and the
 * outreach engine is not part of this module.
 */
process.env['STRATEGY_ENGINE'] = '0';
process.env['CALENDAR_SYNC'] = '0';
process.env['WORKER_ENABLED'] = 'false';
delete process.env['SHEETS_SYNC'];
// The rollout flag: this suite exercises the feature switched on.
process.env['GOOGLE_SHEETS_ENABLED'] = '1';
// Creating an agent sends a credentials email only when SMTP is configured.
delete process.env['SMTP_HOST'];
delete process.env['SHEETS_VERSION_PROBE'];

/* eslint-disable @typescript-eslint/no-explicit-any */

const RUN = Date.now().toString(36);
const PASSWORD = 'correct-horse-battery-staple';
const SHEET = `sheetimport${RUN}abcdefghij`;
const BIG_SHEET = `sheetimportbig${RUN}abcdefgh`;
const MID_SHEET = `sheetimportmid${RUN}abcdefgh`;
const HEADER = ['Lead ID', 'Name', 'Phone', 'Email', 'Location', 'Budget', 'Beds', 'Notes'];
const PHONE = 2;
const NOTES = 7;

// --- the fake Google -------------------------------------------------------------

interface FakeTab {
  sheetId: number;
  title: string;
  rowCount: number;
  columnCount: number;
  grid: string[][];
}
const files = new Map<string, { title: string; version: number; tabs: FakeTab[] }>();
const calls = { driveFile: 0, spreadsheet: 0, readGrid: 0 };
/** Make the NEXT data read (not the header) fail, once, with this error. */
let failNextDataRead: GoogleApiError | null = null;
let refreshFails: GoogleApiError | null = null;
/** The Google account the next authorization code belongs to. */
let grantSub = '';
/** An id token as Google signs it; only its claims are read. */
function idTokenFor(sub: string): string {
  const claims = { aud: 'test-client', iss: 'https://accounts.google.com', exp: Math.floor(Date.now() / 1000) + 3600, sub, email: 'owner@example.test' };
  return `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
}
/** Files the owner has withdrawn this app's access to. */
const denied = new Set<string>();

const google = {
  clientId: 'test-client',
  isConfigured: () => true,
  pickerConfig: () => ({ apiKey: null, appId: null }),
  authorizeUrl: (state: string) => `https://accounts.google.test/o/oauth2/v2/auth?state=${state}`,
  refresh: async () => {
    if (refreshFails) throw refreshFails;
    return { accessToken: `fake-access-${Date.now()}`, expiresIn: 3600, refreshToken: null, scope: DRIVE_FILE_SCOPE, idToken: null };
  },
  revoke: async () => undefined,
  /** What Google returns for an authorization code: a fresh grant for `grantSub`. */
  exchangeCode: async () => ({
    accessToken: `fake-access-${Date.now()}`,
    expiresIn: 3600,
    refreshToken: `fake-refresh-${Date.now()}`,
    scope: `openid email ${DRIVE_FILE_SCOPE}`,
    idToken: idTokenFor(grantSub),
  }),
  driveFile: async (_t: string, id: string) => {
    calls.driveFile += 1;
    const f = files.get(id);
    if (!f) throw new GoogleApiError('NOT_FOUND', 'File not found', 404);
    if (denied.has(id)) throw new GoogleApiError('DENIED', 'The caller does not have permission', 403);
    return { id, name: f.title, mimeType: SPREADSHEET_MIME, version: String(f.version), trashed: false };
  },
  spreadsheet: async (_t: string, id: string) => {
    calls.spreadsheet += 1;
    const f = files.get(id)!;
    return {
      spreadsheetId: id,
      properties: { title: f.title },
      sheets: f.tabs.map((t, index) => ({
        properties: { sheetId: t.sheetId, title: t.title, index, gridProperties: { rowCount: t.rowCount, columnCount: t.columnCount } },
      })),
    };
  },
  readGrid: async (_t: string, id: string, sheetId: number, rows: number, columns: number, startRow = 0) => {
    calls.readGrid += 1;
    if (startRow > 0 && failNextDataRead) {
      const e = failNextDataRead;
      failNextDataRead = null;
      throw e;
    }
    const tab = files.get(id)!.tabs.find((x) => x.sheetId === sheetId)!;
    const out = tab.grid.slice(startRow, startRow + rows).map((r) => {
      const cells = r.slice(0, columns);
      while (cells.length && !cells[cells.length - 1]) cells.pop();
      return cells;
    });
    while (out.length && out[out.length - 1].length === 0) out.pop();
    return out;
  },
};

const grid = () => files.get(SHEET)!.tabs[0].grid;
/** Edit like a person would: the Drive version moves. */
function edit(fn: (g: string[][]) => void): void {
  fn(grid());
  files.get(SHEET)!.version += 1;
}
const rowOf = (id: string) => grid().findIndex((r) => r[0] === id);

const pad = (n: number) => String(n).padStart(2, '0');
const email = (n: number) => `sheet.${n}.${RUN}@example.test`;

/** 100 data rows: 95 importable, and one of each refusal. */
function hundredRows(): string[][] {
  const rows: string[][] = [];
  for (let n = 1; n <= 90; n++) {
    rows.push([`EP-${n}`, `Test${n} Lead`, `512-555-01${pad(n)}`, email(n), 'Austin TX', '$300,000 - $450,000', '3', `note ${n}`]);
  }
  rows.push(['', '', '', '', '', '', '', '']); // 91 blank
  rows.push(['EP-92', 'No Contact', 'n/a', 'none', '', '', '', '']); // 92 NO_CONTACT
  rows.push(['EP-93', '', '512-555-0193', email(93), '', '', '', '']); // 93 NO_NAME
  rows.push(['', 'No Id', '512-555-0194', email(94), '', '', '', '']); // 94 NO_ROW_ID
  rows.push(['EP-1', 'Dup Id', '512-555-0195', email(95), '', '', '', '']); // 95 DUPLICATE_IN_SHEET
  rows.push(['EP-96', 'Opted Out', '512-555-0196', email(96), '', '', '', '']); // 96 matches a DNC lead
  rows.push(['EP-97', 'Same Phone', '512-555-0101', email(97), '', '', '', '']); // 97 same phone as row 1
  rows.push(['EP-98', 'Bad Phone', '12345', email(98), '', '', '', '']); // 98 unparseable phone
  rows.push(['EP-99', 'Test99 Lead', '512-555-0191', email(99), '', '', '', '']);
  rows.push(['EP-100', 'Test100 Lead', '512-555-0192', email(100), '', '', '', '']);
  return rows;
}

function simpleRows(count: number, prefix: string): string[][] {
  return Array.from({ length: count }, (_, i) => [`${prefix}-${i + 1}`, `Bulk ${i + 1}`, '', `${prefix}.${i + 1}.${RUN}@example.test`]);
}

// --- harness --------------------------------------------------------------------

let app: INestApplication;
let prisma: PrismaService;
let importer: SheetImportService;
let base: string;
const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];

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
    body: { email: `sheet-import-${RUN}-${tag}@example.invalid`, password: PASSWORD, firstName: 'Own', lastName: 'Er', organizationName: `SheetImport ${tag} ${RUN}` },
  });
  assert.equal(res.status, 201, res.text);
  createdUserIds.push(res.body.user.id);
  createdOrgIds.push(res.body.organization.id);
  return { token: res.body.token as string, orgId: res.body.organization.id as string };
}

/** A Google connection as Phase 1 would have stored it: the refresh token encrypted to its row. */
async function googleConnection(orgId: string): Promise<string> {
  const id = newId();
  const box = new SecretBox(process.env['ENCRYPTION_KEYS']!, process.env['ENCRYPTION_ACTIVE_KEY_ID']!);
  await prisma.provider_credentials.create({
    data: {
      id,
      organization_id: orgId,
      provider: 'GOOGLE',
      label: 'test',
      credential_enc: box.encrypt('fake-refresh-token', providerCredentialAad(orgId, id)),
      credential_hash: 'x'.repeat(64),
      credential_prefix: 'oauth',
      credential_last4: '',
      external_account_id: `sub-${RUN}`,
      account_email: 'owner@example.test',
      status: 'ACTIVE',
    },
  });
  return id;
}

const API = '/api/integrations/google-sheets';

/** Ask for a sync and wait until every due source has been processed. */
async function syncNow(token: string, id: string): Promise<void> {
  const r = await call(`${API}/sources/${id}/sync`, token, { method: 'POST' });
  assert.equal(r.status, 202, r.text);
  await importer.drain();
}

/** The newest recorded run (eventful runs and failures are recorded). */
async function lastRun(token: string, id: string): Promise<any> {
  const r = await call(`${API}/sources/${id}/runs`, token);
  assert.equal(r.status, 200, r.text);
  return { count: r.body.runs.length, run: r.body.runs[0] };
}

async function source(token: string, id: string): Promise<any> {
  const list = await call(`${API}/sources`, token);
  return list.body.sources.find((s: any) => s.id === id);
}

const tracking = (orgId: string, id: string) =>
  prisma.sheet_import_rows.findMany({ where: { organization_id: orgId, lead_source_id: id }, include: { leads: true } });

const MAPPING = {
  columns: [
    { fieldKey: 'name', target: 'full_name' },
    { fieldKey: 'phone', target: 'phone' },
    { fieldKey: 'email', target: 'email' },
    { fieldKey: 'location', target: 'location' },
    { fieldKey: 'budget', target: 'min_budget' },
    { fieldKey: 'budget', target: 'max_budget' },
    { fieldKey: 'beds', target: 'bedrooms' },
    { fieldKey: 'notes', target: '__custom__' },
  ],
  identity: { mode: 'column', fieldKey: 'lead id' },
};

let A = { token: '', orgId: '' };
let B = { token: '', orgId: '' };
let connectionA = '';
let sourceId = '';
/** row id by the sheet's Lead ID, filled after the first import. */
const rowIdOf = new Map<string, string>();
const leadIdOf = new Map<string, string>();

before(async () => {
  files.set(SHEET, {
    title: 'Test Leads',
    version: 1,
    tabs: [{ sheetId: 0, title: 'Leads', rowCount: 1000, columnCount: 10, grid: [HEADER, ...hundredRows()] }],
  });

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, validate: (raw) => ({ ...raw, ...envSchema.parse(raw) }) }),
      PrismaModule,
      EventsModule,
      AuthModule,
      AgentsModule,
      LeadsModule,
      GoogleSheetsModule,
    ],
  })
    .overrideProvider(GoogleClient)
    .useValue(google)
    .compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  prisma = app.get(PrismaService);
  importer = app.get(SheetImportService);

  A = await signupOwner('a');
  B = await signupOwner('b');
  connectionA = await googleConnection(A.orgId);

  // Someone who already opted out, on another record.
  await prisma.leads.create({
    data: { organization_id: A.orgId, first_name: 'Opted', phone: '+15125550196', normalized_phone: '+15125550196', dnc_status: true, status: 'not_interested' },
  });
});

after(async () => {
  try {
    for (const orgId of createdOrgIds) {
      await prisma.sheet_import_rows.deleteMany({ where: { organization_id: orgId } });
      await prisma.leads.deleteMany({ where: { organization_id: orgId } });
      await prisma.lead_sources.deleteMany({ where: { organization_id: orgId } });
      await prisma.provider_credentials.deleteMany({ where: { organization_id: orgId } });
    }
    await prisma.users.deleteMany({ where: { id: { in: createdUserIds } } });
    // Organizations with audit rows stay: the audit log is immutable (see agent-me.test.ts).
  } finally {
    await app.close();
  }
});

// =================================================================================
// Phase 4 — source, preview, mapping, first import
// =================================================================================

test('another organization cannot use this connection to create a source', async () => {
  const r = await call(`${API}/sources`, B.token, { method: 'POST', body: { connectionId: connectionA, spreadsheetId: SHEET, sheetId: 0 } });
  assert.equal(r.status, 404, r.text);
  assert.equal(r.body.error.code, 'GOOGLE_CONNECTION_NOT_FOUND');
});

test('create a source for a tab; asking twice returns the same one', async () => {
  const r = await call(`${API}/sources`, A.token, { method: 'POST', body: { connectionId: connectionA, spreadsheetId: SHEET, sheetId: 0 } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.status, 'NEEDS_MAPPING');
  sourceId = r.body.id;
  const again = await call(`${API}/sources`, A.token, { method: 'POST', body: { connectionId: connectionA, spreadsheetId: SHEET, sheetId: 0 } });
  assert.equal(again.body.id, sourceId);
});

test('preview suggests a mapping and an identity column, and writes nothing', async () => {
  const before = await prisma.leads.count({ where: { organization_id: A.orgId } });
  const r = await call(`${API}/sources/${sourceId}/preview`, A.token);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.headers.length, HEADER.length);
  assert.equal(r.body.mapping.saved, false);
  const targets = r.body.mapping.columns.map((c: any) => `${c.fieldKey}>${c.target}`);
  for (const t of ['name>full_name', 'phone>phone', 'email>email']) assert.ok(targets.includes(t), `missing suggestion ${t}: ${targets}`);
  assert.deepEqual(r.body.identityCandidates, ['lead id']);
  assert.equal(r.body.rows.length, 20);
  assert.equal(r.body.rows[0].lead.normalized_phone, '+15125550101');
  assert.equal(await prisma.leads.count({ where: { organization_id: A.orgId } }), before);
  assert.equal(await prisma.sheet_import_rows.count({ where: { organization_id: A.orgId } }), 0);
});

test('a source cannot be switched on before it is mapped; a mapping without contact columns is refused', async () => {
  const early = await call(`${API}/sources/${sourceId}/enable`, A.token, { method: 'POST' });
  assert.equal(early.status, 409, early.text);
  assert.equal(early.body.error.code, 'MAPPING_REQUIRED');
  const bad = await call(`${API}/sources/${sourceId}/mapping`, A.token, {
    method: 'PUT',
    body: { columns: [{ fieldKey: 'name', target: 'full_name' }], identity: { mode: 'column', fieldKey: 'lead id' } },
  });
  assert.equal(bad.status, 400, bad.text);
  assert.ok(bad.body.error.details.some((d: any) => /phone or email/.test(d.message)), bad.text);
});

test('save the mapping', async () => {
  const r = await call(`${API}/sources/${sourceId}/mapping`, A.token, { method: 'PUT', body: MAPPING });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.mappingStatus, 'CONFIGURED');
  assert.equal(r.body.status, 'PAUSED');
});

test('first import: every importable row becomes a paused lead awaiting review', async () => {
  const on = await call(`${API}/sources/${sourceId}/enable`, A.token, { method: 'POST' });
  assert.equal(on.status, 200, on.text);
  await importer.drain();
  const { run } = await lastRun(A.token, sourceId);
  assert.equal(run.ok, true, JSON.stringify(run));
  const s = run.summary;
  assert.equal(s.rowsRead, 100);
  assert.equal(s.blank, 1);
  assert.equal(s.inserted, 95);
  assert.deepEqual(s.skipped, { NO_CONTACT: 1, NO_NAME: 1, NO_ROW_ID: 1, DUPLICATE_IN_SHEET: 1 });
  assert.equal(s.dncInherited, 1);
  assert.equal(s.possibleDuplicates, 2);
  // Drive, tab metadata, header, ONE data chunk.
  assert.equal(s.googleRequests, 4);
  // source, mappings, org, tracked rows; then the batch: contacts, two inserts.
  assert.equal(s.dbStatements, 7);
  assert.deepEqual(
    s.errorSample.map((e: any) => `${e.row}:${e.code}`).sort(),
    ['93:NO_CONTACT', '94:NO_NAME', '95:NO_ROW_ID', '96:DUPLICATE_IN_SHEET'].sort(),
  );
  assert.ok(!JSON.stringify(run).includes('@example.test'), 'run summary leaked an email');
  assert.ok(!JSON.stringify(run).includes('512-555'), 'run summary leaked a phone');

  const rows = await tracking(A.orgId, sourceId);
  assert.equal(rows.length, 95);
  for (const r of rows) {
    const l = r.leads!;
    assert.equal(r.review_state, 'pending');
    assert.equal(l.status, 'new');
    assert.equal(l.automation_paused, true, 'an imported lead is not paused');
    assert.equal(l.review_reasons[0], IMPORT_REVIEW_REASON);
    assert.equal(l.first_contact_at, null);
    rowIdOf.set(l.external_lead_id!, r.id);
    leadIdOf.set(l.external_lead_id!, l.id);
  }
  const byId = new Map(rows.map((r) => [r.leads!.external_lead_id, r.leads!]));
  assert.equal(byId.get('EP-1')!.normalized_phone, '+15125550101');
  assert.equal(byId.get('EP-1')!.first_name, 'Test1');
  assert.equal(Number(byId.get('EP-1')!.min_budget), 300000);
  assert.deepEqual(byId.get('EP-1')!.custom_fields, { Notes: 'note 1' });
  assert.equal(byId.get('EP-96')!.dnc_status, true, 'a previously opted-out contact must stay opted out');
  assert.ok(byId.get('EP-97')!.review_reasons.some((r) => /Possible duplicate/.test(r)));
  assert.ok(byId.get('EP-98')!.review_reasons.includes(PHONE_UNPARSED_REASON));
});

test('no imported lead is visible to the outreach watcher', async () => {
  const eligible = await prisma.leads.count({
    where: { organization_id: A.orgId, lead_source_id: sourceId, status: 'new', automation_paused: false, dnc_status: false, first_contact_at: null },
  });
  assert.equal(eligible, 0);
});

test('review queue: paginated, complete, without overlap', async () => {
  const p1 = await call(`${API}/review?limit=50&sourceId=${sourceId}`, A.token);
  assert.equal(p1.status, 200, p1.text);
  assert.equal(p1.body.total, 95);
  assert.equal(p1.body.items.length, 50);
  const p2 = await call(`${API}/review?limit=50&sourceId=${sourceId}&cursor=${p1.body.nextCursor}`, A.token);
  assert.equal(p2.body.items.length, 45);
  assert.equal(p2.body.nextCursor, null);
  assert.equal(new Set([...p1.body.items, ...p2.body.items].map((i: any) => i.rowId)).size, 95);
});

test('another organization sees none of it', async () => {
  const q = await call(`${API}/review`, B.token);
  assert.equal(q.body.total, 0);
  assert.equal((await call(`${API}/sources/${sourceId}/preview`, B.token)).status, 404);
  assert.equal((await call(`${API}/sources/${sourceId}/runs`, B.token)).status, 404);
  assert.equal((await call(`${API}/sources/${sourceId}/sync`, B.token, { method: 'POST' })).status, 404);
  assert.equal((await call(`${API}/review/changes?sourceId=${sourceId}`, B.token)).body.items.length, 0);
});

test('owner only: an agent of the same organization is refused everywhere, and no token is refused first', async () => {
  const agentEmail = `sheet-import-${RUN}-agent@example.invalid`;
  const created = await call('/api/agents', A.token, { method: 'POST', body: { email: agentEmail, password: PASSWORD, firstName: 'Ag', lastName: 'Ent' } });
  assert.equal(created.status, 201, created.text);
  createdUserIds.push(created.body.id);
  const login = await call('/api/auth/login', undefined, { method: 'POST', body: { email: agentEmail, password: PASSWORD } });
  assert.equal(login.status, 200, login.text);
  assert.equal(login.body.role, 'agent');

  const routes: [string, string, unknown?][] = [
    ['GET', `${API}/config`],
    ['GET', `${API}/connections`],
    ['POST', `${API}/oauth/start`],
    ['GET', `${API}/sources`],
    ['GET', `${API}/sources/${sourceId}/preview`],
    ['POST', `${API}/sources/${sourceId}/sync`],
    ['GET', `${API}/review`],
    ['POST', `${API}/review/approve`, { rowIds: [rowIdOf.get('EP-4')!] }],
    ['POST', `${API}/review/reject`, { rowIds: [rowIdOf.get('EP-4')!] }],
    ['GET', `${API}/review/changes?sourceId=${sourceId}`],
  ];
  for (const [method, path, body] of routes) {
    const asAgent = await call(path, login.body.token, { method, body });
    assert.equal(asAgent.status, 403, `${method} ${path} as agent: ${asAgent.text}`);
    const anonymous = await call(path, undefined, { method, body });
    assert.equal(anonymous.status, 401, `${method} ${path} without a token: ${anonymous.text}`);
  }
  const row = await prisma.sheet_import_rows.findUniqueOrThrow({ where: { id: rowIdOf.get('EP-4')! } });
  assert.equal(row.review_state, 'pending', 'an agent decided an import');
});

test('OAuth: a state is honoured only by the session that started it', async () => {
  const started = await call(`${API}/oauth/start`, A.token, { method: 'POST' });
  assert.equal(started.status, 200, started.text);
  const state: string = started.body.state;
  const finish = (token: string, st: string) => call(`${API}/oauth/complete`, token, { method: 'POST', body: { code: 'fake-authorization-code', state: st } });

  const otherOrg = await finish(B.token, state);
  assert.equal(otherOrg.status, 403, otherOrg.text);
  assert.equal(otherOrg.body.error.code, 'OAUTH_SESSION_MISMATCH');

  // The same owner, signed in a second time: a different session.
  const again = await call('/api/auth/login', undefined, { method: 'POST', body: { email: `sheet-import-${RUN}-a@example.invalid`, password: PASSWORD } });
  assert.equal(again.status, 200, again.text);
  const otherSession = await finish(again.body.token, state);
  assert.equal(otherSession.status, 403, otherSession.text);
  assert.equal(otherSession.body.error.code, 'OAUTH_SESSION_MISMATCH');

  const mid = Math.floor(state.length / 2);
  const forged = await finish(A.token, state.slice(0, mid) + (state[mid] === 'A' ? 'B' : 'A') + state.slice(mid + 1));
  assert.equal(forged.status, 400, forged.text);
  assert.equal(forged.body.error.code, 'OAUTH_STATE_INVALID');
});

test('running the same import again creates nothing, and records no run', async () => {
  const before = await source(A.token, sourceId);
  await syncNow(A.token, sourceId);
  const after = await source(A.token, sourceId);
  assert.ok(new Date(after.lastSuccessAt) > new Date(before.lastSuccessAt), 'no new successful sync');
  assert.equal((await lastRun(A.token, sourceId)).count, 1, 'a quiet run must not add to the immutable audit log');
  assert.equal(await prisma.sheet_import_rows.count({ where: { organization_id: A.orgId, lead_source_id: sourceId } }), 95);
});

test('a pending row edited in the sheet refreshes its draft lead — and two workers at once run it exactly once', async () => {
  edit((g) => (g[rowOf('EP-3')][NOTES] = 'note 3 edited'));
  await prisma.lead_sources.update({ where: { id: sourceId }, data: { sync_next_at: new Date() } });
  const second = new SheetImportService(
    app.get(PrismaService),
    app.get<GuardedPrisma>(TENANT_PRISMA),
    app.get(GoogleConnectionsService),
    google as unknown as GoogleClient,
    app.get(EventsBus),
    app.get(ConfigService),
  );
  await Promise.all([importer.drain(), second.drain()]);
  const { count, run } = await lastRun(A.token, sourceId);
  assert.equal(count, 2, 'exactly one eventful run');
  assert.equal(run.summary.updated, 1);
  assert.equal(run.summary.inserted, 0);
  const lead = await prisma.leads.findUniqueOrThrow({ where: { id: leadIdOf.get('EP-3')! } });
  assert.deepEqual(lead.custom_fields, { Notes: 'note 3 edited' });
  assert.equal(lead.automation_paused, true);
});

test('the row identity cannot change once rows are imported', async () => {
  const r = await call(`${API}/sources/${sourceId}/mapping`, A.token, {
    method: 'PUT',
    body: { ...MAPPING, identity: { mode: 'fallback', acknowledged: true } },
  });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.body.error.code, 'IDENTITY_LOCKED');
});

// =================================================================================
// Phase 5 — review decisions
// =================================================================================

test('approve: lifts the import pause only where nothing else holds the lead', async () => {
  const ids = ['EP-1', 'EP-96', 'EP-98'].map((x) => rowIdOf.get(x)!);
  const r = await call(`${API}/review/approve`, A.token, { method: 'POST', body: { rowIds: ids } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.approved, 3);
  assert.equal(r.body.released, 1);
  const held = Object.fromEntries(r.body.held.map((h: any) => [h.rowId, h.reason]));
  assert.equal(held[rowIdOf.get('EP-96')!], 'DO_NOT_CONTACT');
  assert.equal(held[rowIdOf.get('EP-98')!], 'NO_DIALABLE_PHONE');

  const ep1 = await prisma.leads.findUniqueOrThrow({ where: { id: leadIdOf.get('EP-1')! } });
  assert.equal(ep1.automation_paused, false);
  assert.equal(ep1.status, 'new');
  assert.equal(ep1.first_contact_at, null, 'approval must not contact anyone itself');
  assert.ok(!ep1.review_reasons.includes(IMPORT_REVIEW_REASON));
  const ep96 = await prisma.leads.findUniqueOrThrow({ where: { id: leadIdOf.get('EP-96')! } });
  assert.equal(ep96.automation_paused, true);

  // Exactly the one released lead is now what the outreach watcher would select.
  const eligible = await prisma.leads.findMany({
    where: { organization_id: A.orgId, lead_source_id: sourceId, status: 'new', automation_paused: false, dnc_status: false, first_contact_at: null },
    select: { id: true },
  });
  assert.deepEqual(eligible.map((e) => e.id), [leadIdOf.get('EP-1')]);

  const audits = await prisma.audit_logs.count({ where: { organization_id: A.orgId, action: 'sheet_import.approved' } });
  assert.equal(audits, 3);
});

test('approve is idempotent, and ignores rows of another organization', async () => {
  const again = await call(`${API}/review/approve`, A.token, { method: 'POST', body: { rowIds: [rowIdOf.get('EP-1')!] } });
  assert.equal(again.body.approved, 0);
  assert.deepEqual(again.body.skipped, [rowIdOf.get('EP-1')]);
  const cross = await call(`${API}/review/approve`, B.token, { method: 'POST', body: { rowIds: [rowIdOf.get('EP-4')!] } });
  assert.equal(cross.body.approved, 0);
  const row = await prisma.sheet_import_rows.findUniqueOrThrow({ where: { id: rowIdOf.get('EP-4')! } });
  assert.equal(row.review_state, 'pending');
});

test('reject: the lead closes and stays paused', async () => {
  const r = await call(`${API}/review/reject`, A.token, { method: 'POST', body: { rowIds: [rowIdOf.get('EP-2')!] } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.rejected, 1);
  const lead = await prisma.leads.findUniqueOrThrow({ where: { id: leadIdOf.get('EP-2')! } });
  assert.equal(lead.status, 'closed');
  assert.equal(lead.lost_reason, REJECTED_REASON);
  assert.equal(lead.automation_paused, true);
  const twice = await call(`${API}/review/reject`, A.token, { method: 'POST', body: { rowIds: [rowIdOf.get('EP-2')!] } });
  assert.equal(twice.body.rejected, 0);
});

test('the Leads list shows an import only once approved; rejected ones stay in Import Review', async () => {
  const leads = await call('/api/v1/leads?limit=200', A.token);
  assert.equal(leads.status, 200, leads.text);
  const ids = new Set(leads.body.map((l: any) => l.id));
  assert.ok(ids.has(leadIdOf.get('EP-1')), 'an approved import is missing from Leads');
  assert.ok(!ids.has(leadIdOf.get('EP-4')), 'a pending import is listed in Leads');
  assert.ok(!ids.has(leadIdOf.get('EP-2')), 'a rejected import is listed in Leads');
  assert.ok(leads.body.some((l: any) => l.firstName === 'Opted'), 'a lead from another source is missing');
  // Approved so far: EP-1, EP-96, EP-98 — plus the one lead from elsewhere.
  assert.equal(leads.body.length, 4);
  const stats = await call('/api/v1/leads/stats', A.token);
  assert.equal(stats.body.total, 4);

  const rejected = await call(`${API}/review?state=rejected&sourceId=${sourceId}`, A.token);
  assert.equal(rejected.status, 200, rejected.text);
  assert.equal(rejected.body.total, 1);
  assert.equal(rejected.body.items[0].rowId, rowIdOf.get('EP-2'));
  assert.ok(rejected.body.items[0].reviewedAt);
});

test('decisions are bounded and validated', async () => {
  const many = Array.from({ length: 501 }, () => newId());
  assert.equal((await call(`${API}/review/approve`, A.token, { method: 'POST', body: { rowIds: many } })).status, 400);
  const dup = rowIdOf.get('EP-5')!;
  assert.equal((await call(`${API}/review/approve`, A.token, { method: 'POST', body: { rowIds: [dup, dup] } })).status, 400);
});

// =================================================================================
// Phase 5 — the sheet changes after review
// =================================================================================

test('an approved row edited in the sheet is flagged, and the lead is NOT overwritten', async () => {
  edit((g) => (g[rowOf('EP-1')][PHONE] = '512-555-0177'));
  await syncNow(A.token, sourceId);
  const { run } = await lastRun(A.token, sourceId);
  assert.equal(run.summary.flagged, 1);
  const lead = await prisma.leads.findUniqueOrThrow({ where: { id: leadIdOf.get('EP-1')! } });
  assert.equal(lead.normalized_phone, '+15125550101', 'a reviewed lead was overwritten');

  const changes = await call(`${API}/review/changes?sourceId=${sourceId}`, A.token);
  assert.equal(changes.status, 200, changes.text);
  assert.equal(changes.body.items.length, 1);
  assert.deepEqual(changes.body.items[0].diff.find((d: any) => d.field === 'phone'), { field: 'phone', current: '+15125550101', incoming: '+15125550177' });
});

test('putting the value back clears the flag on its own', async () => {
  edit((g) => (g[rowOf('EP-1')][PHONE] = '512-555-0101'));
  await syncNow(A.token, sourceId);
  assert.equal((await lastRun(A.token, sourceId)).run.summary.flagsCleared, 1);
  assert.equal((await call(`${API}/review/changes?sourceId=${sourceId}`, A.token)).body.items.length, 0);
});

test('keep: the lead stays as reviewed, and the same change is not raised again', async () => {
  edit((g) => (g[rowOf('EP-1')][NOTES] = 'kept note'));
  await syncNow(A.token, sourceId);
  const r = await call(`${API}/review/changes/resolve`, A.token, { method: 'POST', body: { rowIds: [rowIdOf.get('EP-1')!], action: 'keep' } });
  assert.equal(r.body.resolved, 1);
  const lead = await prisma.leads.findUniqueOrThrow({ where: { id: leadIdOf.get('EP-1')! } });
  assert.deepEqual(lead.custom_fields, { Notes: 'note 1' });
  const before = (await lastRun(A.token, sourceId)).count;
  await syncNow(A.token, sourceId);
  assert.equal((await lastRun(A.token, sourceId)).count, before, 'the kept change was raised again');
});

test('apply: the sheet values land on the lead; its status and pause are untouched', async () => {
  edit((g) => (g[rowOf('EP-1')][PHONE] = '512-555-0188'));
  await syncNow(A.token, sourceId);
  const r = await call(`${API}/review/changes/resolve`, A.token, { method: 'POST', body: { rowIds: [rowIdOf.get('EP-1')!], action: 'apply' } });
  assert.equal(r.body.resolved, 1);
  const lead = await prisma.leads.findUniqueOrThrow({ where: { id: leadIdOf.get('EP-1')! } });
  assert.equal(lead.normalized_phone, '+15125550188');
  assert.deepEqual(lead.custom_fields, { Notes: 'kept note' });
  assert.equal(lead.status, 'new');
  assert.equal(lead.automation_paused, false);
  assert.equal((await call(`${API}/review/changes?sourceId=${sourceId}`, A.token)).body.items.length, 0);
});

test('a REJECTED row edited in the sheet is flagged too; applying it never reopens or unpauses the lead', async () => {
  edit((g) => (g[rowOf('EP-2')][PHONE] = '512-555-0122'));
  await syncNow(A.token, sourceId);
  assert.equal((await lastRun(A.token, sourceId)).run.summary.flagged, 1);
  let lead = await prisma.leads.findUniqueOrThrow({ where: { id: leadIdOf.get('EP-2')! } });
  assert.equal(lead.normalized_phone, '+15125550102', 'a rejected lead was overwritten');

  const r = await call(`${API}/review/changes/resolve`, A.token, { method: 'POST', body: { rowIds: [rowIdOf.get('EP-2')!], action: 'apply' } });
  assert.equal(r.body.resolved, 1, r.text);
  lead = await prisma.leads.findUniqueOrThrow({ where: { id: leadIdOf.get('EP-2')! } });
  assert.equal(lead.normalized_phone, '+15125550122');
  assert.equal(lead.status, 'closed');
  assert.equal(lead.automation_paused, true);
  const row = await prisma.sheet_import_rows.findUniqueOrThrow({ where: { id: rowIdOf.get('EP-2')! } });
  assert.equal(row.review_state, 'rejected');
});

// =================================================================================
// Phase 5 — rows that disappear, failures, and the schedule
// =================================================================================

test('a row deleted from the sheet is marked missing after a complete read — the lead stays', async () => {
  const saved = grid()[rowOf('EP-10')];
  edit((g) => g.splice(rowOf('EP-10'), 1));
  await syncNow(A.token, sourceId);
  assert.equal((await lastRun(A.token, sourceId)).run.summary.missingMarked, 1);
  const row = await prisma.sheet_import_rows.findUniqueOrThrow({ where: { id: rowIdOf.get('EP-10')! } });
  assert.ok(row.missing_since);
  assert.ok(await prisma.leads.findUnique({ where: { id: leadIdOf.get('EP-10')! } }), 'a lead was deleted');

  edit((g) => g.splice(10, 0, saved));
  await syncNow(A.token, sourceId);
  assert.equal((await lastRun(A.token, sourceId)).run.summary.reappeared, 1);
  assert.equal((await prisma.sheet_import_rows.findUniqueOrThrow({ where: { id: rowIdOf.get('EP-10')! } })).missing_since, null);
});

test('a read that fails part-way marks nothing missing, and retries with backoff', async () => {
  edit((g) => g.splice(rowOf('EP-11'), 1)); // would look missing — if the read completed
  failNextDataRead = new GoogleApiError('UNAVAILABLE', 'backend error', 503);
  const t0 = Date.now();
  await syncNow(A.token, sourceId);
  const { run } = await lastRun(A.token, sourceId);
  assert.equal(run.ok, false);
  assert.equal(run.summary.code, 'GOOGLE_UNAVAILABLE');
  assert.equal(run.summary.permanent, false);
  const src = await prisma.lead_sources.findUniqueOrThrow({ where: { id: sourceId } });
  assert.equal(src.ingest_status, 'ACTIVE', 'a transient failure must not pause the source');
  assert.equal(src.sync_failures, 1);
  assert.ok(src.sync_next_at!.getTime() - t0 >= 0.8 * 60_000, 'no backoff');
  assert.equal((await prisma.sheet_import_rows.findUniqueOrThrow({ where: { id: rowIdOf.get('EP-11')! } })).missing_since, null);
});

test('a rate limit backs off further each time', async () => {
  failNextDataRead = new GoogleApiError('RATE_LIMITED', 'quota', 429);
  const t0 = Date.now();
  await syncNow(A.token, sourceId);
  const { run } = await lastRun(A.token, sourceId);
  assert.equal(run.summary.code, 'GOOGLE_RATE_LIMITED');
  assert.equal(run.summary.rateLimited, true);
  const src = await prisma.lead_sources.findUniqueOrThrow({ where: { id: sourceId } });
  assert.equal(src.sync_failures, 2);
  assert.ok(src.sync_next_at!.getTime() - t0 >= 0.8 * 120_000, 'backoff did not grow');

  // The read that finally completes resets the count and records the missing row.
  await syncNow(A.token, sourceId);
  const ok = await prisma.lead_sources.findUniqueOrThrow({ where: { id: sourceId } });
  assert.equal(ok.sync_failures, 0);
  assert.ok((await prisma.sheet_import_rows.findUniqueOrThrow({ where: { id: rowIdOf.get('EP-11')! } })).missing_since);
});

test('a mapping change re-baselines reviewed rows without flagging them, and refreshes drafts', async () => {
  const columns = MAPPING.columns.filter((c) => c.fieldKey !== 'notes');
  const saved = await call(`${API}/sources/${sourceId}/mapping`, A.token, { method: 'PUT', body: { ...MAPPING, columns } });
  assert.equal(saved.status, 200, saved.text);
  await syncNow(A.token, sourceId);
  const { run } = await lastRun(A.token, sourceId);
  // Reviewed: EP-1, EP-96, EP-98 approved; EP-2 rejected. Only EP-1 and EP-2 had
  // a note, so only their content (and hash) changed with the notes column gone.
  assert.equal(run.summary.rebaselined, 2);
  assert.equal(run.summary.flagged, 0);
  assert.ok(run.summary.updated > 80, `drafts not refreshed: ${run.summary.updated}`);
  const draft = await prisma.leads.findUniqueOrThrow({ where: { id: leadIdOf.get('EP-4')! } });
  assert.deepEqual(draft.custom_fields, {});
});

test('a REAL edit that lands together with a mapping change is still flagged, not swallowed', async () => {
  edit((g) => (g[rowOf('EP-1')][PHONE] = '512-555-0166'));
  // Re-save the same mapping: a new mapping version, so this read re-baselines.
  const columns = MAPPING.columns.filter((c) => c.fieldKey !== 'notes');
  assert.equal((await call(`${API}/sources/${sourceId}/mapping`, A.token, { method: 'PUT', body: { ...MAPPING, columns } })).status, 200);
  await syncNow(A.token, sourceId);
  const { run } = await lastRun(A.token, sourceId);
  assert.equal(run.summary.flagged, 1);
  const lead = await prisma.leads.findUniqueOrThrow({ where: { id: leadIdOf.get('EP-1')! } });
  assert.equal(lead.normalized_phone, '+15125550188', 'a reviewed lead was overwritten');
  const res = await call(`${API}/review/changes/resolve`, A.token, { method: 'POST', body: { rowIds: [rowIdOf.get('EP-1')!], action: 'keep' } });
  assert.equal(res.body.resolved, 1);
});

test('saving the mapping again re-writes every pending draft, even one whose values did not change', async () => {
  // A draft carrying a warning today's checks would not raise.
  const id = leadIdOf.get('EP-6')!;
  await prisma.leads.update({ where: { id }, data: { review_reasons: [IMPORT_REVIEW_REASON, 'stale warning'] } });
  const columns = MAPPING.columns.filter((c) => c.fieldKey !== 'notes');
  assert.equal((await call(`${API}/sources/${sourceId}/mapping`, A.token, { method: 'PUT', body: { ...MAPPING, columns } })).status, 200);
  await syncNow(A.token, sourceId);
  const { run } = await lastRun(A.token, sourceId);
  assert.equal(run.summary.flagged, 0, 'a reviewed row was flagged by re-saving the same mapping');
  const lead = await prisma.leads.findUniqueOrThrow({ where: { id } });
  assert.deepEqual(lead.review_reasons, [IMPORT_REVIEW_REASON]);
  assert.equal(lead.automation_paused, true);
});

test('version probe: an unchanged Drive version skips the read; an edit, or age, forces it', async () => {
  const probing = new SheetImportService(
    app.get(PrismaService),
    app.get<GuardedPrisma>(TENANT_PRISMA),
    app.get(GoogleConnectionsService),
    google as unknown as GoogleClient,
    app.get(EventsBus),
    new ConfigService({ GOOGLE_SHEETS_ENABLED: '1', SHEETS_VERSION_PROBE: '1', SHEETS_FULL_READ_MAX_AGE_MS: 21_600_000 }),
  );
  const due = () => prisma.lead_sources.update({ where: { id: sourceId }, data: { sync_next_at: new Date() } });

  await due();
  let before = { ...calls };
  await probing.drain();
  assert.equal(calls.driveFile - before.driveFile, 1);
  assert.equal(calls.readGrid - before.readGrid, 0, 'read a sheet whose version had not moved');

  edit((g) => (g[rowOf('EP-5')][PHONE] = '512-555-0105'));
  await due();
  before = { ...calls };
  await probing.drain();
  assert.ok(calls.readGrid - before.readGrid >= 2, 'did not read an edited sheet');

  await prisma.lead_sources.update({ where: { id: sourceId }, data: { remote_synced_at: new Date(Date.now() - 7 * 3_600_000), sync_next_at: new Date() } });
  before = { ...calls };
  await probing.drain();
  assert.ok(calls.readGrid - before.readGrid >= 2, 'a stale full read was not refreshed');

  // "Sync now" always reads in full: Drive's version can trail an edit by
  // seconds, and the owner just asked. (The app's own importer is held back so
  // the probing one takes the run.)
  const nudge = importer.nudge;
  importer.nudge = () => undefined;
  try {
    assert.equal((await call(`${API}/sources/${sourceId}/sync`, A.token, { method: 'POST' })).status, 202);
  } finally {
    importer.nudge = nudge;
  }
  before = { ...calls };
  await probing.drain();
  assert.ok(calls.readGrid - before.readGrid >= 2, 'an owner-requested sync was skipped by the version probe');
});

test('periodic sync (SHEETS_SYNC=1): a source syncs again on its own interval', async () => {
  const scheduled = new SheetImportService(
    app.get(PrismaService),
    app.get<GuardedPrisma>(TENANT_PRISMA),
    app.get(GoogleConnectionsService),
    google as unknown as GoogleClient,
    app.get(EventsBus),
    new ConfigService({ GOOGLE_SHEETS_ENABLED: '1', SHEETS_SYNC: '1', SHEETS_POLL_MS: 200, SHEETS_SYNC_INTERVAL_MS: 1_000 }),
  );
  await prisma.lead_sources.update({ where: { id: sourceId }, data: { sync_next_at: new Date() } });
  const start = (await prisma.lead_sources.findUniqueOrThrow({ where: { id: sourceId } })).last_success_at!;
  scheduled.onModuleInit();
  try {
    const seen = new Set<number>();
    for (let i = 0; i < 40 && seen.size < 2; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const s = await prisma.lead_sources.findUniqueOrThrow({ where: { id: sourceId } });
      if (s.last_success_at! > start) seen.add(s.last_success_at!.getTime());
    }
    assert.ok(seen.size >= 2, `expected two scheduled runs, saw ${seen.size}`);
    const next = (await prisma.lead_sources.findUniqueOrThrow({ where: { id: sourceId } })).sync_next_at!;
    assert.ok(next.getTime() > Date.now() - 2_000, 'no next run scheduled');
  } finally {
    scheduled.onModuleDestroy();
    await scheduled.drain();
  }
});

test('a revoked Google grant pauses the source; it is not retried', async () => {
  refreshFails = new GoogleApiError('REAUTH', 'invalid_grant', 400);
  try {
    // A fresh connection service would refresh; force it by expiring the cached token.
    (app.get(GoogleConnectionsService) as any).accessTokens.clear();
    await syncNow(A.token, sourceId);
  } finally {
    refreshFails = null;
  }
  const src = await source(A.token, sourceId);
  assert.equal(src.status, 'PAUSED');
  assert.equal(src.lastErrorCode, 'GOOGLE_REAUTH_REQUIRED');
  assert.equal(src.nextSyncAt, null);
  const cred = await prisma.provider_credentials.findUniqueOrThrow({ where: { id: connectionA } });
  assert.equal(cred.status, 'INVALID');
  await prisma.provider_credentials.update({ where: { id: connectionA }, data: { status: 'ACTIVE', last_error_code: null } });
});

// =================================================================================
// Limits and scale
// =================================================================================

test('a tab over 10,000 data rows is refused before anything is written', async () => {
  files.set(BIG_SHEET, {
    title: 'Big',
    version: 1,
    tabs: [{ sheetId: 7, title: 'All', rowCount: 10_002, columnCount: 4, grid: [['ID', 'Name', 'Phone', 'Email'], ...simpleRows(10_001, 'BIG')] }],
  });
  const created = await call(`${API}/sources`, A.token, { method: 'POST', body: { connectionId: connectionA, spreadsheetId: BIG_SHEET, sheetId: 7 } });
  const id = created.body.id;
  const mapped = await call(`${API}/sources/${id}/mapping`, A.token, {
    method: 'PUT',
    body: { columns: [{ fieldKey: 'name', target: 'first_name' }, { fieldKey: 'email', target: 'email' }], identity: { mode: 'fallback', acknowledged: true } },
  });
  assert.equal(mapped.status, 200, mapped.text);
  const ack = await prisma.lead_sources.findUniqueOrThrow({ where: { id }, select: { sync_fallback_ack_at: true, sync_fallback_ack_by: true } });
  assert.ok(ack.sync_fallback_ack_at && ack.sync_fallback_ack_by, 'fallback acknowledgement not recorded');

  await call(`${API}/sources/${id}/enable`, A.token, { method: 'POST' });
  await importer.drain();
  const { run } = await lastRun(A.token, id);
  assert.equal(run.ok, false);
  assert.equal(run.summary.code, 'SHEET_TOO_LARGE');
  assert.equal(await prisma.leads.count({ where: { organization_id: A.orgId, lead_source_id: id } }), 0);
});

test('2,000 rows: a fixed handful of statements, never one per row', async () => {
  files.set(MID_SHEET, {
    title: 'Mid',
    version: 1,
    tabs: [{ sheetId: 3, title: 'Leads', rowCount: 2_001, columnCount: 4, grid: [['ID', 'Name', 'Phone', 'Email'], ...simpleRows(2_000, 'MID')] }],
  });
  const created = await call(`${API}/sources`, A.token, { method: 'POST', body: { connectionId: connectionA, spreadsheetId: MID_SHEET, sheetId: 3 } });
  const id = created.body.id;
  await call(`${API}/sources/${id}/mapping`, A.token, {
    method: 'PUT',
    body: { columns: [{ fieldKey: 'name', target: 'first_name' }, { fieldKey: 'email', target: 'email' }], identity: { mode: 'column', fieldKey: 'id' } },
  });
  await call(`${API}/sources/${id}/enable`, A.token, { method: 'POST' });
  await importer.drain();
  const { run } = await lastRun(A.token, id);
  assert.equal(run.ok, true, JSON.stringify(run));
  assert.equal(run.summary.inserted, 2_000);
  // 4 setup + 4 batches x (contacts + 2 inserts) = 16, whatever the row count.
  assert.equal(run.summary.dbStatements, 16);
  assert.equal(run.summary.googleRequests, 4);
  // eslint-disable-next-line no-console
  console.log(`  2,000-row import: ${run.summary.durationMs}ms, ${run.summary.dbStatements} DB statements, ${run.summary.googleRequests} Google requests`);

  // Approving all 2,000 is four bounded requests of constant statement count.
  const rows = await prisma.sheet_import_rows.findMany({ where: { organization_id: A.orgId, lead_source_id: id }, select: { id: true } });
  const t0 = Date.now();
  let released = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const r = await call(`${API}/review/approve`, A.token, { method: 'POST', body: { rowIds: rows.slice(i, i + 500).map((x) => x.id) } });
    assert.equal(r.status, 200, r.text);
    released += r.body.released;
  }
  // No phone column mapped: approved, but held — nothing here can be dialled.
  assert.equal(released, 0);
  // eslint-disable-next-line no-console
  console.log(`  approving 2,000 rows in 4 requests: ${Date.now() - t0}ms`);
});

// =================================================================================
// Phase 7 — hardening: identities, failures, leases, the rollout flag, scale
// =================================================================================

const FB_SHEET = `sheetimportfb${RUN}abcdefghi`;
const HARD_SHEET = `sheetimporthard${RUN}abcdefg`;
const CRASH_SHEET = `sheetimportcrash${RUN}abcdef`;
const TEN_SHEET = `sheetimportten${RUN}abcdefgh`;
const ID_MAPPING = {
  columns: [
    { fieldKey: 'name', target: 'first_name' },
    { fieldKey: 'email', target: 'email' },
  ],
  identity: { mode: 'column', fieldKey: 'id' },
};

/** Edit any fake file like a person would: the Drive version moves. */
function editFile(file: string, fn: (g: string[][]) => void): void {
  fn(files.get(file)!.tabs[0].grid);
  files.get(file)!.version += 1;
}

/** Create, map and switch on a source for a fake file; the first import has run when this returns. */
async function importedSource(file: string, sheetId: number, mapping: unknown): Promise<string> {
  const created = await call(`${API}/sources`, A.token, { method: 'POST', body: { connectionId: connectionA, spreadsheetId: file, sheetId } });
  assert.equal(created.status, 200, created.text);
  const mapped = await call(`${API}/sources/${created.body.id}/mapping`, A.token, { method: 'PUT', body: mapping });
  assert.equal(mapped.status, 200, mapped.text);
  const on = await call(`${API}/sources/${created.body.id}/enable`, A.token, { method: 'POST' });
  assert.equal(on.status, 200, on.text);
  await importer.drain();
  return created.body.id;
}

const due = (id: string) => prisma.lead_sources.update({ where: { id }, data: { sync_next_at: new Date() } });
const rowsOf = (id: string) => prisma.sheet_import_rows.count({ where: { organization_id: A.orgId, lead_source_id: id } });
const missingOf = (id: string) => prisma.sheet_import_rows.count({ where: { organization_id: A.orgId, lead_source_id: id, missing_since: { not: null } } });

/**
 * The counters of the run that completes while `fn` runs — quiet runs
 * included, which leave no audit row to read them from.
 */
async function measured(fn: () => Promise<void>): Promise<{ ms: number; stats: any }> {
  let stats: any = null;
  const finishOk = Object.getPrototypeOf(importer).finishOk;
  (importer as any).finishOk = function (this: unknown, ...args: unknown[]) {
    stats = args[2];
    return finishOk.apply(this, args);
  };
  const t0 = Date.now();
  try {
    await fn();
    await importer.drain();
  } finally {
    delete (importer as any).finishOk;
  }
  assert.ok(stats, 'the run did not complete');
  return { ms: Date.now() - t0, stats };
}

test('fallback identity: refused without the acknowledgement; an edited contact becomes a new pending row, the old one goes missing', async () => {
  files.set(FB_SHEET, {
    title: 'No IDs',
    version: 1,
    tabs: [
      {
        sheetId: 0,
        title: 'Leads',
        rowCount: 10,
        columnCount: 3,
        grid: [
          ['Name', 'Phone', 'Email'],
          ['Fb One', '512-555-0301', `fb.1.${RUN}@example.test`],
          ['Fb Two', '512-555-0302', `fb.2.${RUN}@example.test`],
          ['Fb Three', '512-555-0303', `fb.3.${RUN}@example.test`],
        ],
      },
    ],
  });
  const columns = [
    { fieldKey: 'name', target: 'full_name' },
    { fieldKey: 'phone', target: 'phone' },
    { fieldKey: 'email', target: 'email' },
  ];
  const created = await call(`${API}/sources`, A.token, { method: 'POST', body: { connectionId: connectionA, spreadsheetId: FB_SHEET, sheetId: 0 } });
  const unacknowledged = await call(`${API}/sources/${created.body.id}/mapping`, A.token, {
    method: 'PUT',
    body: { columns, identity: { mode: 'fallback' } },
  });
  assert.equal(unacknowledged.status, 400, unacknowledged.text);

  const id = await importedSource(FB_SHEET, 0, { columns, identity: { mode: 'fallback', acknowledged: true } });
  assert.equal(await rowsOf(id), 3);
  const before = await prisma.sheet_import_rows.findMany({ where: { organization_id: A.orgId, lead_source_id: id }, select: { lead_id: true } });

  editFile(FB_SHEET, (g) => (g[2][1] = '512-555-0399'));
  await syncNow(A.token, id);
  const { run } = await lastRun(A.token, id);
  assert.equal(run.summary.inserted, 1);
  assert.equal(run.summary.missingMarked, 1);
  assert.equal(await rowsOf(id), 4);
  for (const r of before) assert.ok(await prisma.leads.findUnique({ where: { id: r.lead_id! } }), 'a lead was deleted');
  const fresh = await prisma.leads.findFirstOrThrow({ where: { organization_id: A.orgId, lead_source_id: id, normalized_phone: '+15125550399' } });
  assert.equal(fresh.automation_paused, true);
});

let hardId = '';

test('a renamed mapped column stops the run before anything is written, and pauses the source for review', async () => {
  files.set(HARD_SHEET, {
    title: 'Hardening',
    version: 1,
    tabs: [{ sheetId: 0, title: 'Leads', rowCount: 20, columnCount: 4, grid: [['ID', 'Name', 'Phone', 'Email'], ...simpleRows(5, 'HD')] }],
  });
  hardId = await importedSource(HARD_SHEET, 0, ID_MAPPING);
  assert.equal(await rowsOf(hardId), 5);

  editFile(HARD_SHEET, (g) => {
    g[0][3] = 'E-mail address';
    g.push(['HD-6', 'Bulk 6', '', `HD.6.${RUN}@example.test`]);
  });
  await syncNow(A.token, hardId);
  const { run } = await lastRun(A.token, hardId);
  assert.equal(run.ok, false);
  assert.equal(run.summary.code, 'HEADERS_CHANGED');
  assert.equal(run.summary.permanent, true);
  assert.equal(await rowsOf(hardId), 5, 'a row was written under a broken mapping');
  const src = await prisma.lead_sources.findUniqueOrThrow({ where: { id: hardId } });
  assert.equal(src.ingest_status, 'PAUSED');
  assert.equal(src.mapping_status, 'NEEDS_REVIEW');
  assert.equal(src.sync_next_at, null, 'a permanent failure must not be retried');

  // Put the heading back, confirm the mapping, switch it on: the new row arrives.
  editFile(HARD_SHEET, (g) => (g[0][3] = 'Email'));
  assert.equal((await call(`${API}/sources/${hardId}/mapping`, A.token, { method: 'PUT', body: ID_MAPPING })).status, 200);
  assert.equal((await call(`${API}/sources/${hardId}/enable`, A.token, { method: 'POST' })).status, 200);
  await importer.drain();
  assert.equal(await rowsOf(hardId), 6);
});

test('losing access to the file pauses the source with a reason; nothing is marked missing', async () => {
  denied.add(HARD_SHEET);
  try {
    await syncNow(A.token, hardId);
  } finally {
    denied.delete(HARD_SHEET);
  }
  const src = await source(A.token, hardId);
  assert.equal(src.status, 'PAUSED');
  assert.equal(src.lastErrorCode, 'GOOGLE_FILE_ACCESS_DENIED');
  assert.equal(await missingOf(hardId), 0);
  assert.equal((await call(`${API}/sources/${hardId}/enable`, A.token, { method: 'POST' })).status, 200);
  await importer.drain();
  assert.equal((await source(A.token, hardId)).lastErrorCode, null);
});

test('lease: a lease left by a dead worker is taken over after it expires; a live one is not', async () => {
  const lastOk = async () => (await prisma.lead_sources.findUniqueOrThrow({ where: { id: hardId } })).last_success_at!.getTime();

  await prisma.lead_sources.update({
    where: { id: hardId },
    data: { sync_next_at: new Date(), sync_locked_at: new Date(Date.now() - 11 * 60_000), sync_locked_by: 'sheets-dead-worker' },
  });
  let before = await lastOk();
  await importer.drain();
  assert.ok((await lastOk()) > before, 'an expired lease was not taken over');
  assert.equal((await prisma.lead_sources.findUniqueOrThrow({ where: { id: hardId } })).sync_locked_by, null);

  await prisma.lead_sources.update({
    where: { id: hardId },
    data: { sync_next_at: new Date(), sync_locked_at: new Date(), sync_locked_by: 'sheets-live-worker' },
  });
  before = await lastOk();
  await importer.drain();
  assert.equal(await lastOk(), before, 'ran a source another worker holds');
  assert.equal((await prisma.lead_sources.findUniqueOrThrow({ where: { id: hardId } })).sync_locked_by, 'sheets-live-worker');
  await prisma.lead_sources.update({ where: { id: hardId }, data: { sync_locked_at: null, sync_locked_by: null, sync_next_at: null } });
});

test('switched off (GOOGLE_SHEETS_ENABLED not 1): the guard answers 404 even to an owner, and nothing syncs', async () => {
  // A ConfigService without validated values falls back to process.env, where
  // this suite switched the feature on.
  delete process.env['GOOGLE_SHEETS_ENABLED'];
  try {
    assert.throws(
      () => new SheetsEnabledGuard(new ConfigService({})).canActivate(),
      (e: any) => e.getStatus() === 404 && e.getResponse().error.code === 'GOOGLE_SHEETS_DISABLED',
    );
    assert.equal(new SheetsEnabledGuard(new ConfigService({ GOOGLE_SHEETS_ENABLED: '1' })).canActivate(), true);

    const off = new SheetImportService(
      app.get(PrismaService),
      app.get<GuardedPrisma>(TENANT_PRISMA),
      app.get(GoogleConnectionsService),
      google as unknown as GoogleClient,
      app.get(EventsBus),
      new ConfigService({ SHEETS_SYNC: '1' }),
    );
    off.onModuleInit();
    assert.equal((off as any).timer, null, 'a disabled importer started its scheduler');
    await due(hardId);
    const before = { ...calls };
    await off.drain();
    assert.deepEqual(calls, before, 'a disabled importer called Google');
    const src = await prisma.lead_sources.findUniqueOrThrow({ where: { id: hardId } });
    assert.equal(src.ingest_status, 'ACTIVE', 'switching off changed the source');
    assert.ok(src.sync_next_at && src.sync_locked_by === null, 'the due source was touched');
  } finally {
    process.env['GOOGLE_SHEETS_ENABLED'] = '1';
    await prisma.lead_sources.update({ where: { id: hardId }, data: { sync_next_at: null } });
  }
});

test('a crash part-way through writing: retried safely, never duplicated, and nothing marked missing', async () => {
  files.set(CRASH_SHEET, {
    title: 'Crash',
    version: 1,
    tabs: [{ sheetId: 0, title: 'Leads', rowCount: 1_201, columnCount: 4, grid: [['ID', 'Name', 'Phone', 'Email'], ...simpleRows(1_200, 'CR')] }],
  });
  /** Make the n-th write batch from now on throw, as a killed process or a dropped connection would. */
  const crashOnBatch = (n: number) => {
    const persistBatch = Object.getPrototypeOf(importer).persistBatch;
    let batches = 0;
    (importer as any).persistBatch = function (this: unknown, ...args: unknown[]) {
      batches += 1;
      if (batches === n) return Promise.reject(new Error('simulated crash'));
      return persistBatch.apply(this, args);
    };
  };

  // The first import dies after one 500-row batch committed.
  crashOnBatch(2);
  let id = '';
  try {
    id = await importedSource(CRASH_SHEET, 0, ID_MAPPING);
  } finally {
    delete (importer as any).persistBatch;
  }
  const { run } = await lastRun(A.token, id);
  assert.equal(run.ok, false);
  assert.equal(run.summary.permanent, false);
  assert.equal(await rowsOf(id), 500);
  const leadsOf = () => prisma.leads.count({ where: { organization_id: A.orgId, lead_source_id: id } });
  assert.equal(await leadsOf(), 500, 'a lead was written without its tracking row');

  // The retry completes it: every row exactly once.
  await due(id);
  await importer.drain();
  assert.equal(await rowsOf(id), 1_200);
  assert.equal(await leadsOf(), 1_200);
  assert.equal(await missingOf(id), 0);

  // 300 rows deleted, and the run dies before the end: nothing may be marked missing.
  editFile(CRASH_SHEET, (g) => g.splice(1, 300));
  crashOnBatch(1);
  try {
    await due(id);
    await importer.drain();
  } finally {
    delete (importer as any).persistBatch;
  }
  assert.equal(await missingOf(id), 0, 'an incomplete run marked rows missing');
  await due(id);
  await importer.drain();
  assert.equal(await missingOf(id), 300);
  assert.equal(await leadsOf(), 1_200, 'a lead was deleted');
});

test('10,000 rows (the cap): first import, an unchanged sync, and 10% edited — bounded statements and requests', async () => {
  files.set(TEN_SHEET, {
    title: 'Ten thousand',
    version: 1,
    tabs: [{ sheetId: 0, title: 'Leads', rowCount: 10_001, columnCount: 4, grid: [['ID', 'Name', 'Phone', 'Email'], ...simpleRows(10_000, 'TEN')] }],
  });
  let id = '';
  const first = await measured(async () => {
    id = await importedSource(TEN_SHEET, 0, ID_MAPPING);
  });
  assert.equal(first.stats.inserted, 10_000);
  // Drive + tab metadata + header + 5 data reads of 2,000 rows.
  assert.equal(first.stats.googleRequests, 8);
  // 4 setup + 20 batches x (contacts + 2 inserts).
  assert.equal(first.stats.dbStatements, 64);

  const quiet = await measured(() => due(id).then(() => undefined));
  assert.equal(quiet.stats.inserted + quiet.stats.updated, 0);
  assert.equal(quiet.stats.unchanged, 10_000);
  assert.equal(quiet.stats.googleRequests, 8);
  assert.ok(quiet.stats.dbStatements <= 64, `unchanged sync: ${quiet.stats.dbStatements} statements`);

  editFile(TEN_SHEET, (g) => {
    for (let i = 1; i <= 10_000; i += 10) g[i][1] = `${g[i][1]} edited`;
  });
  const edited = await measured(() => due(id).then(() => undefined));
  assert.equal(edited.stats.updated, 1_000);
  assert.equal(edited.stats.inserted, 0);
  assert.ok(edited.stats.dbStatements <= 64, `10% edited: ${edited.stats.dbStatements} statements`);

  // Every write landed in the source's own organization, and nothing was released.
  assert.equal(await prisma.leads.count({ where: { lead_source_id: id, NOT: { organization_id: A.orgId } } }), 0);
  assert.equal(await prisma.sheet_import_rows.count({ where: { lead_source_id: id, NOT: { organization_id: A.orgId } } }), 0);
  assert.equal(await prisma.leads.count({ where: { organization_id: A.orgId, lead_source_id: id, automation_paused: false } }), 0);

  for (const [label, m] of [
    ['first import', first],
    ['unchanged sync', quiet],
    ['10% edited', edited],
  ] as const) {
    // eslint-disable-next-line no-console
    console.log(`  10,000 rows, ${label}: ${m.ms}ms, ${m.stats.dbStatements} DB statements, ${m.stats.googleRequests} Google requests`);
  }
});

test('the database itself refuses impossible tracking rows, and the migration only adds', async () => {
  const [row] = await prisma.sheet_import_rows.findMany({ where: { organization_id: A.orgId, lead_source_id: sourceId }, take: 1 });
  const insert = (over: Record<string, unknown>) => {
    const v: Record<string, unknown> = {
      review_state: 'pending',
      reviewed_at: null,
      changed_after_review_at: null,
      changed_values: null,
      row_number: 2,
      row_key: newId().replace(/-/g, ''),
      ...over,
    };
    return prisma.$executeRaw`
      INSERT INTO sheet_import_rows (id, organization_id, lead_source_id, row_key, content_hash, row_number, review_state, reviewed_at, changed_after_review_at, changed_values)
      VALUES (${newId()}::uuid, ${A.orgId}::uuid, ${sourceId}::uuid, ${v.row_key}, ${'0'.repeat(64)}, ${v.row_number}::int, ${v.review_state},
              ${v.reviewed_at}::timestamptz, ${v.changed_after_review_at}::timestamptz, ${v.changed_values}::jsonb)`;
  };
  const before = await rowsOf(sourceId);
  const cases: [string, Record<string, unknown>][] = [
    ['an unknown review state', { review_state: 'maybe', reviewed_at: new Date() }],
    ['a decision without a time', { review_state: 'approved' }],
    ['a pending row with a decision time', { reviewed_at: new Date() }],
    ['a change flag without its values', { review_state: 'approved', reviewed_at: new Date(), changed_after_review_at: new Date() }],
    ['row number 0', { row_number: 0 }],
    ['the same row twice', { row_key: row.row_key }],
  ];
  for (const [label, over] of cases) {
    await assert.rejects(insert(over), `accepted ${label}`);
  }
  assert.equal(await rowsOf(sourceId), before);

  const sql = readFileSync(join(process.cwd(), 'prisma/migrations/20261012000001_google_sheets_import/migration.sql'), 'utf8')
    .replace(/--.*$/gm, '')
    .replace(/ON DELETE (CASCADE|NO ACTION|SET NULL)/g, '');
  assert.doesNotMatch(sql, /\b(DROP|TRUNCATE|DELETE|RENAME)\b/i, 'the migration must be additive');
  assert.doesNotMatch(sql, /ALTER COLUMN/i, 'the migration must not change existing columns');
});

// =================================================================================
// Disconnect, then connect again
// =================================================================================

/** Connect Google the way the browser does: start, then complete on the same session. */
async function connectAs(sub: string): Promise<{ status: number; body: any; text: string }> {
  const started = await call(`${API}/oauth/start`, A.token, { method: 'POST' });
  assert.equal(started.status, 200, started.text);
  grantSub = sub;
  return call(`${API}/oauth/complete`, A.token, { method: 'POST', body: { code: 'fake-authorization-code', state: started.body.state } });
}

test('disconnect, then reconnect the SAME Google account: its sheets move to the new connection and switch on again', async () => {
  const off = await call(`${API}/connections/${connectionA}`, A.token, { method: 'DELETE' });
  assert.equal(off.status, 204, off.text);
  const refused = await call(`${API}/sources/${hardId}/enable`, A.token, { method: 'POST' });
  assert.equal(refused.status, 409, refused.text);
  assert.equal(refused.body.error.code, 'GOOGLE_REAUTH_REQUIRED');
  const preview = await call(`${API}/sources/${hardId}/preview`, A.token);
  assert.equal(preview.body.error.code, 'GOOGLE_CONNECTION_NOT_FOUND');
  assert.match(preview.body.error.message, /Connect Google again/);

  // Same account as connectionA (see googleConnection()).
  const back = await connectAs(`sub-${RUN}`);
  assert.equal(back.status, 200, back.text);
  assert.notEqual(back.body.id, connectionA, 'a disconnected row was reused');
  const moved = await prisma.lead_sources.findMany({ where: { organization_id: A.orgId, provider_credential_id: connectionA } });
  assert.equal(moved.length, 0, `${moved.length} sheets left on the disconnected connection`);
  assert.equal((await prisma.lead_sources.findUniqueOrThrow({ where: { id: hardId } })).provider_credential_id, back.body.id);
  connectionA = back.body.id;

  const on = await call(`${API}/sources/${hardId}/enable`, A.token, { method: 'POST' });
  assert.equal(on.status, 200, on.text);
  await importer.drain();
  const src = await source(A.token, hardId);
  assert.equal(src.lastErrorCode, null);
  assert.equal(src.status, 'ACTIVE');
});

test('a sheet left on ANOTHER account is not moved on reconnect; picking it again rebinds it', async () => {
  // A sheet whose connection was a different, since-disconnected Google account.
  const elsewhere = newId();
  await prisma.provider_credentials.create({
    data: {
      id: elsewhere,
      organization_id: A.orgId,
      provider: 'GOOGLE',
      label: 'old',
      credential_enc: '',
      credential_hash: 'y'.repeat(64),
      credential_prefix: 'oauth',
      credential_last4: '',
      external_account_id: `other-sub-${RUN}`,
      account_email: 'other@example.test',
      status: 'REVOKED',
      revoked_at: new Date(),
    },
  });
  const fb = await prisma.lead_sources.findFirstOrThrow({ where: { organization_id: A.orgId, external_form_id: `${FB_SHEET}:0` } });
  await prisma.lead_sources.update({ where: { id: fb.id }, data: { provider_credential_id: elsewhere } });

  // Reconnecting the current account leaves it alone…
  assert.equal((await call(`${API}/connections/${connectionA}`, A.token, { method: 'DELETE' })).status, 204);
  const back = await connectAs(`sub-${RUN}`);
  assert.equal(back.status, 200, back.text);
  connectionA = back.body.id;
  assert.equal((await prisma.lead_sources.findUniqueOrThrow({ where: { id: fb.id } })).provider_credential_id, elsewhere);

  // …and picking the same file and tab again moves it: the read proved access.
  const again = await call(`${API}/sources`, A.token, { method: 'POST', body: { connectionId: connectionA, spreadsheetId: FB_SHEET, sheetId: 0 } });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.body.id, fb.id, 'picking the same tab made a second source');
  assert.equal((await prisma.lead_sources.findUniqueOrThrow({ where: { id: fb.id } })).provider_credential_id, connectionA);
});

// =================================================================================
// Removing a sheet
// =================================================================================

test('remove a sheet: it stops syncing and leaves the list; its pending leads stay in Import Review', async () => {
  const pendingBefore = (await call(`${API}/review?sourceId=${hardId}`, A.token)).body.total;
  assert.ok(pendingBefore > 0);
  const leadsBefore = await prisma.leads.count({ where: { organization_id: A.orgId, lead_source_id: hardId } });

  assert.equal((await call(`${API}/sources/${hardId}`, B.token, { method: 'DELETE' })).status, 404, 'another organization removed it');
  const removed = await call(`${API}/sources/${hardId}`, A.token, { method: 'DELETE' });
  assert.equal(removed.status, 200, removed.text);
  assert.deepEqual(removed.body, { removed: true, pendingReview: pendingBefore });

  assert.equal((await source(A.token, hardId)) ?? null, null, 'a removed sheet is still listed');
  assert.equal((await call(`${API}/sources/${hardId}/enable`, A.token, { method: 'POST' })).status, 404);
  assert.equal((await call(`${API}/sources/${hardId}/sync`, A.token, { method: 'POST' })).status, 404);

  // Never picked up again, even when due.
  const before = (await prisma.lead_sources.findUniqueOrThrow({ where: { id: hardId } })).last_success_at;
  await due(hardId);
  await importer.drain();
  assert.deepEqual((await prisma.lead_sources.findUniqueOrThrow({ where: { id: hardId } })).last_success_at, before);

  // Nothing about its leads changed.
  assert.equal(await prisma.leads.count({ where: { organization_id: A.orgId, lead_source_id: hardId } }), leadsBefore);
  assert.equal((await call(`${API}/review?sourceId=${hardId}`, A.token)).body.total, pendingBefore);
  assert.equal(await prisma.audit_logs.count({ where: { organization_id: A.orgId, action: 'sheet_source.removed', entity_id: hardId } }), 1);
});

test('adding the same tab again restores the removed sheet with its mapping, and imports nothing twice', async () => {
  const rowsBefore = await rowsOf(hardId);
  const again = await call(`${API}/sources`, A.token, { method: 'POST', body: { connectionId: connectionA, spreadsheetId: HARD_SHEET, sheetId: 0 } });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.body.id, hardId, 'a second source was created');
  assert.equal(again.body.mappingStatus, 'CONFIGURED');
  assert.equal(again.body.status, 'PAUSED');

  assert.equal((await call(`${API}/sources/${hardId}/enable`, A.token, { method: 'POST' })).status, 200);
  await importer.drain();
  assert.equal(await rowsOf(hardId), rowsBefore);
  assert.equal((await source(A.token, hardId)).lastErrorCode, null);
});
