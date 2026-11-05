import { describe, expect, it, vi } from 'vitest';
import { MeetingToolService } from './meeting-tool.service';

const CALLER = { orgId: 'org-1', leadId: 'lead-1', callId: null };

function make(meeting: Record<string, unknown> | null) {
  const prisma = {
    calendarMeeting: { findFirst: vi.fn(async () => meeting) },
    organizationSetting: { findUnique: vi.fn(async () => ({ timezone: 'America/Toronto' })) },
  };
  return { service: new MeetingToolService(prisma as any), prisma };
}

const MEETING = {
  startsAt: new Date('2026-11-07T18:00:00.000Z'),
  hosts: [{ name: 'Priya S', email: 'priya@example.com' }],
  rescheduleUrl: 'https://calendly.com/reschedulings/abc',
  cancelUrl: 'https://calendly.com/cancellations/abc',
  hostUser: null,
};

describe('get_meeting', () => {
  it("gives the lead's next meeting in the organization's time, with the links to move or cancel it", async () => {
    const { service, prisma } = make(MEETING);
    const result = await service.lookup(CALLER);

    expect(result).toMatchObject({
      ok: true,
      meeting: 'Saturday, November 7 at 1:00 PM EST',
      with: 'Priya S',
      reschedule_link: MEETING.rescheduleUrl,
      cancel_link: MEETING.cancelUrl,
    });
    expect(result.say).toContain('Never book another one');
    expect(result.say).toContain('In a text chat, send them that link; on a call, tell them both links are in their confirmation email.');
    expect(prisma.calendarMeeting.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ orgId: 'org-1', leadId: 'lead-1' }), orderBy: { startsAt: 'asc' } }));
  });

  it('names the teammate who hosts it over the name the calendar has', async () => {
    const { service } = make({ ...MEETING, hostUser: { firstName: 'Priya', lastName: 'Sharma' } });
    expect(await service.lookup(CALLER)).toMatchObject({ with: 'Priya Sharma' });
  });

  it('leaves a change to the team when the calendar gave no links', async () => {
    const { service } = make({ ...MEETING, rescheduleUrl: null, cancelUrl: null });
    const result = await service.lookup(CALLER);
    expect(result).toMatchObject({ reschedule_link: '', cancel_link: '' });
    expect(result.say).toContain('someone from the team will get back to them');
  });

  it('says so when the lead has no meeting', async () => {
    const { service } = make(null);
    expect(await service.lookup(CALLER)).toEqual({ ok: true, meeting: null, say: 'They have no upcoming meeting with us. If they want one, offer to set one up.' });
  });
});
