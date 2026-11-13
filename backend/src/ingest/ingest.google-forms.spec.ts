import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex, verifyTypeformSignature } from '@/common/utils/crypto';
import { GOOGLE_FORMS_EVENT_TYPE, RESPONSE_EDITED_REASON } from '@/google-forms/constants';
import { IngestService } from './ingest.service';

/**
 * The Google Forms ingest route, exercised through IngestService with fake
 * storage. What is being checked here is the part an attacker reaches: which
 * token is accepted on which route, what an unsigned body gets, and that a
 * response delivered twice can only ever become one lead.
 */

const SECRET = 'whsec_test_secret_value';
const TOKEN = 'whk_live_ABCDEFGHJKMNPQRSTVWX';

const body = (over: Record<string, unknown> = {}) =>
  Buffer.from(
    JSON.stringify({
      source: 'google_forms',
      version: 1,
      formId: 'form-1',
      responseId: 'ACYDBNj_1',
      submittedAt: '2026-11-12T10:00:00.000Z',
      questions: [{ key: 'q_email', title: 'Email', type: 'TEXT', values: ['manish@example.test'] }],
      ...over,
    }),
  );

/** Exactly what the generated Apps Script computes. */
const sign = (raw: Buffer, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(raw).digest('base64')}`;

const source = (over: Record<string, unknown> = {}) => ({
  id: 'src-1',
  orgId: 'org-1',
  provider: 'GOOGLE_FORMS',
  archivedAt: null,
  isActive: true,
  ingestStatus: 'ACTIVE',
  mappingStatus: 'CONFIGURED',
  requireSignature: true,
  signingSecretEnc: 'sealed',
  previousSecretEnc: null,
  previousSecretValidUntil: null,
  ...over,
});

function build(row: Record<string, unknown> | null, existing: Record<string, unknown> | null = null) {
  const created = { count: existing ? 0 : 1 };
  const lead = { id: 'lead-1', reviewReasons: [] as string[] };
  const prisma = {
    leadSource: { findUnique: vi.fn().mockResolvedValue(row), update: vi.fn().mockResolvedValue({}) },
    ingestEvent: {
      createMany: vi.fn().mockResolvedValue(created),
      findUnique: vi.fn().mockResolvedValue(existing),
    },
    lead: { findUnique: vi.fn().mockResolvedValue(lead), update: vi.fn().mockResolvedValue(lead) },
  };
  const secrets = { open: vi.fn().mockReturnValue(SECRET) };
  const events = { publish: vi.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new IngestService(prisma as any, secrets as any, events as any);
  return { service, prisma };
}

const receive = (
  service: IngestService,
  opts: { route?: 'GOOGLE_FORMS' | 'WEBHOOK' | 'TALLY'; raw?: Buffer; signature?: string | undefined } = {},
) => {
  const raw = opts.raw ?? body();
  return service.receive({
    route: opts.route ?? 'GOOGLE_FORMS',
    token: TOKEN,
    rawBody: raw,
    headers: {},
    signature: 'signature' in opts ? opts.signature : sign(raw),
  });
};

describe('the signature the Apps Script produces', () => {
  it('is the one the ingest route verifies', () => {
    const raw = body();
    expect(verifyTypeformSignature(raw, SECRET, sign(raw))).toBe(true);
  });

  it('fails for the wrong key, a changed body, or a missing prefix', () => {
    const raw = body();
    expect(verifyTypeformSignature(raw, 'other_secret', sign(raw))).toBe(false);
    expect(verifyTypeformSignature(body({ responseId: 'tampered' }), SECRET, sign(raw))).toBe(false);
    expect(verifyTypeformSignature(raw, SECRET, 'sha256=not-a-signature')).toBe(false);
  });
});

describe('a signed Google Forms delivery', () => {
  it('is accepted and stored once', async () => {
    const { service, prisma } = build(source());
    const result = await receive(service);

    expect(result.kind).toBe('accepted');
    const stored = prisma.ingestEvent.createMany.mock.calls[0][0].data[0];
    // The dedupe key is what makes a redelivery or a poll recovery land on
    // this same row: organization and form are fixed by the source id.
    expect(stored.dedupeKey).toBe('GOOGLE_FORMS:ACYDBNj_1');
    expect(stored.orgId).toBe('org-1');
    expect(stored.leadSourceId).toBe('src-1');
    expect(stored.providerEventId).toBe('ACYDBNj_1');
    expect(stored.eventType).toBe(GOOGLE_FORMS_EVENT_TYPE);
  });

  it('is quarantined when it carries no signature, because the source requires one', async () => {
    const { service } = build(source());
    const result = await receive(service, { signature: undefined });
    expect(result).toMatchObject({ kind: 'quarantined', reason: 'signature_required' });
  });

  it('is quarantined when the body was changed after signing', async () => {
    const { service } = build(source());
    const result = await receive(service, { raw: body({ responseId: 'tampered' }), signature: sign(body()) });
    expect(result).toMatchObject({ kind: 'quarantined', reason: 'invalid_signature' });
  });

  it('is refused when the payload is not a Google Forms response', async () => {
    const { service } = build(source());
    const raw = Buffer.from(JSON.stringify({ hello: 'world' }));
    const result = await receive(service, { raw, signature: sign(raw) });
    expect(result.kind).toBe('invalid_payload');
  });
});

describe('a token is only good on its own route', () => {
  it('refuses a Google Forms token on the generic webhook route', async () => {
    // Otherwise a leaked script token could be replayed somewhere that does
    // not insist on the signature.
    const { service, prisma } = build(source());
    expect(await receive(service, { route: 'WEBHOOK', signature: undefined })).toEqual({ kind: 'unknown_token' });
    expect(prisma.ingestEvent.createMany).not.toHaveBeenCalled();
  });

  it('refuses another provider’s token on the Google Forms route', async () => {
    const { service, prisma } = build(source({ provider: 'TALLY' }));
    expect(await receive(service)).toEqual({ kind: 'unknown_token' });
    expect(prisma.ingestEvent.createMany).not.toHaveBeenCalled();
  });

  it('refuses a token that belongs to no source, without saying why', async () => {
    const { service } = build(null);
    expect(await receive(service)).toEqual({ kind: 'unknown_token' });
  });

  it('tells a removed form’s script to stop', async () => {
    const { service } = build(source({ archivedAt: new Date() }));
    expect(await receive(service)).toEqual({ kind: 'archived' });
  });
});

describe('the same response delivered twice', () => {
  it('is acknowledged as a duplicate and never stored again', async () => {
    const raw = body();
    const { service, prisma } = build(source(), {
      id: 'evt-1',
      payloadHash: sha256Hex(raw),
      leadId: 'lead-1',
      eventType: GOOGLE_FORMS_EVENT_TYPE,
    });

    const result = await receive(service, { raw });
    expect(result).toMatchObject({ kind: 'duplicate', eventId: 'evt-1' });
    // Attempted once, refused by the unique key, and no second lead.
    expect(prisma.ingestEvent.createMany.mock.calls[0][0].skipDuplicates).toBe(true);
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });

  it('flags the lead, and does not rewrite it, when the response was edited', async () => {
    const edited = body({ questions: [{ key: 'q_email', title: 'Email', type: 'TEXT', values: ['new@example.test'] }] });
    const { service, prisma } = build(source(), {
      id: 'evt-1',
      payloadHash: sha256Hex(body()),
      leadId: 'lead-1',
      eventType: GOOGLE_FORMS_EVENT_TYPE,
    });

    expect((await receive(service, { raw: edited })).kind).toBe('duplicate');
    const update = prisma.lead.update.mock.calls[0][0];
    expect(update.data.needsReview).toBe(true);
    // Nobody is called or texted about a lead whose answers just changed.
    expect(update.data.automationPaused).toBe(true);
    expect(update.data.reviewReasons.set).toContain(RESPONSE_EDITED_REASON);
  });

  it('does not call a poll-recovered response an edit', async () => {
    // The poller rebuilds the payload from the Forms API, so its bytes never
    // match the script's. Comparing across the two would flag everything.
    const { service, prisma } = build(source(), {
      id: 'evt-1',
      payloadHash: 'a-different-hash',
      leadId: 'lead-1',
      eventType: 'google_forms.recovered',
    });
    await receive(service);
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });

  it('says it only once, however often the respondent edits', async () => {
    const edited = body({ questions: [{ key: 'q_email', title: 'Email', type: 'TEXT', values: ['new@example.test'] }] });
    const { service, prisma } = build(source(), {
      id: 'evt-1',
      payloadHash: sha256Hex(body()),
      leadId: 'lead-1',
      eventType: GOOGLE_FORMS_EVENT_TYPE,
    });
    prisma.lead.findUnique.mockResolvedValue({ id: 'lead-1', reviewReasons: [RESPONSE_EDITED_REASON] });
    await receive(service, { raw: edited });
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });
});

describe('a form that is not finished being set up', () => {
  let held: Record<string, unknown>;

  beforeEach(async () => {
    const { service, prisma } = build(source({ isActive: false, ingestStatus: 'NEEDS_MAPPING', mappingStatus: 'UNCONFIGURED' }));
    const result = await receive(service);
    expect(result.kind).toBe('held');
    held = prisma.ingestEvent.createMany.mock.calls[0][0].data[0];
  });

  it('keeps the response instead of dropping it', () => {
    expect(held.queueState).toBe('PENDING');
    expect(held.outcomeReason).toBe('awaiting_mapping');
  });

  it('holds it out of the worker until the owner switches the form on', () => {
    // Far-future availability is how the pipeline parks a delivery; activation
    // brings it back, flagged, rather than a resume releasing it silently.
    expect((held.availableAt as Date).getUTCFullYear()).toBe(9999);
  });
});
