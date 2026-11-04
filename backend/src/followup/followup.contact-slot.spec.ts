import { describe, expect, it, vi } from 'vitest';
import { FollowupService } from './followup.service';

// Org on Toronto, Sunday off, a Vancouver lead (+1 604) with no stored zone.
const leadLocal = (d: Date): string => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Vancouver', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
const QUIET = { start: '21:00', end: '08:00' };
const GUARDRAILS = { respectQuietHours: true, quietHours: QUIET, skipDays: [0], limits: { smsPerDay: 2, callsPerDay: 2, minGapMinutes: 0, chatQuietMinutes: 0 } };

function setup(sentToday: number) {
  const prisma = {
    organizationSetting: { findUnique: vi.fn(async () => ({ timezone: 'America/Toronto' })) },
    lead: { findFirst: vi.fn(async () => ({ timezone: null, normalizedPhone: '+16045551234' })) },
    leadEvent: { count: vi.fn(async () => sentToday), findFirst: vi.fn(async () => null) },
  };
  const strategies = { getStrategy: vi.fn(async () => ({ guardrails: GUARDRAILS })) };
  const service = new FollowupService(prisma as any, strategies as any, {} as any);
  return { service, prisma };
}

describe('FollowupService.contactSlot on the lead clock', () => {
  // Saturday 2026-11-07 22:30 in Vancouver.
  const now = new Date('2026-11-08T06:30:00.000Z');

  it("counts the day's texts from the lead's midnight, not the organization's", async () => {
    const s = setup(0);
    await s.service.contactSlot('org-1', 'lead-1', 'sms', now);
    const [[counted]] = s.prisma.leadEvent.count.mock.calls as unknown as [[{ where: { createdAt: { gte: Date } } }]];
    // Saturday 00:00 PT, not Sunday 00:00 ET (which is still Saturday evening for the lead).
    expect(leadLocal(counted.where.createdAt.gte)).toBe('Sat 00:00');
  });

  it("rolls a used-up limit over to the lead's next open day, skipping their Sunday", async () => {
    const s = setup(2);
    const slot = await s.service.contactSlot('org-1', 'lead-1', 'sms', now);
    expect(slot.reason).toContain('Daily limit');
    // Monday 08:00 PT; the lead-zone gate in the runner may push it later for legal hours.
    expect(leadLocal(slot.at)).toBe('Mon 08:00');
  });
});
