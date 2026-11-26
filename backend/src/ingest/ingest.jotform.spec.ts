import { describe, expect, it, vi } from 'vitest';
import { IngestService } from './ingest.service';

/**
 * The Jotform ingest route, through IngestService with fake storage. Jotform
 * signs nothing, so the token and its binding to this route are the whole
 * defence; and one submission delivered twice must stay one delivery.
 */

const TOKEN = 'whk_live_ABCDEFGHJKMNPQRSTVWX';

/** The JSON IngestController.jotform builds from Jotform's multipart fields. */
const body = (submissionID = '5912345678901234567') =>
  Buffer.from(
    JSON.stringify({
      submissionID,
      formID: '231234567890',
      formTitle: 'Buyer enquiry',
      rawRequest: { q3_fullName: { first: 'Asha', last: 'Verma' }, q4_email: 'asha@example.test' },
    }),
  );

const source = (over: Record<string, unknown> = {}) => ({
  id: 'src-1',
  orgId: 'org-1',
  provider: 'JOTFORM',
  archivedAt: null,
  isActive: true,
  ingestStatus: 'ACTIVE',
  mappingStatus: 'NEEDS_REVIEW',
  requireSignature: false,
  signingSecretEnc: null,
  previousSecretEnc: null,
  previousSecretValidUntil: null,
  ...over,
});

function build(row: Record<string, unknown> | null, duplicate = false) {
  const prisma = {
    leadSource: { findUnique: vi.fn().mockResolvedValue(row), update: vi.fn().mockResolvedValue({}) },
    ingestEvent: {
      createMany: vi.fn().mockResolvedValue({ count: duplicate ? 0 : 1 }),
      findUnique: vi.fn().mockResolvedValue(duplicate ? { id: 'evt-earlier' } : null),
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new IngestService(prisma as any, { open: vi.fn() } as any, { publish: vi.fn() } as any);
  return { service, prisma };
}

const receive = (service: IngestService, route: 'JOTFORM' | 'TALLY' | 'WEBHOOK' = 'JOTFORM', raw = body()) =>
  service.receive({ route, token: TOKEN, rawBody: raw, headers: {}, signature: undefined });

describe('a Jotform delivery', () => {
  it('is accepted unsigned, keyed by its submission id', async () => {
    const { service, prisma } = build(source());
    await expect(receive(service)).resolves.toMatchObject({ kind: 'accepted' });
    const row = prisma.ingestEvent.createMany.mock.calls[0][0].data[0];
    expect(row).toMatchObject({ provider: 'JOTFORM', dedupeKey: 'JOTFORM:5912345678901234567', providerSubmissionId: '5912345678901234567' });
  });

  it('is a duplicate when the same submission arrives again', async () => {
    const { service } = build(source(), true);
    await expect(receive(service)).resolves.toMatchObject({ kind: 'duplicate' });
  });

  it('cannot use a Jotform token on another route', async () => {
    const { service } = build(source());
    await expect(receive(service, 'TALLY')).resolves.toEqual({ kind: 'unknown_token' });
    await expect(receive(service, 'WEBHOOK')).resolves.toEqual({ kind: 'unknown_token' });
  });

  it('does not accept another provider’s token on the Jotform route', async () => {
    const { service } = build(source({ provider: 'TALLY' }));
    await expect(receive(service)).resolves.toEqual({ kind: 'unknown_token' });
  });
});
