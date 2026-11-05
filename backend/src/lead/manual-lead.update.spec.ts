import { describe, expect, test, vi } from 'vitest';
import { PHONE_UNPARSED_REASON } from '@/google-sheets/sheet-rows';
import { ManualLeadService } from './manual-lead.service';
import type { UpdateLeadDto } from './dto/update-lead.dto';

const LEAD = {
  id: 'lead-1',
  phone: '9024848980',
  email: null as string | null,
  normalizedPhone: null as string | null,
  normalizedEmail: null as string | null,
  dncStatus: false,
  reviewReasons: [PHONE_UNPARSED_REASON],
};

/** The service with just enough Prisma to see what it would write. */
const setup = (lead: Partial<typeof LEAD> = {}, optedOut: { phones?: string[]; dncEmailLeads?: number } = {}) => {
  const update = vi.fn().mockResolvedValue({});
  const prisma = {
    lead: {
      findFirst: vi.fn().mockResolvedValue({ ...LEAD, ...lead }),
      update,
      count: vi.fn().mockResolvedValue(optedOut.dncEmailLeads ?? 0),
    },
    contactSuppression: {
      findMany: vi.fn(async ({ where }: { where: { normalizedPhone: { in: string[] } } }) =>
        where.normalizedPhone.in.filter((p) => optedOut.phones?.includes(p)).map((normalizedPhone) => ({ normalizedPhone })),
      ),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ lead: { update } })),
  };
  const audit = { record: vi.fn() };
  const service = new ManualLeadService(prisma as never, audit as never, { publish: vi.fn() } as never);
  return { service, update, audit };
};

const run = (s: ReturnType<typeof setup>, input: UpdateLeadDto) => s.service.update('org-1', 'user-1', 'lead-1', input);

describe('correcting a lead by hand', () => {
  test('adding the country code makes the lead dialable', async () => {
    const s = setup();
    await run(s, { phone: '+919024848980' });
    expect(s.update.mock.calls[0][0].data).toMatchObject({
      phone: '+919024848980',
      normalizedPhone: '+919024848980',
      phoneValid: true,
    });
  });

  test('and clears the flag that held it, so outreach can reach them', async () => {
    const s = setup();
    await run(s, { phone: '+919024848980' });
    expect(s.update.mock.calls[0][0].data).toMatchObject({ reviewReasons: [], needsReview: false });
  });

  test('but leaves every other reason the lead was held for', async () => {
    const other = 'This phone or email is on the do-not-contact list from an earlier lead';
    const s = setup({ reviewReasons: [PHONE_UNPARSED_REASON, other] });
    await run(s, { phone: '+919024848980' });
    expect(s.update.mock.calls[0][0].data).toMatchObject({ reviewReasons: [other], needsReview: true });
  });

  test('a number still missing its country code is refused, with the code to add', async () => {
    const s = setup();
    await expect(run(s, { phone: '9024848980' })).rejects.toThrow(/country code, e\.g\. \+91/);
    expect(s.update).not.toHaveBeenCalled();
  });

  test('a lead cannot be left with no way to reach it', async () => {
    const s = setup({ normalizedPhone: '+919024848980', reviewReasons: [] });
    await expect(run(s, { phone: '' })).rejects.toThrow(/phone number or an email/);
  });

  test('clearing the phone is allowed while an email remains', async () => {
    const s = setup({ normalizedEmail: 'manish@example.test', reviewReasons: [] });
    await run(s, { phone: '' });
    expect(s.update.mock.calls[0][0].data).toMatchObject({ phone: null, normalizedPhone: null, phoneValid: false });
  });

  test('keys left out are left alone', async () => {
    const s = setup({ normalizedPhone: '+919024848980', reviewReasons: [] });
    await run(s, { location: 'Indore' });
    const { data } = s.update.mock.calls[0][0];
    expect(data).toMatchObject({ location: 'Indore' });
    expect(data).not.toHaveProperty('phone');
    expect(data).not.toHaveProperty('email');
  });

  test('the change is written to the audit log', async () => {
    const s = setup();
    await run(s, { phone: '+919024848980', location: 'Indore' });
    expect(s.audit.record.mock.calls[0][0]).toMatchObject({
      action: 'lead.updated',
      entityId: 'lead-1',
      payload: { fields: ['phone', 'location'] },
    });
  });
});

describe('editing a lead onto a number or email that opted out', () => {
  const DNC = 'This phone or email is on the do-not-contact list from an earlier lead';

  test('a phone that opted out turns the lead do-not-contact, paused and flagged', async () => {
    const s = setup({}, { phones: ['+919024848980'] });
    await run(s, { phone: '+919024848980' });
    expect(s.update.mock.calls[0][0].data).toMatchObject({
      dncStatus: true,
      automationPaused: true,
      needsReview: true,
      reviewReasons: [DNC],
    });
    expect(s.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { fields: ['phone'], becameDoNotContact: true } }),
      expect.anything(),
    );
  });

  test('so does an email an opted-out lead has', async () => {
    const s = setup({ normalizedPhone: '+919024848980', reviewReasons: [] }, { dncEmailLeads: 1 });
    await run(s, { email: 'Ana@Example.com' });
    expect(s.update.mock.calls[0][0].data).toMatchObject({ dncStatus: true, reviewReasons: [DNC] });
  });

  test('a clean number does not, and editing only the name looks nothing up', async () => {
    const clean = setup();
    await run(clean, { phone: '+919024848980' });
    expect(clean.update.mock.calls[0][0].data).not.toHaveProperty('dncStatus');

    const named = setup({ normalizedPhone: '+919024848980', reviewReasons: [] }, { phones: ['+919024848980'] });
    await run(named, { firstName: 'Ana' });
    expect(named.update.mock.calls[0][0].data).not.toHaveProperty('dncStatus');
  });
});
