import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '@/auth/auth.types';
import { calendarTools } from './calendar.tools';
import { fakeRefs } from './fake-refs.test';

const ORG = 'org-1';
const LEAD = 'lead-1';
const OTHER_LEAD = 'lead-2';
const NOW = new Date('2026-11-25T18:00:00Z');
const SLOT = '2026-11-27T21:00:00.000Z';
const SLOT_2 = '2026-11-27T22:00:00.000Z';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

const owner: AuthContext = { userId: 'owner-1', organizationId: ORG, sessionId: 's', roleIds: [], permissions: ['lead.read', 'lead.update'] };
const agent: AuthContext = { userId: 'agent-1', organizationId: ORG, sessionId: 's', roleIds: [], permissions: ['lead.update'] };

const config = { eventTypeUri: 'https://api.calendly.com/event_types/ET1', eventTypeName: 'Home tour call', durationMinutes: 30 };

const leadRow = {
  id: LEAD,
  firstName: 'Maria',
  lastName: 'Lopez',
  email: 'maria@example.com',
  phone: '(512) 555-0101',
  normalizedPhone: '+15125550101',
  timezone: 'America/Los_Angeles',
  dncStatus: false,
  consentStatus: 'granted',
  takenOverById: null,
  takenOverBy: null,
  updatedAt: NOW,
};

const meeting = (id: string, leadId: string, agentId: string | null, status = 'scheduled') => ({
  id,
  leadId,
  leadName: leadId === LEAD ? 'Maria Lopez' : 'Raj Mehta',
  agentId,
  agentName: agentId ? 'Priya Shah' : 'Unassigned',
  appointmentType: 'Home tour call',
  startTime: SLOT,
  endTime: SLOT_2,
  status,
  meetingUrl: 'https://zoom.example/j/1',
  canceledReason: null,
});

function setup(opts: { lead?: object | null; config?: boolean; existing?: boolean; visibleLeadIds?: string[]; options?: object } = {}) {
  const prisma = {
    lead: {
      findFirst: vi.fn(async () => (opts.lead === undefined ? leadRow : opts.lead)),
      findMany: vi.fn(async () => (opts.visibleLeadIds ?? [LEAD, OTHER_LEAD]).map((id) => ({ id }))),
      update: vi.fn(async () => ({})),
    },
    organizationSetting: { findUnique: vi.fn(async () => ({ timezone: 'America/Chicago' })) },
    calendarMeeting: {
      findFirst: vi.fn(async () => (opts.existing ? { startsAt: new Date(SLOT), hosts: [], rescheduleUrl: null, cancelUrl: null, hostUser: null } : null)),
    },
    contactSuppression: { findMany: vi.fn(async () => []) },
    message: { create: vi.fn(async () => ({ id: 'msg-1' })), update: vi.fn(async () => ({})) },
    user: { findFirst: vi.fn(async () => ({ firstName: 'Sunny', lastName: 'Patel', email: 's@x.test' })) },
  };
  const deps = {
    prisma,
    appointments: { listInRange: vi.fn(async () => [meeting('m-1', LEAD, 'agent-1'), meeting('m-2', OTHER_LEAD, 'agent-2'), meeting('m-3', LEAD, null, 'cancelled')]) },
    booking: {
      availability: vi.fn(async () => ({
        ok: true,
        timezone: 'America/Chicago',
        today: 'Wednesday, November 25',
        requestedTimeAvailable: null,
        slots: [
          { start: SLOT, spoken: 'Friday, November 27 at 3:00 PM CST' },
          { start: SLOT_2, spoken: 'Friday, November 27 at 4:00 PM CST' },
        ],
      })),
      book: vi.fn(async () => ({ ok: true, booked: true, agentName: 'Priya Shah', spoken: 'Friday, November 27 at 3:00 PM CST', say: '' })),
    },
    bookingSettings: { activeConfig: vi.fn(async () => (opts.config === false ? null : config)) },
    leadBooking: {
      options: vi.fn(async () =>
        opts.options ?? {
          agent: { id: 'agent-1', name: 'Priya Shah' },
          provider: 'calendly',
          eventTypes: [{ id: 'et', name: 'Intro call', durationMinutes: 15, bookingUrl: 'https://calendly.com/priya/intro?utm_content=lead-1', poolingType: null }],
          blocker: null,
        },
      ),
    },
    text: {
      prisma,
      sms: { sendSms: vi.fn(async (_o: string, _t: string, text: string) => ({ id: 'tx-1', text })) },
      conversations: { appendToChat: vi.fn(async () => undefined) },
      optOuts: { optOut: vi.fn() },
      followup: { guardrailsFor: vi.fn(async () => ({ timeZone: 'America/Chicago', quiet: { start: '21:00', end: '08:00' }, skipDays: [], limits: {} })) },
      state: { quietly: vi.fn() },
      events: { publish: vi.fn() },
    },
  };
  const tools = Object.fromEntries(calendarTools(deps as never).map((t) => [t.name, t as any]));
  const refs = fakeRefs();
  return { deps, prisma, tools, refs };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('meeting_list', () => {
  it('shows meetings as refs with the office clock, never ids, and leaves out canceled ones', async () => {
    const s = setup();
    const out = await s.tools.meeting_list.run({ auth: owner, refs: s.refs }, { includeCanceled: false, limit: 20 });
    expect(out.total).toBe(2);
    expect(out.meetings[0]).toMatchObject({ ref: 'M1', lead: { ref: 'L1', name: 'Maria Lopez' }, agent: { ref: 'U1', name: 'Priya Shah' }, when: 'Friday, November 27 at 3:00 PM CST' });
    expect(JSON.stringify(out)).not.toMatch(UUID);
    expect(JSON.stringify(out)).not.toContain('m-1');
  });

  it('defaults to the next two weeks', async () => {
    const s = setup();
    await s.tools.meeting_list.run({ auth: owner, refs: s.refs }, { includeCanceled: false, limit: 20 });
    const range = (s.deps.appointments.listInRange.mock.calls[0] as any[])[1];
    expect(range.from).toEqual(NOW);
    expect(range.to.getTime() - NOW.getTime()).toBe(14 * 24 * 60 * 60 * 1000);
  });

  it("gives an agent the meetings of their own leads and the ones they host, not another agent's", async () => {
    const s = setup({ visibleLeadIds: [] });
    const out = await s.tools.meeting_list.run({ auth: agent, refs: s.refs }, { includeCanceled: false, limit: 20 });
    expect(out.meetings.map((m: any) => m.agent?.name)).toEqual(['Priya Shah']);
    expect(out.total).toBe(1);
    expect((s.prisma.lead.findMany.mock.calls[0] as any[])[0].where).toMatchObject({ assignedToId: 'agent-1' });
  });
});

describe('meeting_slots', () => {
  it("offers open times as slot refs, with the lead's clock when it differs", async () => {
    const s = setup();
    await s.refs.issue('lead', [LEAD]);
    const out = await s.tools.meeting_slots.run({ auth: owner, refs: s.refs }, { day: 'friday', lead: 'L1' });
    expect(out.slots).toEqual([
      { ref: 'T1', time: 'Friday, November 27 at 3:00 PM CST', leadTime: 'Friday, November 27 at 1:00 PM PST' },
      { ref: 'T2', time: 'Friday, November 27 at 4:00 PM CST', leadTime: 'Friday, November 27 at 2:00 PM PST' },
    ]);
    expect(out.meetingType).toBe('Home tour call (30 min)');
    expect(s.refs.idOf('T1')).toBe(SLOT);
    expect((s.deps.booking.availability.mock.calls[0] as any[])[0]).toMatchObject({ orgId: ORG, leadId: LEAD, callId: null, staff: { userId: 'owner-1' } });
  });

  it('says how to book another way when in-call booking is off', async () => {
    const s = setup({ config: false });
    await expect(s.tools.meeting_slots.run({ auth: owner, refs: s.refs }, {})).rejects.toThrow(/booking_link_send/);
  });
});

describe('meeting_book', () => {
  async function withSlot(s: ReturnType<typeof setup>) {
    await s.refs.issue('lead', [LEAD]);
    await s.refs.issue('slot', [SLOT]);
  }

  it("shows the time on both clocks, the meeting and the invite address", async () => {
    const s = setup();
    await withSlot(s);
    const card = await s.tools.meeting_book.preview({ auth: owner, refs: s.refs }, { lead: 'L1', slot: 'T1' });
    expect(card.title).toBe('Book a meeting with Maria Lopez');
    expect(card.changes).toEqual([
      { field: 'When', from: null, to: 'Friday, November 27 at 3:00 PM CST' },
      { field: "Lead's time", from: null, to: 'Friday, November 27 at 1:00 PM PST' },
      { field: 'Meeting', from: null, to: 'Home tour call (30 min)' },
      { field: 'Invite to', from: null, to: 'maria@example.com' },
    ]);
    expect(card.entity).toEqual({ type: 'lead', id: LEAD, version: NOW });
  });

  it('refuses a slot that is not from this chat, a lead with no email, and a lead already booked', async () => {
    const s = setup();
    await withSlot(s);
    await expect(s.tools.meeting_book.preview({ auth: owner, refs: s.refs }, { lead: 'L1', slot: 'T9' })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const noEmail = setup({ lead: { ...leadRow, email: null } });
    await withSlot(noEmail);
    await expect(noEmail.tools.meeting_book.preview({ auth: owner, refs: noEmail.refs }, { lead: 'L1', slot: 'T1' })).rejects.toThrow(/no email/);

    const booked = setup({ existing: true });
    await withSlot(booked);
    await expect(booked.tools.meeting_book.preview({ auth: owner, refs: booked.refs }, { lead: 'L1', slot: 'T1' })).rejects.toThrow(/already has a meeting/);
  });

  it('refuses a slot whose time has passed', async () => {
    const s = setup();
    await withSlot(s);
    vi.setSystemTime(new Date(SLOT));
    await expect(s.tools.meeting_book.preview({ auth: owner, refs: s.refs }, { lead: 'L1', slot: 'T1' })).rejects.toThrow(/has passed/);
  });

  it('books the exact start time as the confirming user', async () => {
    const s = setup();
    await withSlot(s);
    const out = await s.tools.meeting_book.run({ auth: owner, refs: s.refs }, { lead: 'L1', slot: 'T1' });
    expect(out).toEqual({ booked: true, when: 'Friday, November 27 at 3:00 PM CST', agent: 'Priya Shah' });
    expect(s.deps.booking.book).toHaveBeenCalledWith(expect.objectContaining({ leadId: LEAD, staff: { userId: 'owner-1' } }), { start_time: SLOT });
  });

  it('when the time was just taken, offers the fresh times as new slot refs', async () => {
    const s = setup();
    await withSlot(s);
    s.deps.booking.book.mockResolvedValueOnce({ ok: false, reason: 'slot_taken', say: '', slots: [{ start: SLOT_2, spoken: 'Friday, November 27 at 4:00 PM CST' }] } as never);
    await expect(s.tools.meeting_book.run({ auth: owner, refs: s.refs }, { lead: 'L1', slot: 'T1' })).rejects.toThrow(
      'That time was just taken; nothing was booked. Open now: Friday, November 27 at 4:00 PM CST (T2).',
    );
  });
});

describe('booking_link_send', () => {
  it("puts the agent's link in a standard line and shows it all on the card", async () => {
    const s = setup();
    await s.refs.issue('lead', [LEAD]);
    const card = await s.tools.booking_link_send.preview({ auth: owner, refs: s.refs }, { lead: 'L1' });
    expect(card.changes).toEqual([
      { field: 'To', from: null, to: '(512) 555-0101' },
      { field: 'Message', from: null, to: 'Hi Maria, here is a link to pick a time with Priya: https://calendly.com/priya/intro?utm_content=lead-1' },
      { field: 'Books', from: null, to: 'Intro call (15 min) with Priya Shah' },
    ]);
  });

  it('sends the same text the card showed', async () => {
    const s = setup();
    await s.refs.issue('lead', [LEAD]);
    const input = { lead: 'L1', message: 'Hi Maria, pick any time that suits you:' };
    const card = await s.tools.booking_link_send.preview({ auth: owner, refs: s.refs }, input);
    const out = await s.tools.booking_link_send.run({ auth: owner, refs: s.refs }, input);
    const shown = card.changes.find((c: any) => c.field === 'Message').to;
    expect(s.deps.text.sms.sendSms).toHaveBeenCalledWith(ORG, '(512) 555-0101', shown, { outreach: true });
    expect(out).toEqual({ sent: true, lead: 'L1' });
  });

  it('says what to fix when the lead has no agent to book with', async () => {
    const s = setup({ options: { agent: null, provider: null, eventTypes: [], blocker: 'no_agent' } });
    await s.refs.issue('lead', [LEAD]);
    await expect(s.tools.booking_link_send.preview({ auth: owner, refs: s.refs }, { lead: 'L1' })).rejects.toThrow(/Assign one first/);
  });
});
