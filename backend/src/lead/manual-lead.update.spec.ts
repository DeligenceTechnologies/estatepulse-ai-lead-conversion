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
  /** Rows still waiting in import review. Zero means the lead is in the pipeline and off limits. */
  _count: { sheetImportRows: 1 },
};

/** The service with just enough Prisma to see what it would write. */
const setup = (lead: Partial<typeof LEAD> = {}) => {
  const update = vi.fn().mockResolvedValue({});
  const prisma = {
    lead: { findFirst: vi.fn().mockResolvedValue({ ...LEAD, ...lead }), update },
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

  test('a lead already in the pipeline cannot be edited here', async () => {
    const s = setup({ _count: { sheetImportRows: 0 } });
    await expect(run(s, { phone: '+919024848980' })).rejects.toThrow(/import review/);
    expect(s.update).not.toHaveBeenCalled();
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
