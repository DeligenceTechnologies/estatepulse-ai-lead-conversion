import { describe, expect, test, vi } from 'vitest';
import { LeadReviewService } from './lead-review.service';

const LEAD = {
  needsReview: true,
  reviewReasons: ['Budget: range was reversed (9 – 5); swapped'],
  automationPaused: true,
  dncStatus: false,
  normalizedPhone: '+14155550100' as string | null,
};

/** The service with just enough Prisma to see what it writes; `releases` is what the guarded unpause answers. */
const setup = (lead: Partial<typeof LEAD> | null = {}, releases = true) => {
  const update = vi.fn().mockResolvedValue({});
  const queryRaw = vi.fn().mockResolvedValue(releases ? [{ id: 'lead-1' }] : []);
  const findFirst = vi.fn().mockResolvedValue(lead && { ...LEAD, ...lead });
  const tx = { lead: { findFirst, update }, $queryRaw: queryRaw };
  const prisma = { $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)) };
  const audit = { record: vi.fn() };
  const state = { quietly: vi.fn() };
  const service = new LeadReviewService(prisma as never, audit as never, state as never);
  return { service, findFirst, update, audit, approve: () => service.approve('org-1', 'user-1', 'lead-1') };
};

describe('approving a lead held for review', () => {
  test('clears its reasons and lets outreach start', async () => {
    const s = setup();
    await expect(s.approve()).resolves.toEqual({ released: true, held: null });
    expect(s.update).toHaveBeenCalledWith({ where: { id: 'lead-1' }, data: { needsReview: false, reviewReasons: [] } });
    expect(s.audit.record.mock.calls[0][0]).toMatchObject({ action: 'lead.review_approved', entityId: 'lead-1' });
  });

  test('looks the lead up in the caller’s organization only', async () => {
    const s = setup(null);
    await expect(s.approve()).rejects.toThrow(/no longer exists/);
    expect(s.findFirst.mock.calls[0][0].where).toEqual({ id: 'lead-1', orgId: 'org-1' });
    expect(s.update).not.toHaveBeenCalled();
  });

  test('a lead not waiting for review is refused', async () => {
    const s = setup({ needsReview: false });
    await expect(s.approve()).rejects.toThrow(/not waiting for review/);
  });

  test('a do-not-contact lead is approved but held', async () => {
    await expect(setup({ dncStatus: true }, false).approve()).resolves.toEqual({ released: false, held: 'DO_NOT_CONTACT' });
  });

  test('a lead with no dialable phone is approved but held', async () => {
    await expect(setup({ normalizedPhone: null }, false).approve()).resolves.toEqual({ released: false, held: 'NO_DIALABLE_PHONE' });
  });

  test('a lead flagged mid-outreach was never held, so nothing is reported held', async () => {
    await expect(setup({ automationPaused: false }, false).approve()).resolves.toEqual({ released: false, held: null });
  });
});
