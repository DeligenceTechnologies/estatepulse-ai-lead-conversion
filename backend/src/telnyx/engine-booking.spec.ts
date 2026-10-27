import { describe, expect, it, vi } from 'vitest';
import { StepGuard } from '@/outreach/step-guard.service';
import { EngineService } from './engine.service';

/** A booking wins from any status but invalid; a call that ends the journey closes everything. */

const ORG = 'org-1';
const LEAD = 'lead-1';

function setup(lead: Record<string, unknown> | null) {
  const prisma = {
    lead: { findFirst: vi.fn().mockResolvedValue(lead), update: vi.fn().mockResolvedValue({}), updateMany: vi.fn() },
    $transaction: vi.fn(async (run: (t: unknown) => Promise<unknown>) => run({ lead: { update: prisma.lead.update } })),
  };
  const activity = { exitStrategy: vi.fn() };
  const followup = { stopForLead: vi.fn(), sequenceForTrigger: vi.fn(), enroll: vi.fn() };
  const guard = { clearReview: vi.fn().mockResolvedValue(undefined) };
  const engine = new EngineService(prisma as any, {} as any, {} as any, {} as any, activity as any, followup as any, guard as any, { get: () => true } as any);
  return { engine, prisma, followup, guard };
}

describe('EngineService.appointmentBooked', () => {
  it.each([
    ['not interested (a sequence ran out)', { status: 'not_interested', dncStatus: false }],
    ['closed', { status: 'closed', dncStatus: false }],
    ['opted out of texts', { status: 'not_interested', dncStatus: true }],
    ['in follow-up', { status: 'follow_up', dncStatus: false }],
  ])('a lead %s who books is booked, and its sequences stop', async (_label, lead) => {
    const { engine, prisma, followup } = setup({ id: LEAD, ...lead });
    await engine.appointmentBooked(ORG, LEAD);
    expect(prisma.lead.update).toHaveBeenCalledWith({ where: { id: LEAD }, data: { status: 'appointment_booked' } });
    expect(followup.stopForLead).toHaveBeenCalledWith(ORG, LEAD, 'appointment_booked');
  });

  it('an invalid lead (a wrong number) is never booked', async () => {
    const { engine, prisma } = setup({ id: LEAD, status: 'invalid', dncStatus: false });
    await engine.appointmentBooked(ORG, LEAD);
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });

  it('"Mark as booked" refuses only an invalid lead', async () => {
    await expect(setup({ id: LEAD, status: 'invalid', dncStatus: false }).engine.markBooked(ORG, LEAD)).rejects.toThrow(/invalid/);
    const closed = setup({ id: LEAD, status: 'not_interested', dncStatus: false });
    await closed.engine.markBooked(ORG, LEAD);
    expect(closed.prisma.lead.update).toHaveBeenCalledWith({ where: { id: LEAD }, data: { status: 'appointment_booked' } });
  });
});

describe('StepGuard.markBooked (a meeting found by a sequence step)', () => {
  it('books from any status but invalid, and leaves a booked lead alone', async () => {
    const prisma = { lead: { updateMany: vi.fn() } };
    await new StepGuard(prisma as any, {} as any).markBooked(ORG, LEAD);
    expect(prisma.lead.updateMany).toHaveBeenCalledWith({
      where: { id: LEAD, orgId: ORG, status: { notIn: ['invalid', 'appointment_booked'] } },
      data: { status: 'appointment_booked' },
    });
  });
});

describe('EngineService.endJourney', () => {
  it('closes the lead with the reason, stops the strategy and every sequence, and clears the score review', async () => {
    const { engine, prisma, followup, guard } = setup({ id: LEAD });
    await engine.endJourney(ORG, LEAD, 'not_interested' as any, 'Said on the call they are not interested');
    expect(prisma.lead.update).toHaveBeenCalledWith({
      where: { id: LEAD },
      data: expect.objectContaining({ status: 'not_interested', lostReason: 'Said on the call they are not interested' }),
    });
    expect(followup.stopForLead).toHaveBeenCalledWith(ORG, LEAD, 'lead_not_interested');
    expect(guard.clearReview).toHaveBeenCalled();
  });
});
