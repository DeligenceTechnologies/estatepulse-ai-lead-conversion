import { describe, expect, it, vi } from 'vitest';
import { AWAITING_CONSENT_REVIEW, CONSENT_REVIEW_REASON } from './consent';
import { ConsentReviewService } from './consent-review.service';
import { OUTSIDE_IMPORT_REVIEW } from './lead-scope';
import { ManualLeadService } from './manual-lead.service';

const ORG = 'org-1';

/** A manual lead without consent is held in Import Review; the owner records the consent or rejects it. */
describe('manual lead consent review', () => {
  const create = async (input: { consent: boolean; startOutreach: boolean }, dncMatches = 0) => {
    const created: any[] = [];
    const tx = {
      lead: { create: vi.fn(async (args: any) => (created.push(args.data), { id: 'lead-1' })) },
    };
    const prisma = {
      organizationSetting: { findUnique: vi.fn(async () => ({ defaultRegion: 'US' })) },
      lead: { count: vi.fn(async () => dncMatches) },
      $transaction: vi.fn(async (run: (t: unknown) => unknown) => run(tx)),
    };
    const audit = { record: vi.fn(async () => undefined) };
    const events = { publish: vi.fn(), emit: vi.fn() };
    await new ManualLeadService(prisma as any, audit as any, events as any).create(ORG, 'user-1', {
      firstName: 'Ana',
      phone: '+15125550188',
      ...input,
    } as any);
    return created[0];
  };

  it('without the consent box ticked: paused and held for review, whatever startOutreach says', async () => {
    const lead = await create({ consent: false, startOutreach: true });
    expect(lead).toMatchObject({ consentStatus: 'pending', automationPaused: true, needsReview: true, reviewReasons: [CONSENT_REVIEW_REASON] });
  });

  it('with the box ticked: an ordinary lead, not held', async () => {
    const lead = await create({ consent: true, startOutreach: true });
    expect(lead).toMatchObject({ consentStatus: 'granted', automationPaused: false, needsReview: false, reviewReasons: [] });
  });

  it('a do-not-contact lead is not sent to consent review: it is never contacted anyway', async () => {
    const lead = await create({ consent: false, startOutreach: true }, 1);
    expect(lead.reviewReasons).not.toContain(CONSENT_REVIEW_REASON);
    expect(lead.dncStatus).toBe(true);
  });

  it('held leads are left out of every lead list', () => {
    expect(OUTSIDE_IMPORT_REVIEW).toMatchObject({ NOT: AWAITING_CONSENT_REVIEW });
  });

  const review = (ids: string[]) => {
    const tx = { $queryRaw: vi.fn(async () => ids.map((id) => ({ id }))) };
    const prisma = { $transaction: vi.fn(async (run: (t: unknown) => unknown) => run(tx)) };
    const audit = { recordMany: vi.fn(async () => undefined) };
    const state = { quietly: vi.fn() };
    return { service: new ConsentReviewService(prisma as any, audit as any, state as any), tx, audit, state };
  };
  /** The tagged-template SQL sent, with nested Prisma.sql fragments inlined. */
  const sqlOf = (tx: { $queryRaw: { mock: { calls: any[][] } } }) => {
    const [strings, ...values] = tx.$queryRaw.mock.calls[0] as [string[], ...unknown[]];
    return strings.map((part, i) => part + ((values[i] as { sql?: string } | undefined)?.sql ?? '?')).join('');
  };

  it('recording consent grants it, takes the lead out of review, unpauses it and is audited', async () => {
    const { service, tx, audit, state } = review(['lead-1']);
    expect(await service.approve(ORG, 'user-1', ['lead-1'])).toEqual({ approved: 1 });
    const sql = sqlOf(tx);
    expect(sql).toContain('consent_status');
    expect(sql).toContain("consent_source = 'owner_attested'");
    expect(sql).toContain('automation_paused = dnc_status');
    expect(sql).toContain('array_remove(review_reasons');
    expect(audit.recordMany).toHaveBeenCalledWith([expect.objectContaining({ action: 'lead.consent_recorded', entityId: 'lead-1', actorId: 'user-1' })], tx);
    expect(state.quietly).toHaveBeenCalledWith(expect.objectContaining({ type: 'consent_recorded', leadId: 'lead-1' }));
  });

  it('rejecting closes the lead and keeps it paused', async () => {
    const { service, tx, audit } = review(['lead-2']);
    expect(await service.reject(ORG, 'user-1', ['lead-2'])).toEqual({ rejected: 1 });
    const sql = sqlOf(tx);
    expect(sql).toContain("status = 'closed'");
    expect(sql).toContain('automation_paused = true');
    expect(audit.recordMany).toHaveBeenCalledWith([expect.objectContaining({ action: 'lead.consent_rejected', entityId: 'lead-2' })], tx);
  });
});
