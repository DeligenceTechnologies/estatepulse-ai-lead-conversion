import { describe, expect, it, vi } from 'vitest';
import type { GuardedPrisma } from '../../prisma/prisma.service';
import type { EngineService } from '../../telnyx/engine.service';
import { CalendarSyncService } from './calendar-sync.service';
import type { CalendarConnectionsService } from './calendar-connections.service';
import type { CalendlyClientService } from './calendly.client';
import { CalComProvider } from './providers/calcom.provider';
import type { CalComClientService } from './providers/calcom.client';
import type { CalComBooking } from './providers/calcom.types';
import { CalendlyProvider } from './providers/calendly.provider';
import { CalendarProviderRegistry } from './providers/provider.registry';
import type { CalendlyInvitee, CalendlyScheduledEvent } from './types';

/**
 * Unit suite for the reconciler, driven through the REAL provider adapters.
 *
 * Only the HTTP clients are doubled. That is deliberate: the adapters are where
 * Calendly's URIs-and-two-requests and Cal.com's integers-and-one-request are
 * translated into the single shape the reconciler understands, so stubbing at
 * the provider boundary instead would leave exactly the code most likely to be
 * wrong untested.
 *
 * The prisma double is a tiny in-memory table rather than a returns-a-fixed-
 * object mock, because what matters here is *which rows exist afterwards* —
 * specifically that a booking which matches no lead leaves NOTHING behind, and
 * that a second pass over the same booking does not duplicate it.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '99999999-9999-4999-8999-999999999999';
const AGENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CONN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const LEAD = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

/** The office's Calendly organization — every read is scoped to this. */
const CAL_ORG = 'https://api.calendly.com/organizations/o1';
/** The Calendly member AGENT is linked to, via agent_profiles.calendly_user_uri. */
const CAL_HOST = 'https://api.calendly.com/users/u1';
/** A Calendly member nobody here is linked to. */
const CAL_STRANGER = 'https://api.calendly.com/users/u-unknown';

/** The Cal.com member AGENT is linked to, via agent_profiles.cal_user_id. */
const CAL_COM_HOST = 501;

interface LeadRow {
  id: string;
  organization_id: string;
  normalized_email: string | null;
  normalized_phone: string | null;
  status: string;
  updated_at: Date;
}

interface ApptRow {
  id: string;
  organization_id: string;
  lead_id: string;
  agent_id: string;
  provider: string;
  external_event_id: string | null;
  status: string;
  start_at: Date;
  end_at: Date;
  meeting_url: string | null;
  metadata: Record<string, unknown>;
}

/** A roster row, as hostIndex selects it: both provider columns, one populated. */
interface HostRow {
  id: string;
  calendly_user_uri: string | null;
  cal_user_id: number | null;
}

function makeDb(leads: LeadRow[], hosts: HostRow[]) {
  const appointments: ApptRow[] = [];

  const prisma = {
    // The host index the sweep loads once: which agent each scheduling user is.
    // It filters on whichever column belongs to the connected provider, so the
    // double honours the `NOT: { <column>: null }` predicate rather than
    // returning everyone — otherwise a Calendly roster would answer a Cal.com
    // sweep and the provider dispatch would go untested.
    agent_profiles: {
      findMany: async ({ where }: any) => {
        if (where.organization_id !== ORG) return [];
        const column = Object.keys(where.NOT ?? {})[0];
        return column ? hosts.filter((h) => (h as any)[column] != null) : hosts;
      },
    },
    leads: {
      findFirst: async ({ where }: any) => {
        const notIn: string[] = where.status?.notIn ?? [];
        return (
          leads
            .filter(
              (l) =>
                l.organization_id === where.organization_id &&
                (where.id === undefined || l.id === where.id) &&
                !notIn.includes(l.status) &&
                (where.normalized_email === undefined ||
                  l.normalized_email === where.normalized_email) &&
                (where.normalized_phone === undefined ||
                  l.normalized_phone === where.normalized_phone),
            )
            .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime())[0] ?? null
        );
      },
    },
    appointments: {
      findFirst: async ({ where }: any) =>
        appointments.find(
          (a) =>
            a.organization_id === where.organization_id &&
            a.provider === where.provider &&
            a.external_event_id === where.external_event_id,
        ) ?? null,
      upsert: async ({ where, create, update }: any) => {
        const key = where.organization_id_provider_external_event_id;
        const found = appointments.find(
          (a) =>
            a.organization_id === key.organization_id &&
            a.provider === key.provider &&
            a.external_event_id === key.external_event_id,
        );
        if (found) {
          Object.assign(found, update);
          return found;
        }
        const row = { ...create } as ApptRow;
        appointments.push(row);
        return row;
      },
    },
  } as unknown as GuardedPrisma;

  return { prisma, appointments };
}

/** The collaborators that are the same whichever provider is under test. */
function shared(prisma: GuardedPrisma) {
  const connections = {
    recordSyncSuccess: vi.fn(async () => {}),
    recordSyncError: vi.fn(async () => {}),
    markReauthRequired: vi.fn(async () => {}),
  } as unknown as CalendarConnectionsService;

  const appointmentBooked = vi.fn(async () => {});
  const engine = { appointmentBooked } as unknown as EngineService;
  const config = { get: () => undefined } as any;

  return { connections, engine, appointmentBooked, config, prisma };
}

function makeService(
  leads: LeadRow[],
  events: CalendlyScheduledEvent[],
  invitees: Record<string, CalendlyInvitee[]>,
  hosts: HostRow[] = [{ id: AGENT, calendly_user_uri: CAL_HOST, cal_user_id: null }],
) {
  const { prisma, appointments } = makeDb(leads, hosts);

  const listInvitees = vi.fn(async (_c: unknown, uri: string) => ({
    collection: invitees[uri] ?? [],
    pagination: { count: 0, next_page_token: null },
  }));

  const calendly = {
    listScheduledEvents: vi.fn(async () => ({
      collection: events,
      pagination: { count: events.length, next_page_token: null },
    })),
    listInvitees,
  } as unknown as CalendlyClientService;

  // The REAL adapter over the stubbed client, and a registry holding it, so the
  // Calendly-shaped translation is exercised rather than assumed.
  const registry = new CalendarProviderRegistry(
    new CalendlyProvider(calendly),
    new CalComProvider({} as unknown as CalComClientService),
  );

  const s = shared(prisma);
  const service = new CalendarSyncService(s.config, registry, s.connections, s.engine, prisma);
  const conn = {
    id: CONN,
    organization_id: ORG,
    // NULL: this is the OFFICE's connection, not an agent's. The agent an
    // appointment belongs to comes from the booking's host, not from here.
    agent_id: null,
    provider: 'calendly',
    credentials_secret_ref: 'enc',
    metadata: { calendlyOrgUri: CAL_ORG },
  };

  return { service, conn, appointments, appointmentBooked: s.appointmentBooked, listInvitees };
}

/** The same harness for Cal.com: one booking payload, no attendee round trip. */
function makeCalService(
  leads: LeadRow[],
  bookings: CalComBooking[],
  hosts: HostRow[] = [{ id: AGENT, calendly_user_uri: null, cal_user_id: CAL_COM_HOST }],
) {
  const { prisma, appointments } = makeDb(leads, hosts);

  const listTeamBookings = vi.fn(async () => ({
    status: 'success',
    data: bookings,
    pagination: { hasNextPage: false },
  }));

  const calcom = {
    listTeamBookings,
    bookingBaseUrl: 'https://cal.com',
  } as unknown as CalComClientService;

  const registry = new CalendarProviderRegistry(
    new CalendlyProvider({} as unknown as CalendlyClientService),
    new CalComProvider(calcom),
  );

  const s = shared(prisma);
  const service = new CalendarSyncService(s.config, registry, s.connections, s.engine, prisma);
  const conn = {
    id: CONN,
    organization_id: ORG,
    agent_id: null,
    provider: 'cal',
    credentials_secret_ref: 'enc',
    metadata: { calTeamId: 42, calTeamSlug: 'austin-realty' },
  };

  return { service, conn, appointments, appointmentBooked: s.appointmentBooked, listTeamBookings };
}

const EVENT_URI = 'https://api.calendly.com/scheduled_events/evt-1';

function event(over: Partial<CalendlyScheduledEvent> = {}): CalendlyScheduledEvent {
  return {
    uri: EVENT_URI,
    name: 'Buyer Consultation',
    status: 'active',
    start_time: '2026-10-01T15:00:00.000Z',
    end_time: '2026-10-01T15:30:00.000Z',
    updated_at: '2026-09-20T10:00:00.000Z',
    location: { join_url: 'https://meet.example/abc' },
    // Who hosted it. With one office token this is the ONLY thing on the event
    // that says whose booking it is.
    event_memberships: [{ user: CAL_HOST, user_email: 'alex@office.example' }],
    ...over,
  };
}

function invitee(over: Partial<CalendlyInvitee> = {}): CalendlyInvitee {
  return {
    uri: 'https://api.calendly.com/scheduled_events/evt-1/invitees/i1',
    email: 'buyer@example.com',
    name: 'Bea Buyer',
    status: 'active',
    timezone: 'America/Chicago',
    text_reminder_number: null,
    cancel_url: 'https://calendly.com/cancel/x',
    reschedule_url: 'https://calendly.com/reschedule/x',
    rescheduled: false,
    new_invitee: null,
    old_invitee: null,
    ...over,
  };
}

const CAL_BOOKING_UID = 'bk-1';

function calBooking(over: Partial<CalComBooking> = {}): CalComBooking {
  return {
    id: 1,
    uid: CAL_BOOKING_UID,
    title: 'Buyer Consultation',
    status: 'accepted',
    start: '2026-10-01T15:00:00.000Z',
    end: '2026-10-01T15:30:00.000Z',
    duration: 30,
    meetingUrl: 'https://meet.example/abc',
    createdAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-20T10:00:00.000Z',
    // Cal.com names its host by integer id, and returns the attendee inline —
    // the two differences from Calendly that the adapter has to absorb.
    hosts: [
      {
        id: CAL_COM_HOST,
        name: 'Alex Vance',
        email: 'alex@office.example',
        username: 'alex',
        timeZone: 'America/Chicago',
      },
    ],
    attendees: [
      {
        name: 'Bea Buyer',
        email: 'buyer@example.com',
        timeZone: 'America/Chicago',
      },
    ],
    ...over,
  };
}

function lead(over: Partial<LeadRow> = {}): LeadRow {
  return {
    id: LEAD,
    organization_id: ORG,
    normalized_email: 'buyer@example.com',
    normalized_phone: null,
    status: 'contacting',
    updated_at: new Date('2026-09-01T00:00:00Z'),
    ...over,
  };
}

describe('CalendarSyncService.reconcile', () => {
  it('stores an appointment when the invitee matches a lead', async () => {
    const { service, conn, appointments, appointmentBooked } = makeService(
      [lead()],
      [event()],
      { [EVENT_URI]: [invitee()] },
    );

    const result = await service.syncConnection(conn);

    expect(result).toMatchObject({ scanned: 1, created: 1, updated: 0, skippedNoLead: 0 });
    expect(appointments).toHaveLength(1);
    expect(appointments[0]).toMatchObject({
      organization_id: ORG,
      lead_id: LEAD,
      agent_id: AGENT,
      provider: 'calendly',
      external_event_id: 'evt-1',
      status: 'scheduled',
      meeting_url: 'https://meet.example/abc',
    });
    // The booking must end the outbound cadence.
    expect(appointmentBooked).toHaveBeenCalledWith(ORG, LEAD);
  });

  it('stores NOTHING when no lead matches — and never invents one', async () => {
    const { service, conn, appointments, appointmentBooked } = makeService(
      [lead({ normalized_email: 'someone-else@example.com' })],
      [event()],
      { [EVENT_URI]: [invitee()] },
    );

    const result = await service.syncConnection(conn);

    // This is the invariant the whole design rests on: appointments.lead_id is
    // NOT NULL because an appointment is a commitment to somebody in the
    // funnel, and a calendar event is not evidence that such a person exists.
    expect(result).toMatchObject({ scanned: 1, created: 0, skippedNoLead: 1 });
    expect(appointments).toHaveLength(0);
    expect(appointmentBooked).not.toHaveBeenCalled();
  });

  it('does not match a lead from another organization', async () => {
    const { service, conn, appointments } = makeService(
      [lead({ organization_id: OTHER_ORG })],
      [event()],
      { [EVENT_URI]: [invitee()] },
    );

    const result = await service.syncConnection(conn);
    expect(result.skippedNoLead).toBe(1);
    expect(appointments).toHaveLength(0);
  });

  it('attributes a booking made through the lead\'s own link, whatever email was typed', async () => {
    const { service, conn, appointments } = makeService([lead()], [event()], {
      [EVENT_URI]: [
        invitee({ email: 'someone-else@work.example', tracking: { utm_source: 'estatepulse', utm_content: LEAD } }),
      ],
    });

    const result = await service.syncConnection(conn);

    expect(result).toMatchObject({ created: 1, skippedNoLead: 0 });
    expect(appointments[0].lead_id).toBe(LEAD);
  });

  it('ignores a lead id from another organization in the link, and falls back to email', async () => {
    const foreign = lead({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', organization_id: OTHER_ORG, normalized_email: 'x@x.example' });
    const { service, conn, appointments } = makeService([lead(), foreign], [event()], {
      [EVENT_URI]: [invitee({ tracking: { utm_source: 'estatepulse', utm_content: foreign.id } })],
    });

    await service.syncConnection(conn);

    expect(appointments[0].lead_id).toBe(LEAD);
  });

  it('skips a link-tagged booking whose lead id belongs to another organization and whose email matches nobody', async () => {
    const foreign = lead({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', organization_id: OTHER_ORG });
    const { service, conn, appointments } = makeService([foreign], [event()], {
      [EVENT_URI]: [invitee({ email: 'nobody@example.com', tracking: { utm_source: 'estatepulse', utm_content: foreign.id } })],
    });

    const result = await service.syncConnection(conn);

    expect(result.skippedNoLead).toBe(1);
    expect(appointments).toHaveLength(0);
  });

  it('only trusts utm_content when our own utm_source tagged it', async () => {
    const { service, conn, appointments } = makeService([lead()], [event()], {
      [EVENT_URI]: [invitee({ email: 'nobody@example.com', tracking: { utm_source: 'newsletter', utm_content: LEAD } })],
    });

    const result = await service.syncConnection(conn);

    expect(result.skippedNoLead).toBe(1);
    expect(appointments).toHaveLength(0);
  });

  it('does not reopen a closed or lost lead', async () => {
    const { service, conn, appointments } = makeService(
      [lead({ status: 'closed' })],
      [event()],
      { [EVENT_URI]: [invitee()] },
    );

    await service.syncConnection(conn);
    expect(appointments).toHaveLength(0);
  });

  it('matches on phone when the invitee has no usable email', async () => {
    const { service, conn, appointments } = makeService(
      [lead({ normalized_email: null, normalized_phone: '+15125551234' })],
      [event()],
      { [EVENT_URI]: [invitee({ email: 'n/a', text_reminder_number: '+15125551234' })] },
    );

    await service.syncConnection(conn);
    expect(appointments).toHaveLength(1);
    expect(appointments[0].lead_id).toBe(LEAD);
  });

  it('is idempotent: re-syncing the same event does not duplicate it', async () => {
    const { service, conn, appointments, listInvitees, appointmentBooked } = makeService(
      [lead()],
      [event()],
      { [EVENT_URI]: [invitee()] },
    );

    await service.syncConnection(conn);
    const second = await service.syncConnection(conn);

    expect(appointments).toHaveLength(1);
    // Unchanged updated_at means the second pass skips the invitee request
    // entirely — the whole point of storing externalUpdatedAt.
    expect(listInvitees).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ created: 0, updated: 0 });
    // And it must not re-stamp the lead on every tick.
    expect(appointmentBooked).toHaveBeenCalledTimes(1);
  });

  it('flips to cancelled when the event is canceled', async () => {
    const { service, conn, appointments } = makeService([lead()], [event()], {
      [EVENT_URI]: [invitee()],
    });
    await service.syncConnection(conn);

    const cancelled = makeService(
      [lead()],
      [
        event({
          status: 'canceled',
          updated_at: '2026-09-21T10:00:00.000Z',
          cancellation: { reason: 'Something came up', canceled_by: 'Bea Buyer' },
        }),
      ],
      { [EVENT_URI]: [invitee()] },
    );
    // Reuse the first run's table so this is genuinely an update.
    (cancelled.service as any).prisma = (service as any).prisma;
    await cancelled.service.syncConnection(cancelled.conn);

    expect(appointments).toHaveLength(1);
    expect(appointments[0].status).toBe('cancelled');
    expect(appointments[0].metadata.canceledReason).toBe('Something came up');
  });

  it("records a reschedule as 'rescheduled', not a lost booking", async () => {
    const { service, conn, appointments } = makeService(
      [lead()],
      [event({ status: 'canceled' })],
      { [EVENT_URI]: [invitee({ rescheduled: true, new_invitee: 'https://…/i2' })] },
    );

    await service.syncConnection(conn);

    // 'cancelled' here would read as a lost booking on a screen where lost
    // bookings matter. The replacement event arrives as an ordinary new one.
    expect(appointments[0].status).toBe('rescheduled');
  });

  it('never re-points an existing appointment at a different lead', async () => {
    const first = makeService([lead()], [event()], { [EVENT_URI]: [invitee()] });
    await first.service.syncConnection(first.conn);
    expect(first.appointments[0].lead_id).toBe(LEAD);

    // The same event now resolves to a different lead (someone edited the
    // invitee's address, say). The stored attribution must win.
    const OTHER_LEAD = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const second = makeService(
      [lead({ id: OTHER_LEAD, normalized_email: 'changed@example.com' })],
      [event({ updated_at: '2026-09-21T12:00:00.000Z' })],
      { [EVENT_URI]: [invitee({ email: 'changed@example.com' })] },
    );
    (second.service as any).prisma = (first.service as any).prisma;
    await second.service.syncConnection(second.conn);

    expect(first.appointments).toHaveLength(1);
    expect(first.appointments[0].lead_id).toBe(LEAD);
  });

  // ---------------------------------------------------------------------------
  // Host attribution — everything below is what office-level Calendly added.
  // ---------------------------------------------------------------------------

  it('attributes the appointment to the agent who HOSTED it', async () => {
    const OTHER_AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const OTHER_HOST = 'https://api.calendly.com/users/u2';

    // A round-robin event type rotated this booking to the second agent. With
    // one office token there is no per-agent connection to infer the owner
    // from, so event_memberships is the only thing that can say so.
    const { service, conn, appointments } = makeService(
      [lead()],
      [event({ event_memberships: [{ user: OTHER_HOST, user_email: 'sam@office.example' }] })],
      { [EVENT_URI]: [invitee()] },
      [
        { id: AGENT, calendly_user_uri: CAL_HOST, cal_user_id: null },
        { id: OTHER_AGENT, calendly_user_uri: OTHER_HOST, cal_user_id: null },
      ],
    );

    await service.syncConnection(conn);

    expect(appointments).toHaveLength(1);
    expect(appointments[0].agent_id).toBe(OTHER_AGENT);
  });

  it('stores NOTHING when the host is not on our roster, and says which count it was', async () => {
    const { service, conn, appointments, listInvitees } = makeService(
      [lead()],
      [event({ event_memberships: [{ user: CAL_STRANGER, user_email: 'nobody@office.example' }] })],
      { [EVENT_URI]: [invitee()] },
    );

    const result = await service.syncConnection(conn);

    // appointments.agent_id is NOT NULL, so there is no half-row to write. It
    // is counted apart from skippedNoLead because this one is a roster the
    // owner can fix, and the two would be indistinguishable in one number.
    expect(result).toMatchObject({ scanned: 1, created: 0, skippedNoLead: 0, skippedNoAgent: 1 });
    expect(appointments).toHaveLength(0);
    // And it gave up BEFORE paying for the invitee request.
    expect(listInvitees).not.toHaveBeenCalled();
  });

  it('follows a host reassignment onto the new agent', async () => {
    const OTHER_AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const OTHER_HOST = 'https://api.calendly.com/users/u2';
    const roster = [
      { id: AGENT, calendly_user_uri: CAL_HOST, cal_user_id: null },
      { id: OTHER_AGENT, calendly_user_uri: OTHER_HOST, cal_user_id: null },
    ];

    const first = makeService([lead()], [event()], { [EVENT_URI]: [invitee()] }, roster);
    await first.service.syncConnection(first.conn);
    expect(first.appointments[0].agent_id).toBe(AGENT);

    // A Calendly admin moved the meeting to a colleague. Unlike lead_id, this
    // MUST follow: leaving it would keep the meeting on the wrong person's day.
    const second = makeService(
      [lead()],
      [
        event({
          updated_at: '2026-09-21T12:00:00.000Z',
          event_memberships: [{ user: OTHER_HOST, user_email: 'sam@office.example' }],
        }),
      ],
      { [EVENT_URI]: [invitee()] },
      roster,
    );
    (second.service as any).prisma = (first.service as any).prisma;
    await second.service.syncConnection(second.conn);

    expect(first.appointments).toHaveLength(1);
    expect(first.appointments[0].agent_id).toBe(OTHER_AGENT);
  });

  it('refuses loudly, and writes nothing, when the connection has no provider config', async () => {
    const { service, conn, appointments } = makeService([lead()], [event()], {
      [EVENT_URI]: [invitee()],
    });

    // A connection with no organization URI cannot read anything, and this
    // REJECTS rather than returning an empty result. That is a deliberate
    // change from the pre-provider version, which returned zeros: a sweep that
    // reports "0 scanned" and success is indistinguishable from a quiet office,
    // so the one case the owner has to act on looked exactly like the common
    // case where nothing happened. syncConnection's catch still records the
    // reason on the row before rethrowing.
    await expect(service.syncConnection({ ...conn, metadata: {} })).rejects.toThrow(
      /missing its organization URI/,
    );
    expect(appointments).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Cal.com — the same reconciler, a different provider underneath.
// ---------------------------------------------------------------------------

describe('CalendarSyncService.reconcile — Cal.com', () => {
  it('stores an appointment, matching the host by numeric Cal.com user id', async () => {
    const { service, conn, appointments, appointmentBooked } = makeCalService(
      [lead()],
      [calBooking()],
    );

    const result = await service.syncConnection(conn);

    expect(result).toMatchObject({ scanned: 1, created: 1, skippedNoLead: 0, skippedNoAgent: 0 });
    expect(appointments).toHaveLength(1);
    expect(appointments[0]).toMatchObject({
      organization_id: ORG,
      lead_id: LEAD,
      agent_id: AGENT,
      // The provider column is what keeps two providers' ids in separate
      // keyspaces — the same external id from each is two different meetings.
      provider: 'cal',
      external_event_id: CAL_BOOKING_UID,
      status: 'scheduled',
      meeting_url: 'https://meet.example/abc',
    });
    expect(appointmentBooked).toHaveBeenCalledWith(ORG, LEAD);
  });

  it('attributes a Cal.com booking by the metadata[leadId] our link passed', async () => {
    const { service, conn, appointments } = makeCalService(
      [lead()],
      [calBooking({ attendees: [{ name: 'B', email: 'other@example.com', timeZone: 'UTC' }], metadata: { leadId: LEAD } })],
    );

    const result = await service.syncConnection(conn);

    expect(result).toMatchObject({ created: 1, skippedNoLead: 0 });
    expect(appointments[0].lead_id).toBe(LEAD);
  });

  it('never asks for the attendee — Cal.com returns it with the booking', async () => {
    const { service, conn, listTeamBookings } = makeCalService([lead()], [calBooking()]);

    await service.syncConnection(conn);

    // One request for the whole sweep. The Calendly path needs a second call
    // per changed booking; this is the difference the adapter absorbs.
    expect(listTeamBookings).toHaveBeenCalledTimes(1);
  });

  it('treats a pending booking as scheduled', async () => {
    // Awaiting the agent's confirmation is still a commitment in the diary, and
    // the outbound cadence must stop either way.
    const { service, conn, appointments } = makeCalService(
      [lead()],
      [calBooking({ status: 'pending' })],
    );

    await service.syncConnection(conn);
    expect(appointments[0].status).toBe('scheduled');
  });

  it("records a Cal.com reschedule as 'rescheduled', not a lost booking", async () => {
    const { service, conn, appointments } = makeCalService(
      [lead()],
      [calBooking({ status: 'cancelled', rescheduledToUid: 'bk-2' })],
    );

    await service.syncConnection(conn);

    // Cal.com settles this on the booking itself, where Calendly defers it to
    // the invitee. Same stored outcome, reached two different ways.
    expect(appointments[0].status).toBe('rescheduled');
  });

  it('records a real cancellation as cancelled', async () => {
    const { service, conn, appointments } = makeCalService(
      [lead()],
      [calBooking({ status: 'cancelled', cancellationReason: 'Something came up' })],
    );

    await service.syncConnection(conn);
    expect(appointments[0].status).toBe('cancelled');
    expect(appointments[0].metadata.canceledReason).toBe('Something came up');
  });

  it('skips a booking whose Cal.com host is not on our roster', async () => {
    const { service, conn, appointments } = makeCalService(
      [lead()],
      [
        calBooking({
          hosts: [
            {
              id: 999,
              name: 'Nobody',
              email: 'nobody@office.example',
              username: 'nobody',
              timeZone: 'UTC',
            },
          ],
        }),
      ],
    );

    const result = await service.syncConnection(conn);
    expect(result).toMatchObject({ scanned: 1, created: 0, skippedNoAgent: 1 });
    expect(appointments).toHaveLength(0);
  });

  it('does not match a Cal.com host against a Calendly-linked roster', async () => {
    // The host index filters on the column belonging to the CONNECTED provider.
    // An office that switched from Calendly still has calendly_user_uri on
    // every agent, and none of it may be allowed to answer a Cal.com sweep.
    const { service, conn, appointments } = makeCalService([lead()], [calBooking()], [
      { id: AGENT, calendly_user_uri: CAL_HOST, cal_user_id: null },
    ]);

    const result = await service.syncConnection(conn);
    expect(result).toMatchObject({ skippedNoAgent: 1, created: 0 });
    expect(appointments).toHaveLength(0);
  });

  it('is idempotent across sweeps', async () => {
    const { service, conn, appointments, appointmentBooked } = makeCalService(
      [lead()],
      [calBooking()],
    );

    await service.syncConnection(conn);
    const second = await service.syncConnection(conn);

    expect(appointments).toHaveLength(1);
    expect(second).toMatchObject({ created: 0, updated: 0 });
    expect(appointmentBooked).toHaveBeenCalledTimes(1);
  });
});
