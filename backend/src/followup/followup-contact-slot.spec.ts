import { describe, expect, it, vi } from 'vitest';
import { FollowupService } from './followup.service';

const NOW = new Date('2026-11-03T15:00:00Z');

function setup(lead: { normalizedPhone: string | null }, sentToday: number) {
  const prisma = {
    organizationSetting: { findUnique: vi.fn(async () => ({ timezone: 'UTC' })) },
    lead: { findUnique: vi.fn(async () => lead) },
    leadEvent: {
      count: vi.fn(async () => sentToday),
      findFirst: vi.fn(async () => ({ createdAt: new Date(NOW.getTime() - 60 * 60_000) })),
    },
    call: { count: vi.fn(async () => sentToday), findFirst: vi.fn(async () => null) },
  };
  const strategies = { getStrategy: vi.fn(async () => ({ guardrails: { respectQuietHours: false } })) };
  return { service: new FollowupService(prisma as any, strategies as any, {} as any), prisma };
}

describe('FollowupService.contactSlot', () => {
  it("counts the day's texts per phone, across every lead with it", async () => {
    const s = setup({ normalizedPhone: '+12899174129' }, 3);
    const slot = await s.service.contactSlot('org-1', 'lead-2', 'sms', NOW);
    expect(s.prisma.leadEvent.count).toHaveBeenCalledWith({
      where: { lead: { orgId: 'org-1', normalizedPhone: '+12899174129' }, type: 'step_sent', channel: 'sms', createdAt: { gte: expect.any(Date) } },
    });
    // Three texts already went to the number today (the default limit), on whichever lead.
    expect(slot.at.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('counts calls per phone too', async () => {
    const s = setup({ normalizedPhone: '+12899174129' }, 0);
    await s.service.contactSlot('org-1', 'lead-2', 'voice', NOW);
    expect(s.prisma.call.count).toHaveBeenCalledWith({ where: expect.objectContaining({ lead: { orgId: 'org-1', normalizedPhone: '+12899174129' } }) });
  });

  it('falls back to the lead itself when it has no phone', async () => {
    const s = setup({ normalizedPhone: null }, 0);
    await s.service.contactSlot('org-1', 'lead-2', 'sms', NOW);
    expect(s.prisma.leadEvent.count).toHaveBeenCalledWith({ where: expect.objectContaining({ leadId: 'lead-2' }) });
  });
});
