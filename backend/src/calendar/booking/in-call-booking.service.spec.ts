import { describe, expect, it, vi } from 'vitest';
import { InCallBookingService } from './in-call-booking.service';

const LEAD = '01a17bc5-c10c-77d1-a25e-09e977f27406';
const SANJAY = { id: 'user-sanjay', email: 'sanjay@example.com', firstName: 'Sanjay', lastName: 'K' };
const START = '2026-10-29T04:30:00.000Z';

function setup(opts: { hostEmail?: string; teammates?: (typeof SANJAY)[]; assignFails?: boolean } = {}) {
  const prisma = {
    organizationSetting: { findUnique: vi.fn(async () => ({ timezone: 'Asia/Kolkata' })) },
    lead: {
      findFirst: vi.fn(async () => ({ firstName: 'Kabir', lastName: 'Test', email: 'kabir@example.com' })),
      update: vi.fn(async () => ({})),
    },
    user: { findMany: vi.fn(async () => opts.teammates ?? [SANJAY]) },
    calendarMeeting: { upsert: vi.fn(async () => ({})) },
  };
  const access = { useActive: vi.fn(async (_org: string, run: any) => run({ id: 'conn-1', provider: 'calendly' }, 'token')) };
  const calendly = {
    eventType: vi.fn(async () => ({ locations: [] })),
    createInvitee: vi.fn(async () => ({ event: 'https://api.calendly.com/scheduled_events/e1', cancel_url: 'c', reschedule_url: 'r' })),
    scheduledEvent: vi.fn(async () => ({
      uri: 'https://api.calendly.com/scheduled_events/e1',
      name: 'Buyer Consultation',
      start_time: START,
      end_time: '2026-10-29T05:00:00.000Z',
      location: null,
      event_memberships: [{ user: 'u1', user_email: opts.hostEmail ?? SANJAY.email, user_name: 'Host' }],
    })),
  };
  const assignments = {
    assign: vi.fn(async () => {
      if (opts.assignFails) throw new Error('Sanjay K is at their lead limit');
      return {};
    }),
  };
  const engine = { appointmentBooked: vi.fn(async () => undefined) };
  const audit = { quietly: vi.fn() };
  const service = new InCallBookingService(prisma as any, access as any, calendly as any, assignments as any, engine as any, audit as any);
  const ctx = (callId: string | null) => ({
    orgId: 'org-1',
    leadId: LEAD,
    callId,
    config: { eventTypeUri: 'https://api.calendly.com/event_types/et', eventTypeName: 'Buyer Consultation' } as any,
  });
  return { service, prisma, assignments, engine, audit, ctx };
}

describe('InCallBookingService.book', () => {
  it('in a text chat: ends outreach, records the meeting as booked by text, and gives the lead to the host', async () => {
    const s = setup();
    const result = await s.service.book(s.ctx(null), { start_time: START });

    expect(result).toMatchObject({ ok: true, booked: true, agentName: 'Sanjay K' });
    expect(s.engine.appointmentBooked).toHaveBeenCalledWith('org-1', LEAD, 'sms_chat');
    expect(s.prisma.calendarMeeting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ leadId: LEAD, hostUserId: SANJAY.id, bookedVia: 'ai_text' }) }),
    );
    expect(s.assignments.assign).toHaveBeenCalledWith(
      'org-1',
      LEAD,
      SANJAY.id,
      expect.objectContaining({ actorType: 'ai', assignmentType: 'ai', reason: expect.stringContaining('AI text chat') }),
    );
  });

  it('on a call: the same, recorded as booked by call', async () => {
    const s = setup();
    await s.service.book(s.ctx('call-1'), { start_time: START });

    expect(s.engine.appointmentBooked).toHaveBeenCalledWith('org-1', LEAD, 'call');
    expect(s.prisma.calendarMeeting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ bookedVia: 'ai_call' }) }),
    );
    expect(s.assignments.assign).toHaveBeenCalledWith('org-1', LEAD, SANJAY.id, expect.objectContaining({ reason: expect.stringContaining('AI call') }));
  });

  it('leaves the lead unassigned when Calendly picked a host who is not a teammate, and says so in the audit log', async () => {
    const s = setup({ hostEmail: 'someone@elsewhere.com', teammates: [] });
    const result = await s.service.book(s.ctx(null), { start_time: START });

    expect(result).toMatchObject({ ok: true, booked: true });
    expect(s.engine.appointmentBooked).toHaveBeenCalled();
    expect(s.assignments.assign).not.toHaveBeenCalled();
    expect(s.audit.quietly).toHaveBeenCalledWith(expect.objectContaining({ action: 'appointment.host_unlinked' }));
  });

  it('keeps the booking when the host cannot take the lead', async () => {
    const s = setup({ assignFails: true });
    const result = await s.service.book(s.ctx(null), { start_time: START });

    expect(result).toMatchObject({ ok: true, booked: true });
    expect(s.engine.appointmentBooked).toHaveBeenCalled();
    expect(s.audit.quietly).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'lead.assignment_skipped',
        payload: expect.objectContaining({ reason: expect.stringContaining('during the AI text chat') }),
      }),
    );
  });
});
