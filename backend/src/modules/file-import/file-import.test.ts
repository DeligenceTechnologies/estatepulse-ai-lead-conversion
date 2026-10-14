import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { AuthModule } from '../../auth/auth.module';
import { envSchema } from '../../app.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { newId } from '../../common/ids';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { AgentsModule } from '../agents/agents.module';
import { EventsModule } from '../events/events.module';
import { GoogleClient } from '../google-sheets/google.client';
import { GoogleSheetsModule } from '../google-sheets/google-sheets.module';
import { REJECTED_REASON } from '../google-sheets/sheet-review.service';
import { DUPLICATE_REASON, GOOGLE_SHEETS_PROVIDER, SYNC_CONNECTION } from '../google-sheets/sheet-import.service';
import {
  FILE_IMPORT_REVIEW_REASON,
  FILE_UPLOAD_PROVIDER,
  IMPORT_REVIEW_REASON,
  MAX_DATA_ROWS,
  PHONE_UNPARSED_REASON,
} from '../google-sheets/sheet-rows';
import { LeadsModule } from '../leads/leads.module';
import { OwnerGuard } from '../../common/guards/owner.guard';
import { SessionGuard } from '../../common/guards/session.guard';
import { ImportReviewController } from '../google-sheets/import-review.controller';
import { SheetSourcesController } from '../google-sheets/sheet-sources.controller';
import { FileImportEnabledGuard, ImportReviewEnabledGuard, SheetsEnabledGuard } from '../google-sheets/sheets-enabled.guard';
import { FileImportController } from './file-import.controller';
import { FileImportModule } from './file-import.module';
import { xlsxFixture } from './xlsx-fixture.test';

/**
 * Integration suite for the CSV / XLSX lead import, against the REAL database.
 * Run with `npm run test:file-import`. Nothing here can send an SMS or place a
 * call: the outreach pollers are off and every imported lead is paused.
 */
process.env['STRATEGY_ENGINE'] = '0';
process.env['CALENDAR_SYNC'] = '0';
process.env['WORKER_ENABLED'] = 'false';
// Set, not deleted: ConfigModule re-reads backend/.env, where a developer may have switched these on.
process.env['SHEETS_SYNC'] = '0';
process.env['SHEETS_VERSION_PROBE'] = '0';
process.env['GOOGLE_SHEETS_ENABLED'] = '1';
process.env['FILE_IMPORT_ENABLED'] = '1';
delete process.env['SMTP_HOST'];
process.env['FILE_IMPORT_MAX_BYTES'] = String(256 * 1024);

/* eslint-disable @typescript-eslint/no-explicit-any */

const RUN = Date.now().toString(36);
const PASSWORD = 'correct-horse-battery-staple';
const API = '/api/integrations/file-import';
const REVIEW = '/api/integrations/google-sheets/review';

let app: INestApplication;
let prisma: PrismaService;
let base: string;
const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];

async function call(path: string, token?: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(base + path, {
    method: init.method ?? 'GET',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.body ? { 'content-type': 'application/json' } : {}) },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
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

/** A multipart upload, as the browser sends it. */
async function upload(
  path: string,
  token: string | undefined,
  file: { name: string; bytes: Buffer | string } | null,
  fields: Record<string, string> = {},
) {
  const form = new FormData();
  if (file) form.append('file', new Blob([file.bytes]), file.name);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = await fetch(base + path, { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body: form });
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
      email: `file-import-${RUN}-${tag}@example.invalid`,
      password: PASSWORD,
      firstName: 'Own',
      lastName: 'Er',
      organizationName: `FileImport ${tag} ${RUN}`,
    },
  });
  assert.equal(res.status, 201, res.text);
  createdUserIds.push(res.body.user.id);
  createdOrgIds.push(res.body.organization.id);
  return { token: res.body.token as string, orgId: res.body.organization.id as string, userId: res.body.user.id as string };
}

const email = (n: number) => `file.${n}.${RUN}@example.test`;

/**
 * The manual checklist's file: valid leads, a row with only an email, one with
 * only a phone, one with no usable contact, one with an invalid email (but a
 * good phone), a duplicate phone, an identical row, a blank row, and one
 * without a name.
 */
const CSV =
  'Full Name,Phone,Email,City,Budget,Notes\r\n' +
  `Jane Doe,+1 512-555-0101,${email(1)},Austin TX,"$300,000 - $450,000",first\r\n` +
  `Email Only,,${email(2)},,,\r\n` +
  `Phone Only,512-555-0103,,,,\r\n` +
  `No Contact,n/a,not-an-email,,,\r\n` +
  `Bad Email,512-555-0105,not-an-email,,,\r\n` +
  `Same Phone,512-555-0101,${email(6)},,,\r\n` +
  `Jane Doe,+1 512-555-0101,${email(1)},Austin TX,"$300,000 - $450,000",dup of row 2\r\n` +
  ',,,,,\r\n' +
  `,512-555-0109,${email(9)},,,\r\n` +
  `Opted Out,512-555-0196,${email(10)},,,\r\n` +
  `Unparsed Phone,12345,${email(11)},,,\r\n`;

const MAPPING = JSON.stringify([
  { fieldKey: 'full name', target: 'full_name' },
  { fieldKey: 'phone', target: 'phone' },
  { fieldKey: 'email', target: 'email' },
  { fieldKey: 'city', target: 'location' },
  { fieldKey: 'budget', target: 'min_budget' },
  { fieldKey: 'budget', target: 'max_budget' },
  { fieldKey: 'notes', target: '__custom__' },
]);

let A = { token: '', orgId: '', userId: '' };
let B = { token: '', orgId: '', userId: '' };
let batchId = '';
let sheetSourceId = '';
const rowIdOf = new Map<string, string>();
const leadIdOf = new Map<string, string>();

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
      FileImportModule,
    ],
  })
    // Never reached: no sheet is synced here. Present so the module boots without Google credentials.
    .overrideProvider(GoogleClient)
    .useValue({ isConfigured: () => false, pickerConfig: () => ({ apiKey: null, appId: null }) })
    .compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  prisma = app.get(PrismaService);

  A = await signupOwner('a');
  B = await signupOwner('b');
  // Someone who already opted out, on another record.
  await prisma.leads.create({
    data: {
      organization_id: A.orgId,
      first_name: 'Opted',
      phone: '+15125550196',
      normalized_phone: '+15125550196',
      dnc_status: true,
      status: 'not_interested',
    },
  });
  // A sheet import that already exists, so the unified queue has both kinds.
  sheetSourceId = newId();
  await prisma.lead_sources.create({
    data: {
      id: sheetSourceId,
      organization_id: A.orgId,
      name: 'Test Sheet › Leads',
      code: `gsheet-${sheetSourceId.slice(-12)}`,
      source_type: 'other',
      provider: GOOGLE_SHEETS_PROVIDER,
      connection_method: SYNC_CONNECTION,
      external_form_id: `sheet${RUN}:0`,
      ingest_status: 'PAUSED',
      mapping_status: 'CONFIGURED',
      sync_row_key_field: 'lead id',
    },
  });
  const sheetLead = await prisma.leads.create({
    data: {
      organization_id: A.orgId,
      lead_source_id: sheetSourceId,
      first_name: 'From',
      last_name: 'Sheet',
      phone: '+15125550150',
      normalized_phone: '+15125550150',
      phone_valid: true,
      status: 'new',
      automation_paused: true,
      needs_review: true,
      review_reasons: [IMPORT_REVIEW_REASON],
    },
  });
  await prisma.sheet_import_rows.create({
    data: {
      id: newId(),
      organization_id: A.orgId,
      lead_source_id: sheetSourceId,
      row_key: 'k1',
      lead_id: sheetLead.id,
      content_hash: 'h1',
      row_number: 2,
    },
  });
});

after(async () => {
  try {
    for (const orgId of createdOrgIds) {
      await prisma.sheet_import_rows.deleteMany({ where: { organization_id: orgId } });
      await prisma.leads.deleteMany({ where: { organization_id: orgId } });
      await prisma.lead_source_field_mappings.deleteMany({ where: { organization_id: orgId } });
      await prisma.lead_sources.deleteMany({ where: { organization_id: orgId } });
    }
    await prisma.users.deleteMany({ where: { id: { in: createdUserIds } } });
    // Organizations with audit rows stay: the audit log is immutable.
  } finally {
    await app.close();
  }
});

// =================================================================================

test('config: the limits the form enforces', async () => {
  const r = await call(`${API}/config`, A.token);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body, { maxBytes: 256 * 1024, maxRows: MAX_DATA_ROWS, accept: ['.csv', '.xlsx'] });
});

test('owner only: an agent is refused, and no token is refused first', async () => {
  const agentEmail = `file-import-${RUN}-agent@example.invalid`;
  const created = await call('/api/agents', A.token, {
    method: 'POST',
    body: { email: agentEmail, password: PASSWORD, firstName: 'Ag', lastName: 'Ent' },
  });
  assert.equal(created.status, 201, created.text);
  createdUserIds.push(created.body.id);
  const login = await call('/api/auth/login', undefined, { method: 'POST', body: { email: agentEmail, password: PASSWORD } });
  assert.equal(login.status, 200, login.text);
  for (const path of [`${API}/config`, `${API}/history`]) {
    assert.equal((await call(path, login.body.token)).status, 403, path);
    assert.equal((await call(path)).status, 401, path);
  }
  const file = { name: 'leads.csv', bytes: CSV };
  assert.equal((await upload(`${API}/preview`, login.body.token, file)).status, 403);
  assert.equal((await upload(`${API}/preview`, undefined, file)).status, 401);
  assert.equal((await upload(`${API}/batches`, login.body.token, file, { mapping: MAPPING, clientToken: randomUUID() })).status, 403);
  assert.equal(
    await prisma.lead_sources.count({ where: { organization_id: A.orgId, provider: FILE_UPLOAD_PROVIDER } }),
    0,
    'an agent imported a file',
  );
});

test('files that are not a lead file are refused with a reason, and nothing is written', async () => {
  const cases: [{ name: string; bytes: Buffer | string } | null, string][] = [
    [null, 'NO_FILE'],
    [{ name: 'leads.pdf', bytes: '%PDF-1.4' }, 'UNSUPPORTED_FILE'],
    [{ name: 'leads.xls', bytes: Buffer.from([0xd0, 0xcf, 0x11, 0xe0]) }, 'UNSUPPORTED_FILE'],
    [{ name: 'leads.xlsx', bytes: 'Name,Phone\nx,y' }, 'MALFORMED_FILE'],
    [{ name: 'leads.csv', bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]) }, 'MALFORMED_FILE'],
    [{ name: 'leads.xlsx', bytes: Buffer.from('PK\u0003\u0004not really a workbook') }, 'MALFORMED_FILE'],
    [{ name: 'leads.csv', bytes: '\n\n' }, 'EMPTY_FILE'],
    [{ name: 'leads.csv', bytes: ',,\nJane,+15125550101' }, 'NO_HEADER_ROW'],
    [{ name: 'leads.csv', bytes: 'Name,Phone\n' + 'x,+15125550101\n'.repeat(MAX_DATA_ROWS + 1) }, 'FILE_TOO_MANY_ROWS'],
    [{ name: 'leads.csv', bytes: 'Name,Phone\n' + 'x'.repeat(256 * 1024 + 1) }, 'FILE_TOO_LARGE'],
  ];
  for (const [file, code] of cases) {
    const r = await upload(`${API}/preview`, A.token, file);
    assert.equal(r.status, 400, `${file?.name ?? 'no file'}: ${r.text}`);
    assert.equal(r.body.error.code, code, `${file?.name ?? 'no file'}: ${r.text}`);
    const c = await upload(`${API}/batches`, A.token, file, { mapping: MAPPING, clientToken: randomUUID() });
    assert.equal(c.status, 400, `${file?.name ?? 'no file'} (commit): ${c.text}`);
  }
  assert.equal(await prisma.lead_sources.count({ where: { organization_id: A.orgId, provider: FILE_UPLOAD_PROVIDER } }), 0);
  // Far over the hard ceiling: cut off by the upload layer, with the standard envelope.
  const huge = await upload(`${API}/preview`, A.token, { name: 'leads.csv', bytes: Buffer.alloc(21 * 1024 * 1024, 0x61) });
  assert.equal(huge.status, 413, huge.text);
  assert.ok(huge.body.error.message, huge.text);
});

test('preview: suggests the mapping, counts every row, and writes nothing', async () => {
  const r = await upload(`${API}/preview`, A.token, { name: 'leads.csv', bytes: CSV });
  assert.equal(r.status, 200, r.text);
  const p = r.body;
  assert.equal(p.file.kind, 'csv');
  assert.equal(p.file.rows, 11);
  assert.deepEqual(
    p.headers.map((h: any) => h.fieldKey),
    ['full name', 'phone', 'email', 'city', 'budget', 'notes'],
  );
  const suggested = Object.fromEntries(p.mapping.columns.map((c: any) => [c.fieldKey, c.target]));
  assert.equal(suggested['full name'], 'full_name');
  assert.equal(suggested['phone'], 'phone');
  assert.equal(suggested['email'], 'email');
  assert.deepEqual(p.mapping.problems, []);
  assert.equal(p.counts.total, 11);
  assert.equal(p.counts.blank, 1);
  assert.deepEqual(p.counts.skipped, { NO_CONTACT: 1, DUPLICATE_IN_FILE: 1, NO_NAME: 1 });
  assert.equal(p.counts.errors, 3);
  assert.equal(p.counts.importable, 7);
  // Same Phone (row 7) duplicates Jane; Opted Out (row 11) matches the opted-out lead.
  assert.equal(p.counts.possibleDuplicates, 2);
  assert.equal(p.counts.optedOut, 1);
  const byRow = new Map<number, any>(p.rows.map((x: any) => [x.rowNumber, x]));
  assert.equal(byRow.get(2).lead.normalized_phone, '+15125550101');
  assert.equal(byRow.get(2).lead.min_budget, 300000);
  assert.equal(byRow.get(3).issue, null, 'an email-only row is importable');
  assert.equal(byRow.get(4).issue, null, 'a phone-only row is importable');
  assert.equal(byRow.get(5).issue, 'NO_CONTACT');
  assert.equal(byRow.get(6).issue, null, 'a bad email with a good phone is a warning, not an error');
  assert.ok(
    byRow.get(6).reviewReasons.some((x: string) => /email/i.test(x)),
    JSON.stringify(byRow.get(6)),
  );
  assert.ok(byRow.get(7).reviewReasons.includes(DUPLICATE_REASON));
  assert.equal(byRow.get(8).issue, 'DUPLICATE_IN_FILE');
  assert.equal(byRow.get(9), undefined, 'a blank row is not shown');
  assert.equal(byRow.get(10).issue, 'NO_NAME');
  assert.ok(byRow.get(12).reviewReasons.includes(PHONE_UNPARSED_REASON));
  // Bad Email and Unparsed Phone: data warnings. Duplicates and opt-outs are counted on their own.
  assert.equal(p.counts.withWarnings, 2);
  assert.equal(
    await prisma.lead_sources.count({ where: { organization_id: A.orgId, provider: FILE_UPLOAD_PROVIDER } }),
    0,
    'preview wrote a source',
  );
  assert.equal(await prisma.leads.count({ where: { organization_id: A.orgId, email: email(1) } }), 0, 'preview wrote a lead');
});

test('preview under the owner’s own mapping, and a mapping that does not fit is reported per column', async () => {
  const own = await upload(`${API}/preview`, A.token, { name: 'leads.csv', bytes: CSV }, { mapping: MAPPING });
  assert.equal(own.status, 200, own.text);
  assert.equal(own.body.counts.importable, 7);
  const bad = await upload(
    `${API}/preview`,
    A.token,
    { name: 'leads.csv', bytes: CSV },
    { mapping: JSON.stringify([{ fieldKey: 'nope', target: 'phone' }]) },
  );
  assert.equal(bad.status, 200, bad.text);
  assert.ok(bad.body.mapping.problems.length >= 2, bad.text);
  assert.equal(bad.body.counts.importable, 0);
  const commit = await upload(
    `${API}/batches`,
    A.token,
    { name: 'leads.csv', bytes: CSV },
    { mapping: JSON.stringify([{ fieldKey: 'nope', target: 'phone' }]), clientToken: randomUUID() },
  );
  assert.equal(commit.status, 400, commit.text);
  assert.equal(commit.body.error.code, 'VALIDATION_ERROR');
  const junk = await upload(
    `${API}/batches`,
    A.token,
    { name: 'leads.csv', bytes: CSV },
    { mapping: '{not json', clientToken: randomUUID() },
  );
  assert.equal(junk.status, 400, junk.text);
  const noToken = await upload(`${API}/batches`, A.token, { name: 'leads.csv', bytes: CSV }, { mapping: MAPPING });
  assert.equal(noToken.status, 400, noToken.text);
});

test('an XLSX previews the same way, with numbers and dates as text', async () => {
  const xlsx = xlsxFixture([
    ['Name', 'Phone', 'Email', 'Added'],
    ['Excel Lead', 5125550131, email(31), { date: new Date(Date.UTC(2026, 9, 1)) }],
    ['Text Phone', '+1 512 555 0132', null, null],
  ]);
  const r = await upload(`${API}/preview`, A.token, { name: 'leads.xlsx', bytes: xlsx });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.file.kind, 'xlsx');
  assert.equal(r.body.counts.importable, 2);
  assert.equal(r.body.rows[0].lead.normalized_phone, '+15125550131');
  assert.equal(r.body.rows[1].lead.normalized_phone, '+15125550132');
});

test('import with nothing ticked: every importable row becomes a paused lead awaiting review; rows with errors are never imported', async () => {
  const token = randomUUID();
  // approveRows [] = the owner unticked everything: nothing is approved on arrival.
  const r = await upload(`${API}/batches`, A.token, { name: 'leads.csv', bytes: CSV }, { mapping: MAPPING, clientToken: token, approveRows: '[]' });
  assert.equal(r.status, 200, r.text);
  const b = r.body;
  batchId = b.id;
  assert.equal(b.kind, 'file_upload');
  assert.equal(b.name, 'leads.csv');
  assert.equal(b.status, 'COMPLETED');
  assert.equal(b.importedBy.id, A.userId);
  assert.equal(b.rows.total, 11);
  assert.equal(b.rows.imported, 7);
  assert.deepEqual(b.rows.skipped, { NO_CONTACT: 1, DUPLICATE_IN_FILE: 1, NO_NAME: 1 });
  assert.equal(b.rows.possibleDuplicates, 2);
  assert.equal(b.rows.dncInherited, 1);
  assert.deepEqual(b.review, { pending: 7, approved: 0, rejected: 0 });
  assert.deepEqual(b.approval, { approved: 0, released: 0, held: [], skipped: [] });
  assert.ok(!JSON.stringify(b).includes('@example.test'), 'the batch summary leaked an email');
  assert.ok(!JSON.stringify(b).includes('555-01'), 'the batch summary leaked a phone');

  const rows = await prisma.sheet_import_rows.findMany({
    where: { organization_id: A.orgId, lead_source_id: batchId },
    include: { leads: true },
  });
  assert.equal(rows.length, 7);
  for (const row of rows) {
    const l = row.leads!;
    assert.equal(row.review_state, 'pending');
    assert.equal(l.status, 'new');
    assert.equal(l.automation_paused, true, 'an imported lead is not paused');
    assert.equal(l.review_reasons[0], FILE_IMPORT_REVIEW_REASON);
    assert.equal(l.first_contact_at, null);
    assert.equal(l.lead_source_id, batchId);
    rowIdOf.set(l.first_name!, row.id);
    leadIdOf.set(l.first_name!, l.id);
  }
  const jane = await prisma.leads.findUniqueOrThrow({ where: { id: leadIdOf.get('Jane')! } });
  assert.equal(jane.last_name, 'Doe');
  assert.equal(jane.normalized_phone, '+15125550101');
  assert.equal(jane.location, 'Austin TX');
  assert.equal(Number(jane.min_budget), 300000);
  assert.equal(Number(jane.max_budget), 450000);
  assert.deepEqual(jane.custom_fields, { Notes: 'first' });
  const emailOnly = await prisma.leads.findUniqueOrThrow({ where: { id: leadIdOf.get('Email')! } });
  assert.equal(emailOnly.phone, null);
  assert.equal(emailOnly.normalized_email, email(2));
  const phoneOnly = await prisma.leads.findUniqueOrThrow({ where: { id: leadIdOf.get('Phone')! } });
  assert.equal(phoneOnly.email, null);
  assert.equal(phoneOnly.normalized_phone, '+15125550103');
  const badEmail = await prisma.leads.findUniqueOrThrow({ where: { id: leadIdOf.get('Bad')! } });
  assert.equal(badEmail.email_valid, false);
  assert.equal(badEmail.normalized_phone, '+15125550105');
  assert.equal(badEmail.email, 'not-an-email', 'the typed value is kept for the owner to see');
  const opted = await prisma.leads.findUniqueOrThrow({ where: { id: leadIdOf.get('Opted')! } });
  assert.equal(opted.dnc_status, true, 'a previously opted-out contact must stay opted out');
  assert.ok((await prisma.leads.findUniqueOrThrow({ where: { id: leadIdOf.get('Same')! } })).review_reasons.includes(DUPLICATE_REASON));
  assert.equal(
    await prisma.leads.count({ where: { organization_id: A.orgId, first_name: 'No' } }),
    0,
    'a row without contact was imported',
  );

  const source = await prisma.lead_sources.findUniqueOrThrow({ where: { id: batchId } });
  assert.equal(source.provider, FILE_UPLOAD_PROVIDER);
  assert.equal(source.connection_method, 'UPLOAD');
  assert.equal(source.code, `upload-${token}`);
  assert.equal(await prisma.lead_source_field_mappings.count({ where: { organization_id: A.orgId, lead_source_id: batchId } }), 8);

  // The same request again: the same batch, nothing twice.
  const again = await upload(`${API}/batches`, A.token, { name: 'leads.csv', bytes: CSV }, { mapping: MAPPING, clientToken: token, approveRows: '[]' });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.body.id, batchId);
  assert.equal(again.body.approval, null, 'a retry that imported nothing approves nothing');
  assert.equal(await prisma.sheet_import_rows.count({ where: { organization_id: A.orgId, lead_source_id: batchId } }), 7);
  assert.equal(await prisma.leads.count({ where: { organization_id: A.orgId, email: email(1) } }), 1);
  // A different token with the same file is a new batch, by the owner's choice — its rows are flagged as possible
  // duplicates, and nothing was ticked, so none of them is approved.
  const twice = await upload(`${API}/batches`, A.token, { name: 'leads.csv', bytes: CSV }, { mapping: MAPPING, clientToken: randomUUID() });
  assert.equal(twice.status, 200, twice.text);
  assert.notEqual(twice.body.id, batchId);
  assert.equal(twice.body.rows.imported, 7);
  assert.equal(twice.body.rows.possibleDuplicates, 7);
  assert.equal(twice.body.approval.approved, 0);
  assert.deepEqual(twice.body.review, { pending: 7, approved: 0, rejected: 0 });
});

test('no imported lead is visible to the outreach watcher', async () => {
  const eligible = await prisma.leads.count({
    where: {
      organization_id: A.orgId,
      lead_source_id: batchId,
      status: 'new',
      automation_paused: false,
      dnc_status: false,
      first_contact_at: null,
    },
  });
  assert.equal(eligible, 0);
});

test('one review queue: sheet rows and file rows together, each naming its source; the filter tells them apart', async () => {
  const all = await call(`${REVIEW}?limit=100`, A.token);
  assert.equal(all.status, 200, all.text);
  assert.equal(all.body.total, 15);
  const kinds = new Map<string, number>();
  for (const i of all.body.items) kinds.set(i.source.kind, (kinds.get(i.source.kind) ?? 0) + 1);
  assert.equal(kinds.get('google_sheets'), 1);
  assert.equal(kinds.get('file_upload'), 14);
  const fileItem = all.body.items.find((i: any) => i.source.id === batchId);
  assert.equal(fileItem.source.name, 'leads.csv');
  assert.ok(fileItem.rowNumber >= 2);
  const sheetItem = all.body.items.find((i: any) => i.source.kind === 'google_sheets');
  assert.equal(sheetItem.source.name, 'Test Sheet › Leads');

  const sheets = await call(`${REVIEW}?source=google_sheets`, A.token);
  assert.equal(sheets.body.total, 1);
  assert.equal(sheets.body.items[0].source.id, sheetSourceId);
  const files = await call(`${REVIEW}?source=file_upload`, A.token);
  assert.equal(files.body.total, 14);
  const one = await call(`${REVIEW}?sourceId=${batchId}`, A.token);
  assert.equal(one.body.total, 7);
  assert.equal((await call(`${REVIEW}?source=nope`, A.token)).status, 400);
  // Nothing of it for another organization; a guessed batch id finds nothing.
  assert.equal((await call(`${REVIEW}?sourceId=${batchId}`, B.token)).body.total, 0);
  assert.equal((await call(`${API}/history`, B.token)).body.imports.length, 0);
});

test('approve and reject file rows through the shared endpoints; the lead list shows only approved ones', async () => {
  const r = await call(`${REVIEW}/approve`, A.token, {
    method: 'POST',
    body: { rowIds: [rowIdOf.get('Jane')!, rowIdOf.get('Email')!, rowIdOf.get('Opted')!] },
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.approved, 3);
  assert.equal(r.body.released, 1, 'only Jane can be dialled and is not opted out');
  const held = Object.fromEntries(r.body.held.map((h: any) => [h.rowId, h.reason]));
  assert.equal(held[rowIdOf.get('Email')!], 'NO_DIALABLE_PHONE');
  assert.equal(held[rowIdOf.get('Opted')!], 'DO_NOT_CONTACT');
  const jane = await prisma.leads.findUniqueOrThrow({ where: { id: leadIdOf.get('Jane')! } });
  assert.equal(jane.automation_paused, false);
  assert.equal(jane.needs_review, false);
  assert.ok(!jane.review_reasons.includes(FILE_IMPORT_REVIEW_REASON), 'the import reason was not spent');
  assert.equal(jane.first_contact_at, null, 'approval must not contact anyone itself');

  const rej = await call(`${REVIEW}/reject`, A.token, { method: 'POST', body: { rowIds: [rowIdOf.get('Bad')!] } });
  assert.equal(rej.body.rejected, 1);
  const bad = await prisma.leads.findUniqueOrThrow({ where: { id: leadIdOf.get('Bad')! } });
  assert.equal(bad.status, 'closed');
  assert.equal(bad.lost_reason, REJECTED_REASON);
  assert.equal(bad.automation_paused, true);
  assert.ok(!bad.review_reasons.includes(FILE_IMPORT_REVIEW_REASON));

  // Another organization cannot decide them; a second decision is a no-op.
  const cross = await call(`${REVIEW}/approve`, B.token, { method: 'POST', body: { rowIds: [rowIdOf.get('Phone')!] } });
  assert.equal(cross.body.approved, 0);
  assert.equal((await prisma.sheet_import_rows.findUniqueOrThrow({ where: { id: rowIdOf.get('Phone')! } })).review_state, 'pending');
  assert.equal((await call(`${REVIEW}/approve`, A.token, { method: 'POST', body: { rowIds: [rowIdOf.get('Jane')!] } })).body.approved, 0);

  const leads = await call('/api/v1/leads?limit=200', A.token);
  assert.equal(leads.status, 200, leads.text);
  const ids = new Set(leads.body.map((l: any) => l.id));
  assert.ok(ids.has(leadIdOf.get('Jane')), 'an approved import is missing from Leads');
  assert.ok(!ids.has(leadIdOf.get('Phone')), 'a pending import is listed in Leads');
  assert.ok(!ids.has(leadIdOf.get('Bad')), 'a rejected import is listed in Leads');
  const janeListed = leads.body.find((l: any) => l.id === leadIdOf.get('Jane'));
  assert.equal(janeListed.source.provider, 'FILE_UPLOAD');
  assert.equal(janeListed.source.connectionMethod, 'UPLOAD');
  // Approved: Jane, Email, Opted — plus the opted-out lead from elsewhere.
  assert.equal(leads.body.length, 4);
  const rejected = await call(`${REVIEW}?state=rejected&source=file_upload`, A.token);
  assert.equal(rejected.body.total, 1);
  assert.equal(rejected.body.items[0].rowId, rowIdOf.get('Bad'));
});

test('history: every import with its source, who uploaded it, and where its rows stand', async () => {
  const r = await call(`${API}/history`, A.token);
  assert.equal(r.status, 200, r.text);
  const imports: any[] = r.body.imports;
  assert.equal(imports.length, 3);
  const batch = imports.find((i) => i.id === batchId);
  assert.equal(batch.kind, 'file_upload');
  assert.equal(batch.name, 'leads.csv');
  assert.equal(batch.importedBy.name, 'Own Er');
  assert.equal(batch.file.kind, 'csv');
  assert.equal(batch.rows.total, 11);
  assert.equal(batch.rows.imported, 7);
  assert.equal(batch.rows.withWarnings, 2);
  assert.deepEqual(batch.review, { pending: 3, approved: 3, rejected: 1 });
  assert.ok(batch.errorSample.some((e: any) => e.row === 5 && e.code === 'NO_CONTACT'));
  const sheet = imports.find((i) => i.id === sheetSourceId);
  assert.equal(sheet.kind, 'google_sheets');
  assert.equal(sheet.rows, null);
  assert.deepEqual(sheet.review, { pending: 1, approved: 0, rejected: 0 });
  assert.equal(sheet.importedBy, null);
});

test('a crash after the batch was recorded but before its rows: the retry finishes it, nothing twice', async () => {
  const token = randomUUID();
  const code = `upload-${token}`;
  const id = newId();
  await prisma.lead_sources.create({
    data: {
      id,
      organization_id: A.orgId,
      name: 'half.csv',
      code,
      source_type: 'other',
      provider: FILE_UPLOAD_PROVIDER,
      connection_method: 'UPLOAD',
      ingest_status: 'IMPORTING',
      mapping_status: 'CONFIGURED',
    },
  });
  const csv = `Name,Phone\nHalf One,+15125550171\nHalf Two,+15125550172\n`;
  const mapping = JSON.stringify([
    { fieldKey: 'name', target: 'full_name' },
    { fieldKey: 'phone', target: 'phone' },
  ]);
  const r = await upload(`${API}/batches`, A.token, { name: 'half.csv', bytes: csv }, { mapping, clientToken: token });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.id, id);
  assert.equal(r.body.rows.imported, 2);
  assert.equal(r.body.status, 'COMPLETED');
  const again = await upload(`${API}/batches`, A.token, { name: 'half.csv', bytes: csv }, { mapping, clientToken: token });
  assert.equal(again.body.id, id);
  assert.equal(await prisma.sheet_import_rows.count({ where: { organization_id: A.orgId, lead_source_id: id } }), 2);
});

test('switches: the upload has its own (FILE_IMPORT_ENABLED); Import Review is open while either import is on', () => {
  // The app's ConfigService was validated at boot, so a switch cannot be
  // flipped on the running server: the guards are exercised directly, and the
  // controllers are checked to run them after the session and owner checks.
  const code = (fn: () => unknown): string | null => {
    try {
      fn();
      return null;
    } catch (e: any) {
      assert.equal(e.getStatus(), 404);
      return e.getResponse().error.code;
    }
  };
  // A ConfigService without validated values falls back to process.env, where this suite switched both on.
  const saved = { sheets: process.env['GOOGLE_SHEETS_ENABLED'], files: process.env['FILE_IMPORT_ENABLED'] };
  delete process.env['GOOGLE_SHEETS_ENABLED'];
  delete process.env['FILE_IMPORT_ENABLED'];
  try {
    assert.equal(
      code(() => new FileImportEnabledGuard(new ConfigService({ FILE_IMPORT_ENABLED: '1' })).canActivate()),
      null,
    );
    assert.equal(
      code(() => new FileImportEnabledGuard(new ConfigService({ GOOGLE_SHEETS_ENABLED: '1' })).canActivate()),
      'FILE_IMPORT_DISABLED',
    );
    assert.equal(
      code(() => new FileImportEnabledGuard(new ConfigService({})).canActivate()),
      'FILE_IMPORT_DISABLED',
    );
    assert.equal(
      code(() => new ImportReviewEnabledGuard(new ConfigService({ FILE_IMPORT_ENABLED: '1' })).canActivate()),
      null,
    );
    assert.equal(
      code(() => new ImportReviewEnabledGuard(new ConfigService({ GOOGLE_SHEETS_ENABLED: '1' })).canActivate()),
      null,
    );
    assert.equal(
      code(() => new ImportReviewEnabledGuard(new ConfigService({})).canActivate()),
      'IMPORT_REVIEW_DISABLED',
    );
    assert.deepEqual(Reflect.getMetadata('__guards__', FileImportController), [SessionGuard, OwnerGuard, FileImportEnabledGuard]);
    assert.deepEqual(Reflect.getMetadata('__guards__', ImportReviewController), [SessionGuard, OwnerGuard, ImportReviewEnabledGuard]);
    assert.deepEqual(Reflect.getMetadata('__guards__', SheetSourcesController), [SessionGuard, OwnerGuard, SheetsEnabledGuard]);
  } finally {
    if (saved.sheets !== undefined) process.env['GOOGLE_SHEETS_ENABLED'] = saved.sheets;
    if (saved.files !== undefined) process.env['FILE_IMPORT_ENABLED'] = saved.files;
  }
});

test('a workbook with several worksheets: the preview lists them, reads the first, and the owner can pick another', async () => {
  const book = xlsxFixture([
    {
      name: 'Leads',
      rows: [
        ['Name', 'Phone'],
        ['First Sheet', '+15125550161'],
      ],
    },
    {
      name: 'Archive',
      rows: [
        ['Name', 'Phone', 'Email'],
        ['Second Sheet', '+15125550162', email(62)],
        ['Third Row', '+15125550163', ''],
      ],
    },
    { name: 'Notes', rows: [] },
  ]);
  const first = await upload(`${API}/preview`, A.token, { name: 'book.xlsx', bytes: book });
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(first.body.file.sheets, ['Leads', 'Archive', 'Notes']);
  assert.equal(first.body.file.sheet, 'Leads');
  assert.equal(first.body.counts.importable, 1);
  const second = await upload(`${API}/preview`, A.token, { name: 'book.xlsx', bytes: book }, { sheet: 'Archive' });
  assert.equal(second.status, 200, second.text);
  assert.equal(second.body.file.sheet, 'Archive');
  assert.equal(second.body.counts.importable, 2);
  assert.deepEqual(
    second.body.headers.map((h: any) => h.fieldKey),
    ['name', 'phone', 'email'],
  );
  const missing = await upload(`${API}/preview`, A.token, { name: 'book.xlsx', bytes: book }, { sheet: 'Nope' });
  assert.equal(missing.status, 400, missing.text);
  assert.equal(missing.body.error.code, 'SHEET_NOT_FOUND');
  const empty = await upload(`${API}/preview`, A.token, { name: 'book.xlsx', bytes: book }, { sheet: 'Notes' });
  assert.equal(empty.status, 400, empty.text);
  assert.equal(empty.body.error.code, 'EMPTY_FILE');
  // A CSV has no worksheets; naming one is harmless.
  const csv = await upload(`${API}/preview`, A.token, { name: 'leads.csv', bytes: CSV }, { sheet: 'Whatever' });
  assert.equal(csv.status, 200, csv.text);
  assert.deepEqual(csv.body.file.sheets, []);

  // Import the second worksheet: the batch is named after it, like a sheet source.
  const mapping = JSON.stringify(second.body.mapping.columns);
  const r = await upload(
    `${API}/batches`,
    A.token,
    { name: 'book.xlsx', bytes: book },
    { mapping, clientToken: randomUUID(), sheet: 'Archive' },
  );
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.name, 'book.xlsx › Archive');
  assert.equal(r.body.file.sheet, 'Archive');
  assert.equal(r.body.rows.imported, 2);
  const names = await prisma.leads.findMany({
    where: { organization_id: A.orgId, lead_source_id: r.body.id },
    select: { first_name: true },
  });
  assert.deepEqual(names.map((l) => l.first_name).sort(), ['Second', 'Third']);
});

test('remove an upload: its pending rows are rejected, approved leads are kept, and it leaves the history', async () => {
  // batchId: Jane, Email, Opted approved; Bad rejected; Phone, Same, Unparsed still pending.
  const before = await call(`${API}/history`, A.token);
  assert.ok(before.body.imports.some((b: any) => b.id === batchId));
  const cross = await fetch(`${base}${API}/batches/${batchId}`, { method: 'DELETE', headers: { authorization: `Bearer ${B.token}` } });
  assert.equal(cross.status, 404, 'another organization removed the batch');
  assert.equal((await prisma.lead_sources.findUniqueOrThrow({ where: { id: batchId } })).archived_at, null);

  const res = await fetch(`${base}${API}/batches/${batchId}`, { method: 'DELETE', headers: { authorization: `Bearer ${A.token}` } });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.deepEqual(body, { removed: true, rejected: 3, approvedKept: 3 });

  const rows = await prisma.sheet_import_rows.findMany({
    where: { organization_id: A.orgId, lead_source_id: batchId },
    include: { leads: true },
  });
  assert.equal(rows.length, 7, 'tracking rows were deleted');
  assert.equal(rows.filter((r) => r.review_state === 'pending').length, 0);
  assert.equal(rows.filter((r) => r.review_state === 'approved').length, 3);
  assert.equal(rows.filter((r) => r.review_state === 'rejected').length, 4);
  const phone = await prisma.leads.findUniqueOrThrow({ where: { id: leadIdOf.get('Phone')! } });
  assert.equal(phone.status, 'closed');
  assert.equal(phone.lost_reason, REJECTED_REASON);
  assert.equal(phone.automation_paused, true);
  const jane = await prisma.leads.findUniqueOrThrow({ where: { id: leadIdOf.get('Jane')! } });
  assert.equal(jane.status, 'new', 'an approved lead was touched by the removal');
  assert.equal(jane.automation_paused, false);

  const source = await prisma.lead_sources.findUniqueOrThrow({ where: { id: batchId } });
  assert.ok(source.archived_at, 'the batch was not archived');
  assert.equal(source.ingest_status, 'REMOVED');
  const after = await call(`${API}/history`, A.token);
  assert.ok(!after.body.imports.some((b: any) => b.id === batchId), 'a removed batch is still in the history');
  // Its rejected rows stay on the Rejected tab, under the file's name; nothing of it is pending.
  const rejected = await call(`${REVIEW}?state=rejected&sourceId=${batchId}`, A.token);
  assert.equal(rejected.body.total, 4);
  assert.equal(rejected.body.items[0].source.name, 'leads.csv');
  assert.equal((await call(`${REVIEW}?sourceId=${batchId}`, A.token)).body.total, 0);
  const leads = await call('/api/v1/leads?limit=200', A.token);
  const ids = new Set(leads.body.map((l: any) => l.id));
  assert.ok(ids.has(leadIdOf.get('Jane')), 'an approved lead vanished from Leads');
  assert.ok(!ids.has(leadIdOf.get('Phone')));
  // Removing it again, or a batch that never existed, is a 404.
  const again = await fetch(`${base}${API}/batches/${batchId}`, { method: 'DELETE', headers: { authorization: `Bearer ${A.token}` } });
  assert.equal(again.status, 404);
  const none = await fetch(`${base}${API}/batches/${newId()}`, { method: 'DELETE', headers: { authorization: `Bearer ${A.token}` } });
  assert.equal(none.status, 404);
  const audit = await prisma.audit_logs.findFirst({
    where: { organization_id: A.orgId, action: 'file_import.removed', entity_id: batchId },
  });
  assert.deepEqual(audit?.payload, { rejected: 3, approvedKept: 3 });
});

test('import only the clean rows: they are approved at once; flagged rows are left out entirely', async () => {
  const csv =
    'Name,Phone,Email\n' +
    `Clean One,+15125550321,${email(321)}\n` +
    `Clean Two,+15125550322,${email(322)}\n` +
    `Bad Email,+15125550323,not-an-email\n` + // a data warning
    `Opted Four,+15125550196,${email(324)}\n` + // matches the opted-out contact
    `Clean One,+15125550321,${email(325)}\n`; // same phone as row 2: a possible duplicate
  const mapping = JSON.stringify([
    { fieldKey: 'name', target: 'full_name' },
    { fieldKey: 'phone', target: 'phone' },
    { fieldKey: 'email', target: 'email' },
  ]);
  const r = await upload(`${API}/batches`, A.token, { name: 'clean.csv', bytes: csv }, { mapping, clientToken: randomUUID(), onlyClean: '1' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.rows.imported, 2);
  assert.equal(r.body.rows.flaggedLeftOut, 3);
  assert.deepEqual(r.body.review, { pending: 0, approved: 2, rejected: 0 });
  assert.equal(r.body.approval.approved, 2);
  assert.equal(r.body.approval.released, 2);
  const rows = await prisma.sheet_import_rows.findMany({
    where: { organization_id: A.orgId, lead_source_id: r.body.id },
    include: { leads: true },
    orderBy: { row_number: 'asc' },
  });
  assert.deepEqual(
    rows.map((x) => [x.row_number, x.review_state, x.leads!.automation_paused]),
    [
      [2, 'approved', false],
      [3, 'approved', false],
    ],
  );
  assert.equal(await prisma.leads.count({ where: { organization_id: A.orgId, lead_source_id: r.body.id } }), 2, 'a flagged row was imported');
  // A file where every importable row is flagged has nothing to import this way.
  const allFlagged = await upload(
    `${API}/batches`,
    A.token,
    { name: 'flagged.csv', bytes: 'Name,Phone,Email\nOpted Only,+15125550196,x@example.test\n' },
    { mapping, clientToken: randomUUID(), onlyClean: '1' },
  );
  assert.equal(allFlagged.status, 400, allFlagged.text);
  assert.equal(allFlagged.body.error.code, 'NO_CLEAN_ROWS');
});

test('a pending row whose lead was deleted out of band is neither waiting for review nor counted', async () => {
  const csv = 'Name,Phone,Email\n' + `Gone One,+15125550331,${email(331)}\n` + `Kept Two,+15125550332,${email(332)}\n`;
  const mapping = JSON.stringify([
    { fieldKey: 'name', target: 'full_name' },
    { fieldKey: 'phone', target: 'phone' },
    { fieldKey: 'email', target: 'email' },
  ]);
  const r = await upload(`${API}/batches`, A.token, { name: 'gone.csv', bytes: csv }, { mapping, clientToken: randomUUID(), approveRows: '[]' });
  assert.equal(r.status, 200, r.text);
  const rows = await prisma.sheet_import_rows.findMany({ where: { organization_id: A.orgId, lead_source_id: r.body.id }, orderBy: { row_number: 'asc' } });
  assert.equal(rows.length, 2);
  // The FK sets the row's lead_id to NULL; the row itself stays pending.
  await prisma.leads.delete({ where: { id: rows[0].lead_id! } });
  const queue = await call(`${REVIEW}?sourceId=${r.body.id}`, A.token);
  assert.equal(queue.status, 200, queue.text);
  assert.equal(queue.body.total, 1);
  assert.deepEqual(queue.body.items.map((i: any) => i.rowId), [rows[1].id]);
  const batch = (await call(`${API}/history`, A.token)).body.imports.find((b: any) => b.id === r.body.id);
  assert.deepEqual(batch.review, { pending: 1, approved: 0, rejected: 0 });
});

test('approve on import: only the ticked rows are approved as they land; a ticked flagged row is approved too', async () => {
  const csv =
    'Name,Phone,Email\n' +
    `Clean A,+15125550341,${email(341)}\n` +
    `Clean B,+15125550342,${email(342)}\n` +
    `Bad Email,+15125550343,not-an-email\n` + // a data warning: flagged
    `Opted D,+15125550196,${email(344)}\n`; // matches the opted-out contact: flagged
  const mapping = JSON.stringify([
    { fieldKey: 'name', target: 'full_name' },
    { fieldKey: 'phone', target: 'phone' },
    { fieldKey: 'email', target: 'email' },
  ]);
  const states = async (id: string) =>
    (await prisma.sheet_import_rows.findMany({ where: { organization_id: A.orgId, lead_source_id: id }, include: { leads: true }, orderBy: { row_number: 'asc' } })).map(
      (x) => [x.row_number, x.review_state, x.leads!.automation_paused, x.reviewed_by === A.userId],
    );

  // Nothing said about approval: every row waits in Import Review, as with a sheet.
  const byDefault = await upload(`${API}/batches`, A.token, { name: 'default.csv', bytes: csv }, { mapping, clientToken: randomUUID() });
  assert.equal(byDefault.status, 200, byDefault.text);
  assert.equal(byDefault.body.rows.imported, 4);
  assert.deepEqual(byDefault.body.review, { pending: 4, approved: 0, rejected: 0 });
  assert.deepEqual(byDefault.body.approval, { approved: 0, released: 0, held: [], skipped: [] });
  assert.deepEqual(await states(byDefault.body.id), [
    [2, 'pending', true, false],
    [3, 'pending', true, false],
    [4, 'pending', true, false],
    [5, 'pending', true, false],
  ]);

  // The owner unticked Clean A and ticked Bad Email: exactly those choices are honoured. Row 99 is nobody.
  const ticked = await upload(
    `${API}/batches`,
    A.token,
    { name: 'ticked.csv', bytes: csv },
    { mapping, clientToken: randomUUID(), approveRows: JSON.stringify([3, 4, 99]) },
  );
  assert.equal(ticked.status, 200, ticked.text);
  assert.equal(ticked.body.approval.approved, 2);
  assert.equal(ticked.body.approval.released, 2, 'a bad email with a good phone can still be dialled');
  assert.deepEqual(await states(ticked.body.id), [
    [2, 'pending', true, false],
    [3, 'approved', false, true],
    [4, 'approved', false, true],
    [5, 'pending', true, false],
  ]);
  const inLeads = new Set((await call('/api/v1/leads?limit=200', A.token)).body.map((l: any) => l.id));
  const tickedRows = await prisma.sheet_import_rows.findMany({ where: { organization_id: A.orgId, lead_source_id: ticked.body.id }, orderBy: { row_number: 'asc' } });
  assert.ok(inLeads.has(tickedRows[1].lead_id) && inLeads.has(tickedRows[2].lead_id), 'approved rows are missing from Leads');
  assert.ok(!inLeads.has(tickedRows[0].lead_id) && !inLeads.has(tickedRows[3].lead_id), 'a pending row is listed in Leads');
  // Approved on the owner's behalf: the audit names them, never "system".
  const tickedLeadIds = tickedRows.map((x) => x.lead_id!);
  assert.equal(
    await prisma.audit_logs.count({ where: { organization_id: A.orgId, action: 'sheet_import.approved', actor_type: 'user', actor_id: A.userId, entity_id: { in: tickedLeadIds } } }),
    2,
  );
  assert.equal(await prisma.audit_logs.count({ where: { organization_id: A.orgId, action: 'sheet_import.auto_approved', entity_id: { in: tickedLeadIds } } }), 0);

  // Bad approval lists are refused before anything is written.
  for (const bad of ['{not json', JSON.stringify([1]), JSON.stringify(['2']), JSON.stringify(Array.from({ length: 10_001 }, (_, i) => i + 2))]) {
    const res = await upload(`${API}/batches`, A.token, { name: 'bad-ticks.csv', bytes: csv }, { mapping, clientToken: randomUUID(), approveRows: bad });
    assert.equal(res.status, 400, `${bad.slice(0, 20)}: ${res.text}`);
  }
  assert.equal(await prisma.lead_sources.count({ where: { organization_id: A.orgId, name: 'bad-ticks.csv' } }), 0);
});
