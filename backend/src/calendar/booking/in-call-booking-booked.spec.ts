import { describe, expect, it, vi } from 'vitest';
import { InCallBookingService } from './in-call-booking.service';

/** Once Calendly has created the invitee the lead is booked, whatever happens to reading the meeting back. */

const ORG = 'org-1';
const LEAD = 'lead-1';
const ctx = { orgId: ORG, leadId: LEAD, callId: 'call-1', config: { eventTypeUri: 'https://api.calendly.com/event_types/et-1' } } as any;
const START = new Date(Date.now() + 2 * 86_400_000).toISOString();

function setup(opts: { readBack: 'fails' | 'works'; recordFails?: boolean }) {
  const prisma = {
    lead: { findFirst: vi.fn().mockResolvedValue({ firstName: 'Asha', lastName: 'Rao', email: 'asha@example.test' }), update: vi.fn() },
    organizationSetting: { findUnique: vi.fn().mockResolvedValue({ timezone: 'UTC' }) },
    user: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const access = { useActive: vi.fn(async (_org: string, run: (c: unknown, t: string) => unknown) => run({ id: 'conn-1', provider: 'calendly' }, 'token')) };
  const calendly = {
    eventType: vi.fn().mockResolvedValue(null),
    createInvitee: vi.fn().mockResolvedValue({ event: 'https://api.calendly.com/scheduled_events/ev-1', cancel_url: 'c', reschedule_url: 'r' }),
    scheduledEvent: opts.readBack === 'fails' ? vi.fn().mockRejectedValue(new Error('503')) : vi.fn().mockResolvedValue({ uri: 'ev-1', event_memberships: [] }),
  };
  const engine = { appointmentBooked: vi.fn().mockResolvedValue(undefined) };
  const audit = { quietly: vi.fn() };
  const svc = new InCallBookingService(prisma as any, access as any, calendly as any, {} as any, engine as any, audit as any);
  if (opts.recordFails) vi.spyOn(svc as any, 'recordMeeting').mockRejectedValue(new Error('db down'));
  else vi.spyOn(svc as any, 'recordMeeting').mockResolvedValue(undefined);
  return { svc, engine };
}

describe('InCallBookingService.book', () => {
  it('the meeting cannot be read back from Calendly: the lead is still booked', async () => {
    const { svc, engine } = setup({ readBack: 'fails' });
    const result = await svc.book(ctx, { start_time: START });
    expect(result).toEqual(expect.objectContaining({ ok: true, booked: true }));
    expect(engine.appointmentBooked).toHaveBeenCalledWith(ORG, LEAD);
  });

  it('the meeting cannot be recorded on our side: the lead is still booked', async () => {
    const { svc, engine } = setup({ readBack: 'works', recordFails: true });
    await svc.book(ctx, { start_time: START });
    expect(engine.appointmentBooked).toHaveBeenCalledWith(ORG, LEAD);
  });

  it('everything works: booked once', async () => {
    const { svc, engine } = setup({ readBack: 'works' });
    await svc.book(ctx, { start_time: START });
    expect(engine.appointmentBooked).toHaveBeenCalledOnce();
  });
});
