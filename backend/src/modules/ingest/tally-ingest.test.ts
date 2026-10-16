import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { createHmac } from 'node:crypto';
import { AuthModule } from '../../auth/auth.module';
import { envSchema } from '../../app.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { EventsModule } from '../events/events.module';
import { LeadSourcesModule } from '../lead-sources/lead-sources.module';
import { IngestModule } from './ingest.module';

/**
 * Characterization suite for the Tally webhook path, against the REAL database:
 *
 *   POST ingest/v1/tally/:token -> webhook_events -> ProcessingWorker -> leads
 *
 * plus the deliveries read-back the Lead Sources screen uses. It pins today's
 * behaviour — status codes, dedupe, quarantine, the auto-mapped lead, the
 * NEEDS_IDENTITY outcome and the deliveries response shape — so that work on
 * other ingest paths can prove it changed nothing here. Run with
 * `npm run test:tally-ingest`.
 *
 * The worker runs in-process here (it is what turns a delivery into a lead);
 * every outreach poller stays off, so nothing can text or call anyone.
 */
process.env['STRATEGY_ENGINE'] = '0';
process.env['CALENDAR_SYNC'] = '0';
// Set, not deleted: ConfigModule re-reads backend/.env, where these may be on.
process.env['SHEETS_SYNC'] = '0';
process.env['SHEETS_VERSION_PROBE'] = '0';
// The ingest route nudges the worker, so the poll can stay slow: a fast poll
// competes with the requests for the suite's two pooled connections.
process.env['WORKER_ENABLED'] = 'true';
process.env['WORKER_POLL_INTERVAL_MS'] = '1000';
delete process.env['SMTP_HOST'];
// The worker polls beside the requests here, so the two pooled connections
// test-setup leaves a plain suite are not enough: an interactive transaction
// (signup) would wait on the worker's claim and time out.
if (process.env['DATABASE_URL']) {
  const url = new URL(process.env['DATABASE_URL']);
  url.searchParams.set('connection_limit', '5');
  process.env['DATABASE_URL'] = url.toString();
}

/* eslint-disable @typescript-eslint/no-explicit-any */

const RUN = Date.now().toString(36);
const PASSWORD = 'correct-horse-battery-staple';

let app: INestApplication;
let prisma: PrismaService;
let base: string;
const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];

let owner = { token: '', orgId: '' };
let source = { id: '', token: '', secret: '' };
/** A second source, so the unsigned case leaves the first source's read-back untouched. */
let unsignedSource = { id: '', token: '', secret: '' };
/** Delivery ids in the order they were posted, for the read-back assertions. */
const posted: { processed?: string; quarantined?: string; identity?: string } = {};

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

async function signupOwner(tag: string) {
  const res = await call('/api/auth/signup', undefined, {
    method: 'POST',
    body: {
      email: `tally-ingest-${RUN}-${tag}@example.invalid`,
      password: PASSWORD,
      firstName: 'Own',
      lastName: 'Er',
      organizationName: `TallyIngest ${tag} ${RUN}`,
    },
  });
  assert.equal(res.status, 201, res.text);
  createdUserIds.push(res.body.user.id);
  createdOrgIds.push(res.body.organization.id);
  return { token: res.body.token as string, orgId: res.body.organization.id as string };
}

/** Exactly what Tally sends: base64(HMAC-SHA256(secret, raw bytes)). */
const sign = (raw: string, secret: string) => createHmac('sha256', secret).update(raw).digest('base64');

/** Posts raw bytes to the public ingest route, signed unless told otherwise. */
async function deliver(raw: string, opts: { signature?: string | null; token?: string } = {}) {
  const signature = opts.signature === undefined ? sign(raw, source.secret) : opts.signature;
  const res = await fetch(`${base}/ingest/v1/tally/${opts.token ?? source.token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(signature ? { 'tally-signature': signature } : {}) },
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

/** A Tally FORM_RESPONSE: name, email, phone and a timeline dropdown. */
const tallyPayload = (eventId: string, fields: unknown[]) =>
  JSON.stringify({
    eventId,
    eventType: 'FORM_RESPONSE',
    createdAt: '2026-10-15T10:00:00.000Z',
    data: {
      responseId: `resp_${eventId}`,
      submissionId: `sub_${eventId}`,
      respondentId: `rsp_${RUN}`,
      formId: 'form_1',
      formName: 'Buyer Inquiry',
      createdAt: '2026-10-15T09:59:58.000Z',
      fields,
    },
  });

const FULL_FIELDS = [
  { key: 'question_1', label: 'Your name', type: 'INPUT_TEXT', value: 'Brandon Hayes' },
  { key: 'question_2', label: 'Email address', type: 'INPUT_EMAIL', value: 'B.Hayes@Example.com' },
  { key: 'question_3', label: 'Phone', type: 'INPUT_PHONE_NUMBER', value: '(512) 555-0101' },
  {
    key: 'question_4',
    label: 'When are you looking to move?',
    type: 'MULTIPLE_CHOICE',
    value: ['opt_a'],
    options: [
      { id: 'opt_a', text: 'ASAP / under 30 days' },
      { id: 'opt_b', text: '1-3 months' },
    ],
  },
];

/** Polls until the worker has finished with a delivery. */
async function processed(eventId: string, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const row = await prisma.webhook_events.findUnique({ where: { id: eventId } });
    if (row && row.queue_state !== 'PENDING' && row.queue_state !== 'PROCESSING') return row;
    if (Date.now() > until) throw new Error(`delivery ${eventId} still ${row?.queue_state ?? 'missing'} after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

before(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, validate: (raw) => ({ ...raw, ...envSchema.parse(raw) }) }),
      PrismaModule,
      EventsModule,
      AuthModule,
      LeadSourcesModule,
      IngestModule,
    ],
  }).compile();
  // rawBody: the signature is computed over the exact bytes, as server.ts does.
  app = moduleRef.createNestApplication({ rawBody: true });
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  prisma = app.get(PrismaService);

  owner = await signupOwner('a');
  const createSource = async (name: string) => {
    const created = await call('/api/v1/lead-sources', owner.token, { method: 'POST', body: { name } });
    assert.equal(created.status, 201, created.text);
    const made = {
      id: created.body.id as string,
      token: String(created.body.webhookUrl).split('/').pop()!,
      secret: created.body.signingSecret as string,
    };
    assert.match(made.token, /^whk_live_[0-9A-HJKMNP-TV-Z]{20}$/);
    assert.match(made.secret, /^whsec_/);
    return made;
  };
  source = await createSource('Buyer Inquiry (Tally)');
  unsignedSource = await createSource('Unsigned (Tally)');
});

after(async () => {
  try {
    for (const orgId of createdOrgIds) {
      // Submissions cascade from their deliveries; leads before sources.
      await prisma.webhook_events.deleteMany({ where: { organization_id: orgId } });
      await prisma.leads.deleteMany({ where: { organization_id: orgId } });
      await prisma.domain_events.deleteMany({ where: { organization_id: orgId } });
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

test('a signed delivery is accepted with 202 and becomes an auto-mapped lead with normalized phone and email', async () => {
  const eventId = `evt_${RUN}_1`;
  const res = await deliver(tallyPayload(eventId, FULL_FIELDS));
  assert.equal(res.status, 202, res.text);
  assert.equal(res.body.received, true);
  assert.ok(res.body.deliveryId);
  posted.processed = res.body.deliveryId;

  const row = await processed(res.body.deliveryId);
  assert.equal(row.provider, 'TALLY');
  assert.equal(row.event_type, 'FORM_RESPONSE');
  assert.equal(row.external_event_id, eventId);
  assert.equal(row.dedupe_key, `tally:${eventId}`);
  assert.equal(row.signature_state, 'VALID');
  assert.equal(row.signature_verified, true);
  assert.equal(row.queue_state, 'DONE');
  // WITH_WARNINGS, because the heuristics also guess buying_intent for the
  // timeline dropdown (its option text matches no intent) — see the trace.
  assert.equal(row.outcome, 'PROCESSED_WITH_WARNINGS');
  assert.equal(row.outcome_reason, null);
  // The legacy column reads 'failed' for anything but a clean PROCESSED.
  assert.equal(row.processing_status, 'failed');
  assert.ok(row.lead_id, 'the delivery points at the lead it produced');
  assert.ok(row.raw_body && row.raw_body.includes('"eventId"'), 'the exact bytes are retained');
  assert.ok(Array.isArray(row.mapping_trace));

  const lead = await prisma.leads.findUnique({ where: { id: row.lead_id! } });
  assert.ok(lead);
  assert.equal(lead.organization_id, owner.orgId);
  assert.equal(lead.lead_source_id, source.id);
  assert.equal(lead.first_name, 'Brandon');
  assert.equal(lead.last_name, 'Hayes');
  assert.equal(lead.email, 'b.hayes@example.com');
  assert.equal(lead.normalized_email, 'b.hayes@example.com');
  assert.equal(lead.email_valid, true);
  assert.equal(lead.phone, '+15125550101');
  assert.equal(lead.normalized_phone, '+15125550101');
  assert.equal(lead.phone_valid, true);
  assert.equal(lead.timeline, 'under_30_days');
  assert.equal(lead.buying_intent, null);
  assert.equal(lead.status, 'new');
  assert.equal(lead.needs_review, false);
  assert.deepEqual(lead.review_reasons, []);
  assert.equal(lead.automation_paused, false);
  assert.equal(lead.consent_status, 'pending');
  assert.equal(lead.temperature, 'cold');
  assert.equal(lead.submission_count, 1);

  const submission = await prisma.lead_submissions.findUnique({ where: { webhook_event_id: row.id } });
  assert.ok(submission);
  assert.equal(submission.lead_id, lead.id);
  assert.equal(submission.is_first_for_lead, true);

  // First sight of the form: the heuristics mapped it and asked for a review.
  const src = await prisma.lead_sources.findUnique({ where: { id: source.id } });
  assert.equal(src?.ingest_status, 'ACTIVE');
  assert.equal(src?.mapping_status, 'NEEDS_REVIEW');
  const mappings = await prisma.lead_source_field_mappings.findMany({ where: { lead_source_id: source.id }, orderBy: [{ source_field_key: 'asc' }, { target_field: 'asc' }] });
  assert.deepEqual(
    mappings.map((m) => [m.source_field_key, m.target_field, m.origin]),
    [
      ['question_1', 'first_name', 'HEURISTIC'],
      ['question_1', 'last_name', 'HEURISTIC'],
      ['question_2', 'email', 'HEURISTIC'],
      ['question_3', 'phone', 'HEURISTIC'],
      ['question_4', 'buying_intent', 'HEURISTIC'],
      ['question_4', 'timeline', 'HEURISTIC'],
    ],
  );
  const fields = await prisma.lead_source_fields.findMany({ where: { lead_source_id: source.id }, orderBy: { field_key: 'asc' } });
  assert.deepEqual(
    fields.map((f) => f.field_key),
    ['question_1', 'question_2', 'question_3', 'question_4'],
  );
});

test('the same delivery again is a 200 duplicate that creates nothing', async () => {
  const res = await deliver(tallyPayload(`evt_${RUN}_1`, FULL_FIELDS));
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body, { received: true, duplicate: true, deliveryId: posted.processed });
  assert.equal(await prisma.webhook_events.count({ where: { lead_source_id: source.id } }), 1);
  assert.equal(await prisma.leads.count({ where: { lead_source_id: source.id } }), 1);
});

test('a bad signature is quarantined with 401: stored with its raw bytes, never processed', async () => {
  const eventId = `evt_${RUN}_2`;
  const raw = tallyPayload(eventId, FULL_FIELDS);
  const res = await deliver(raw, { signature: sign(raw, 'whsec_not_the_secret') });
  assert.equal(res.status, 401, res.text);
  assert.equal(res.body.error, 'invalid_signature');
  assert.ok(res.body.deliveryId);
  posted.quarantined = res.body.deliveryId;

  const row = await prisma.webhook_events.findUnique({ where: { id: res.body.deliveryId } });
  assert.ok(row);
  assert.equal(row.signature_state, 'INVALID');
  assert.equal(row.signature_verified, false);
  assert.equal(row.queue_state, 'FAILED');
  assert.equal(row.outcome, 'QUARANTINED_SIGNATURE');
  assert.equal(row.outcome_reason, 'invalid_signature');
  assert.equal(row.processing_status, 'failed');
  assert.equal(row.raw_body, raw);
  assert.equal(row.lead_id, null);

  // Give the worker a moment: a quarantined row must never be picked up.
  await new Promise((r) => setTimeout(r, 600));
  const again = await prisma.webhook_events.findUnique({ where: { id: res.body.deliveryId } });
  assert.equal(again?.queue_state, 'FAILED');
  assert.equal(await prisma.leads.count({ where: { lead_source_id: source.id } }), 1);
});

test('an unsigned delivery is accepted while a signature is not required', async () => {
  const eventId = `evt_${RUN}_3`;
  const res = await deliver(tallyPayload(eventId, FULL_FIELDS), { signature: null, token: unsignedSource.token });
  assert.equal(res.status, 202, res.text);
  const row = await processed(res.body.deliveryId);
  assert.equal(row.lead_source_id, unsignedSource.id);
  assert.equal(row.signature_state, 'MISSING');
  assert.equal(row.signature_verified, false);
  assert.equal(row.outcome, 'PROCESSED_WITH_WARNINGS');
  assert.ok(row.lead_id);
});

test('a mapped delivery with neither phone nor email ends as NEEDS_IDENTITY: stored, replayable, no lead', async () => {
  const eventId = `evt_${RUN}_4`;
  const res = await deliver(tallyPayload(eventId, [{ key: 'question_1', label: 'Your name', type: 'INPUT_TEXT', value: 'Nameless Nobody' }]));
  assert.equal(res.status, 202, res.text);
  posted.identity = res.body.deliveryId;

  const row = await processed(res.body.deliveryId);
  assert.equal(row.queue_state, 'DONE');
  assert.equal(row.outcome, 'NEEDS_IDENTITY');
  assert.equal(row.outcome_reason, 'no_phone_or_email');
  assert.equal(row.processing_status, 'failed');
  assert.equal(row.lead_id, null);
  // One question, two trace entries: "Your name" feeds first_name and last_name.
  assert.ok(Array.isArray(row.mapping_trace) && (row.mapping_trace as any[]).length === 2);
  assert.equal(await prisma.leads.count({ where: { lead_source_id: source.id } }), 1);
  assert.equal(await prisma.lead_submissions.count({ where: { webhook_event_id: row.id } }), 0);
});

test('an unknown or malformed token is a 404 with nothing stored', async () => {
  const unknown = await deliver(tallyPayload(`evt_${RUN}_5`, FULL_FIELDS), { token: 'whk_live_ZZZZZZZZZZZZZZZZZZZZ', signature: null });
  assert.equal(unknown.status, 404, unknown.text);
  assert.deepEqual(unknown.body, { error: 'not_found' });
  const malformed = await deliver(tallyPayload(`evt_${RUN}_6`, FULL_FIELDS), { token: 'nope', signature: null });
  assert.equal(malformed.status, 404, malformed.text);
  assert.equal(await prisma.webhook_events.count({ where: { lead_source_id: source.id } }), 3);
});

test('deliveries read back newest first, parsed and joined to the mapping trace, in exactly this shape', async () => {
  const res = await call(`/api/v1/lead-sources/${source.id}/deliveries`, owner.token);
  assert.equal(res.status, 200, res.text);
  const rows = res.body as any[];
  assert.deepEqual(
    rows.map((r) => r.id),
    [posted.identity, posted.quarantined, posted.processed],
  );
  const KEYS = [
    'id', 'receivedAt', 'providerEventId', 'signatureState', 'usedPreviousSecret', 'queueState', 'outcome',
    'outcomeReason', 'errorMessage', 'bodyBytes', 'formName', 'answers', 'parseError', 'mapping',
  ];
  for (const r of rows) assert.deepEqual(Object.keys(r), KEYS);

  const [identity, quarantined, done] = rows;

  assert.equal(done.providerEventId, `evt_${RUN}_1`);
  assert.equal(done.signatureState, 'VALID');
  assert.equal(done.usedPreviousSecret, false);
  assert.equal(done.queueState, 'DONE');
  assert.equal(done.outcome, 'PROCESSED_WITH_WARNINGS');
  assert.equal(done.formName, 'Buyer Inquiry');
  assert.equal(done.parseError, null);
  assert.equal(typeof done.bodyBytes, 'number');
  assert.deepEqual(done.mapping, { mapped: 6, unmapped: 0, errored: 0, warnings: 1 });
  // A question feeding two targets lists both; their order follows the mapping
  // rows, which carry no order, so compare them sorted.
  const sortedTargets = (a: any) => ({ ...a, targetFields: [...a.targetFields].sort() });
  assert.deepEqual(done.answers.map(sortedTargets), [
    { label: 'Your name', type: 'INPUT_TEXT', value: 'Brandon Hayes', targetFields: ['first_name', 'last_name'], mappingOutcome: 'mapped', warnings: [] },
    { label: 'Email address', type: 'INPUT_EMAIL', value: 'B.Hayes@Example.com', targetFields: ['email'], mappingOutcome: 'mapped', warnings: [] },
    { label: 'Phone', type: 'INPUT_PHONE_NUMBER', value: '(512) 555-0101', targetFields: ['phone'], mappingOutcome: 'mapped', warnings: [] },
    // Option id already resolved to its text by the adapter. The heuristics
    // also guessed buying_intent for this question; that guess warns.
    {
      label: 'When are you looking to move?',
      type: 'MULTIPLE_CHOICE',
      value: 'ASAP / under 30 days',
      targetFields: ['buying_intent', 'timeline'],
      mappingOutcome: 'mapped',
      warnings: ['Unrecognised option "ASAP / under 30 days"'],
    },
  ]);

  assert.equal(quarantined.outcome, 'QUARANTINED_SIGNATURE');
  assert.equal(quarantined.signatureState, 'INVALID');
  assert.equal(quarantined.queueState, 'FAILED');
  assert.equal(quarantined.mapping, null);
  // The payload is still readable: the answers show, just with nowhere they went.
  assert.equal(quarantined.answers.length, 4);
  assert.deepEqual(quarantined.answers.map((a: any) => [a.targetFields, a.mappingOutcome]), [[[], null], [[], null], [[], null], [[], null]]);

  assert.equal(identity.outcome, 'NEEDS_IDENTITY');
  assert.equal(identity.outcomeReason, 'no_phone_or_email');
  assert.deepEqual(identity.mapping, { mapped: 2, unmapped: 0, errored: 0, warnings: 0 });
  assert.deepEqual(identity.answers.map(sortedTargets), [
    { label: 'Your name', type: 'INPUT_TEXT', value: 'Nameless Nobody', targetFields: ['first_name', 'last_name'], mappingOutcome: 'mapped', warnings: [] },
  ]);

  // Never a secret in the read-back.
  assert.ok(!/signing_secret|secret_enc|ingest_token_enc|tally-signature":"[^[]/.test(res.text));
});

test('the source list counts 3 deliveries and 1 lead for this source', async () => {
  const res = await call('/api/v1/lead-sources', owner.token);
  assert.equal(res.status, 200, res.text);
  const mine = (res.body as any[]).find((s) => s.id === source.id);
  assert.ok(mine);
  assert.equal(mine.deliveryCount, 3);
  assert.equal(mine.leadCount, 1);
  assert.equal(mine.ingestStatus, 'ACTIVE');
  assert.equal(mine.mappingStatus, 'NEEDS_REVIEW');
  assert.equal(mine.webhookUrl, `${process.env['PUBLIC_API_BASE_URL']}/ingest/v1/tally/${source.token}`);
});
