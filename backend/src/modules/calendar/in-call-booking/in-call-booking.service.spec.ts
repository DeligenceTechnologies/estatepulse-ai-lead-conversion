import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../../common/errors';
import { InCallBookingService, inviteeLocation } from './in-call-booking.service';
import type { ToolContext } from './tool-auth.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ORG = 'org-1';
const LEAD = 'lead-1';
const EVENT_TYPE = 'https://api.calendly.com/event_types/rr';
const HOST = 'https://api.calendly.com/users/u-sunny';
const CHI = 'America/Chicago';
// Tuesday 6 Oct 2026, 09:00 in Chicago.
const NOW = new Date('2026-10-06T14:00:00Z');

const ctx: ToolContext = {
  organizationId: ORG,
  leadId: LEAD,
  callId: 'call-1',
  config: {
    eventTypeUri: EVENT_TYPE,
    eventTypeName: 'Buyer consultation',
    durationMinutes: 30,
    tokenHash: 'x',
    secretId: 's',
    secretIdentifier: 'i',
    toolIds: [],
    assistantId: 'a',
  },
};

const at = (iso: string) => ({ status: 'available', invitees_remaining: 1, start_time: iso, scheduling_url: 'u' });
const EVENT = {
  uri: 'https://api.calendly.com/scheduled_events/evt-9',
  name: 'Buyer consultation',
  status: 'active',
  start_time: '2026-10-08T20:00:00Z',
  end_time: '2026-10-08T20:30:00Z',
  updated_at: '2026-10-06T14:00:01Z',
  location: { join_url: 'https://zoom.example/j/1' },
  event_memberships: [{ user: HOST, user_name: 'Sunny Patel' }],
};

function setup(
  opts: { lead?: any; times?: any[]; createInvitee?: any; agent?: any; assignFails?: Error; eventType?: any } = {},
) {
  const prisma: any = {
    organizations: { findUnique: vi.fn().mockResolvedValue({ timezone: CHI }) },
    leads: {
      findFirst: vi.fn().mockResolvedValue(opts.lead ?? { first_name: 'Bea', last_name: 'Buyer', email: 'bea@example.com' }),
      update: vi.fn().mockResolvedValue({}),
    },
    agent_profiles: {
      findMany: vi
        .fn()
        .mockResolvedValue(
          opts.agent === undefined
            ? [{ id: 'agent-sunny', display_name: 'Sunny Patel', calendly_user_uri: HOST }]
            : opts.agent
              ? [opts.agent]
              : [],
        ),
    },
    appointments: { upsert: vi.fn().mockResolvedValue({}) },
    audit_logs: { create: vi.fn().mockResolvedValue({}) },
  };
  const connections: any = { syncableOrgRow: vi.fn().mockResolvedValue({ id: 'conn-1', provider: 'calendly' }) };
  const calendly: any = {
    listAvailableTimes: vi.fn().mockResolvedValue({
      collection: opts.times ?? [at('2026-10-08T15:00:00Z'), at('2026-10-08T20:00:00Z'), at('2026-10-08T21:30:00Z')],
    }),
    createInvitee:
      opts.createInvitee ??
      vi.fn().mockResolvedValue({ uri: 'inv-1', event: EVENT.uri, cancel_url: 'c', reschedule_url: 'r' }),
    getScheduledEvent: vi.fn().mockResolvedValue(EVENT),
    getEventType: opts.eventType ?? vi.fn().mockResolvedValue({ uri: EVENT_TYPE, locations: null }),
  };
  const assignments: any = {
    assign: opts.assignFails ? vi.fn().mockRejectedValue(opts.assignFails) : vi.fn().mockResolvedValue({ changed: true }),
  };
  const engine: any = { appointmentBooked: vi.fn().mockResolvedValue(undefined) };
  const svc = new InCallBookingService(prisma, connections, calendly, assignments, engine);
  return { svc, prisma, calendly, assignments, engine };
}

describe('availability', () => {
  it('offers real open times in the office zone, requested time first', async () => {
    const { svc, calendly } = setup();
    const r = await svc.availability(ctx, { day: 'thursday', preferred_time: '15:00' }, NOW);

    expect(calendly.listAvailableTimes).toHaveBeenCalledWith(
      expect.anything(),
      { eventTypeUri: EVENT_TYPE, start: new Date('2026-10-08T05:00:00Z'), end: new Date('2026-10-09T05:00:00Z') },
    );
    expect(r).toMatchObject({ ok: true, timezone: CHI, requestedTimeAvailable: true });
    if (!r.ok) throw new Error();
    expect(r.slots.map((s) => s.spoken)).toContain('Thursday, October 8 at 3:00 PM');
  });

  it('says when the requested time is not open', async () => {
    const r = await setup().svc.availability(ctx, { day: '2026-10-08', preferred_time: '17:00' }, NOW);
    expect(r).toMatchObject({ ok: true, requestedTimeAvailable: false });
  });

  it('falls back to the next openings when the day is full', async () => {
    const { svc, calendly } = setup();
    calendly.listAvailableTimes
      .mockResolvedValueOnce({ collection: [] })
      .mockResolvedValueOnce({ collection: [at('2026-10-09T15:00:00Z')] });
    const r = await svc.availability(ctx, { day: 'thursday' }, NOW);
    expect(r).toMatchObject({ ok: true, say: expect.stringMatching(/next openings/) });
  });

  it('asks again instead of guessing an unknown day', async () => {
    const r = await setup().svc.availability(ctx, { day: 'sometime soon' }, NOW);
    expect(r).toMatchObject({ ok: false, reason: 'unknown_day' });
  });
});

describe('book', () => {
  it('books on the round-robin type, records the appointment and assigns Calendly’s host', async () => {
    const { svc, calendly, prisma, assignments, engine } = setup();
    const r = await svc.book(ctx, { start_time: '2026-10-08T20:00:00.000Z' });

    expect(calendly.createInvitee).toHaveBeenCalledWith(expect.anything(), {
      event_type: EVENT_TYPE,
      start_time: '2026-10-08T20:00:00.000Z',
      invitee: { name: 'Bea Buyer', email: 'bea@example.com', timezone: CHI },
    });
    const upsert = prisma.appointments.upsert.mock.calls[0][0];
    expect(upsert.where.organization_id_provider_external_event_id).toEqual({
      organization_id: ORG,
      provider: 'calendly',
      external_event_id: 'evt-9',
    });
    expect(upsert.create).toMatchObject({ lead_id: LEAD, agent_id: 'agent-sunny', status: 'scheduled' });
    expect(engine.appointmentBooked).toHaveBeenCalledWith(ORG, LEAD);
    expect(assignments.assign).toHaveBeenCalledWith(ORG, null, LEAD, 'agent-sunny', expect.objectContaining({
      actorType: 'ai',
      assignmentType: 'round_robin',
    }));
    expect(r).toMatchObject({ ok: true, booked: true, agentName: 'Sunny Patel', spoken: 'Thursday, October 8 at 3:00 PM' });
  });

  it('books with the event type’s video location, so Calendly creates a join link', async () => {
    const eventType = vi.fn().mockResolvedValue({ uri: EVENT_TYPE, locations: [{ kind: 'zoom_conference' }] });
    const { svc, calendly, prisma } = setup({ eventType });
    await svc.book(ctx, { start_time: '2026-10-08T20:00:00.000Z' });

    expect(eventType).toHaveBeenCalledWith(expect.anything(), EVENT_TYPE);
    expect(calendly.createInvitee.mock.calls[0][1].location).toEqual({ kind: 'zoom_conference' });
    expect(prisma.appointments.upsert.mock.calls[0][0].create.meeting_url).toBe('https://zoom.example/j/1');
  });

  it('still books, without a location, when the event type cannot be read', async () => {
    const { svc, calendly } = setup({ eventType: vi.fn().mockRejectedValue(new Error('timeout')) });
    const r = await svc.book(ctx, { start_time: '2026-10-08T20:00:00.000Z' });

    expect(calendly.createInvitee.mock.calls[0][1].location).toBeUndefined();
    expect(r).toMatchObject({ ok: true, booked: true });
  });

  it('asks for an email when the lead has none, and saves a confirmed one', async () => {
    const noEmail = setup({ lead: { first_name: 'Bea', last_name: null, email: null } });
    expect(await noEmail.svc.book(ctx, { start_time: '2026-10-08T20:00:00Z' })).toMatchObject({
      ok: false,
      reason: 'email_required',
    });
    expect(noEmail.calendly.createInvitee).not.toHaveBeenCalled();

    const r = await noEmail.svc.book(ctx, { start_time: '2026-10-08T20:00:00Z', email: 'Bea@Example.com' });
    expect(r).toMatchObject({ ok: true });
    expect(noEmail.prisma.leads.update).toHaveBeenCalledWith({
      where: { id: LEAD },
      data: { email: 'bea@example.com', normalized_email: 'bea@example.com' },
    });
  });

  it('rejects a malformed email before calling Calendly', async () => {
    const { svc, calendly } = setup();
    expect(await svc.book(ctx, { start_time: '2026-10-08T20:00:00Z', email: 'bea at example' })).toMatchObject({
      reason: 'email_invalid',
    });
    expect(calendly.createInvitee).not.toHaveBeenCalled();
  });

  it('offers alternatives when the time was just taken', async () => {
    const taken = vi.fn().mockRejectedValue(new AppError('CONFLICT', 'slot gone'));
    const { svc } = setup({ createInvitee: taken, times: [at('2026-10-08T21:30:00Z')] });
    const r = await svc.book(ctx, { start_time: '2026-10-08T20:00:00Z' });
    expect(r).toMatchObject({ ok: false, reason: 'slot_taken' });
    if (r.ok) throw new Error();
    expect(r.slots?.[0].start).toBe('2026-10-08T21:30:00.000Z');
  });

  it('reports a failure (not "taken") when Calendly refuses a time that is still open', async () => {
    const refused = vi.fn().mockRejectedValue(new AppError('CONFLICT', 'required question missing'));
    const r = await setup({ createInvitee: refused }).svc.book(ctx, { start_time: '2026-10-08T20:00:00Z' });
    expect(r).toMatchObject({ ok: false, reason: 'booking_failed' });
  });

  it('never overrides the lead cap: booked, not assigned, visible reason', async () => {
    const { svc, prisma, engine } = setup({ assignFails: new AppError('CONFLICT', 'Sunny Patel is at their lead cap (25/25).') });
    const r = await svc.book(ctx, { start_time: '2026-10-08T20:00:00Z' });

    expect(r).toMatchObject({ ok: true, booked: true });
    expect(engine.appointmentBooked).toHaveBeenCalled();
    expect(prisma.audit_logs.create.mock.calls[0][0].data).toMatchObject({ actor_type: 'ai', action: 'lead.assignment_skipped' });
    expect(prisma.leads.update.mock.calls.at(-1)[0].data.ai_summary).toMatch(/lead cap/);
  });

  it('still reports the booking when the host is not linked to an agent, and records why', async () => {
    const { svc, prisma, assignments } = setup({ agent: null });
    const r = await svc.book(ctx, { start_time: '2026-10-08T20:00:00Z' });
    expect(r).toMatchObject({ ok: true, booked: true, agentName: 'Sunny Patel' });
    expect(prisma.appointments.upsert).not.toHaveBeenCalled();
    expect(assignments.assign).not.toHaveBeenCalled();
    expect(prisma.audit_logs.create.mock.calls[0][0].data.action).toBe('appointment.host_unlinked');
  });

  it('a recording failure after booking still tells the caller it is booked', async () => {
    const { svc, prisma } = setup();
    prisma.appointments.upsert.mockRejectedValue(new Error('db down'));
    expect(await svc.book(ctx, { start_time: '2026-10-08T20:00:00Z' })).toMatchObject({ ok: true, booked: true });
  });

  it('on a multi-host (multi-pool) meeting, assigns the first host who is linked to an agent', async () => {
    const PAT = 'https://api.calendly.com/users/u-pat';
    const { svc, calendly, assignments } = setup({
      agent: { id: 'agent-pat', display_name: 'Pat Lee', calendly_user_uri: PAT },
    });
    calendly.getScheduledEvent.mockResolvedValue({
      ...EVENT,
      event_memberships: [{ user: 'https://api.calendly.com/users/u-unlinked' }, { user: PAT, user_name: 'Pat Lee' }],
    });
    const r = await svc.book(ctx, { start_time: '2026-10-08T20:00:00Z' });
    expect(r).toMatchObject({ ok: true, agentName: 'Pat Lee' });
    expect(assignments.assign).toHaveBeenCalledWith(ORG, null, LEAD, 'agent-pat', expect.anything());
  });

  it('rejects a start time that is not a time', async () => {
    expect(await setup().svc.book(ctx, { start_time: 'thursday-ish' })).toMatchObject({ reason: 'bad_start_time' });
  });
});

describe('inviteeLocation', () => {
  it('is omitted when the event type sets no location', () => {
    expect(inviteeLocation(null)).toBeUndefined();
    expect(inviteeLocation([])).toBeUndefined();
  });

  it('prefers a video conference, which is what produces a join link', () => {
    expect(inviteeLocation([{ kind: 'physical', location: '1 Main St' }, { kind: 'google_conference' }])).toEqual({
      kind: 'google_conference',
    });
  });

  it('names the place only when there are several of that kind', () => {
    expect(inviteeLocation([{ kind: 'physical', location: '1 Main St' }])).toEqual({ kind: 'physical' });
    expect(
      inviteeLocation([
        { kind: 'physical', location: '1 Main St' },
        { kind: 'physical', location: '2 High St' },
      ]),
    ).toEqual({ kind: 'physical', location: '1 Main St' });
  });

  it('never picks a kind that needs the caller to answer', () => {
    expect(inviteeLocation([{ kind: 'ask_invitee' }, { kind: 'outbound_call' }])).toBeUndefined();
  });
});
