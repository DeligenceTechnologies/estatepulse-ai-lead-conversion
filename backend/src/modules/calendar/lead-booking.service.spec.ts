import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../auth/types';
import { leadBookingUrl } from './lead-booking-link';
import { LeadBookingService } from './lead-booking.service';
import type { NormalizedEventType } from './providers/types';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ORG = '11111111-1111-4111-8111-111111111111';
const LEAD = '01a10d51-51a2-7468-8340-60a8b40b2aae'; // a UUIDv7, as the leads table issues
const AGENT_PROFILE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOST = 'https://api.calendly.com/users/u1';

describe('leadBookingUrl', () => {
  const lead = { id: LEAD, name: 'Bea Buyer', email: 'bea@example.com' };

  it('Calendly: prefills name and email and tags the lead in utm fields', () => {
    const url = new URL(leadBookingUrl('calendly', 'https://calendly.com/sunny/30min', lead) as string);
    expect(url.origin + url.pathname).toBe('https://calendly.com/sunny/30min');
    expect(url.searchParams.get('name')).toBe('Bea Buyer');
    expect(url.searchParams.get('email')).toBe('bea@example.com');
    expect(url.searchParams.get('utm_source')).toBe('estatepulse');
    expect(url.searchParams.get('utm_content')).toBe(LEAD);
  });

  it('Cal.com: passes the lead as booking metadata', () => {
    const url = new URL(leadBookingUrl('cal', 'https://cal.com/team/acme/consult', lead) as string);
    expect(url.searchParams.get('metadata[leadId]')).toBe(LEAD);
    expect(url.searchParams.get('utm_content')).toBeNull();
  });

  it('keeps existing query parameters and omits missing contact details', () => {
    const url = new URL(leadBookingUrl('calendly', 'https://calendly.com/x?month=2026-10', { id: LEAD, name: null, email: null }) as string);
    expect(url.searchParams.get('month')).toBe('2026-10');
    expect(url.searchParams.has('name')).toBe(false);
    expect(url.searchParams.has('email')).toBe(false);
  });

  it('refuses anything that is not an https URL', () => {
    expect(leadBookingUrl('calendly', 'not a url', lead)).toBeNull();
    expect(leadBookingUrl('calendly', 'http://calendly.com/x', lead)).toBeNull();
    expect(leadBookingUrl('calendly', 'javascript:alert(1)', lead)).toBeNull();
  });
});

const owner = { organizationId: ORG, role: 'owner', agentProfileId: null } as unknown as AuthContext;
const agent = { organizationId: ORG, role: 'agent', agentProfileId: AGENT_PROFILE } as unknown as AuthContext;

const et = (over: Partial<NormalizedEventType>): NormalizedEventType => ({
  id: 'et',
  name: '30 Minute Meeting',
  active: true,
  durationMinutes: 30,
  schedulingUrl: 'https://calendly.com/sunny/30min',
  poolingType: null,
  ownerName: 'Sunny',
  ownerType: 'User',
  hostIds: [HOST],
  ...over,
});

function setup(opts: {
  lead?: any;
  profile?: any;
  conn?: any;
  eventTypes?: NormalizedEventType[];
} = {}) {
  const prisma: any = {
    leads: {
      findFirst: vi.fn().mockResolvedValue(
        opts.lead === undefined ? { id: LEAD, first_name: 'Bea', last_name: 'Buyer', email: 'bea@example.com' } : opts.lead,
      ),
    },
    lead_assignments: {
      findFirst: vi.fn().mockResolvedValue(
        opts.profile === null
          ? null
          : {
              agent_profiles: opts.profile ?? {
                id: AGENT_PROFILE,
                display_name: 'Sunny Patel',
                calendly_user_uri: HOST,
                cal_user_id: null,
              },
            },
      ),
    },
  };
  const connections: any = {
    syncableOrgRow: vi.fn().mockResolvedValue(opts.conn === undefined ? { id: 'c', provider: 'calendly' } : opts.conn),
  };
  const listEventTypes = vi.fn().mockResolvedValue(opts.eventTypes ?? [et({})]);
  const providers: any = { get: vi.fn().mockReturnValue({ id: 'calendly', listEventTypes }) };
  const appointments: any = { forLead: vi.fn().mockResolvedValue([]) };
  return { svc: new LeadBookingService(prisma, connections, providers, appointments), prisma, listEventTypes, appointments };
}

describe('LeadBookingService.options', () => {
  it("offers the assigned agent's own event types as links tied to this lead", async () => {
    const { svc, listEventTypes } = setup();
    const r = await svc.options(owner, LEAD);

    expect(r.blocker).toBeNull();
    expect(r.agent).toEqual({ id: AGENT_PROFILE, name: 'Sunny Patel' });
    expect(r.provider).toBe('calendly');
    expect(listEventTypes).toHaveBeenCalledWith(expect.anything(), { memberHostIds: [HOST] });
    expect(r.eventTypes).toHaveLength(1);
    const url = new URL(r.eventTypes[0].bookingUrl);
    expect(url.searchParams.get('utm_content')).toBe(LEAD);
    expect(url.searchParams.get('name')).toBe('Bea Buyer');
  });

  it("leaves out round-robin/team pages, other agents' pages, inactive and link-less ones", async () => {
    const { svc } = setup({
      eventTypes: [
        et({ id: 'mine', name: 'Mine' }),
        et({ id: 'rr', poolingType: 'round_robin', ownerType: 'Team', hostIds: [] }),
        et({ id: 'other', hostIds: ['https://api.calendly.com/users/u2'] }),
        et({ id: 'shared', hostIds: [HOST, 'https://api.calendly.com/users/u2'] }),
        et({ id: 'off', active: false }),
        et({ id: 'nolink', schedulingUrl: null }),
      ],
    });
    const r = await svc.options(owner, LEAD);
    expect(r.eventTypes.map((e) => e.id)).toEqual(['mine']);
  });

  it('explains each reason a lead cannot be booked yet, in order', async () => {
    expect((await setup({ profile: null }).svc.options(owner, LEAD)).blocker).toBe('no_agent');
    expect((await setup({ conn: null }).svc.options(owner, LEAD)).blocker).toBe('no_calendar');
    expect(
      (await setup({ profile: { id: AGENT_PROFILE, display_name: 'Sunny', calendly_user_uri: null, cal_user_id: null } }).svc.options(owner, LEAD))
        .blocker,
    ).toBe('agent_not_linked');
    expect((await setup({ eventTypes: [] }).svc.options(owner, LEAD)).blocker).toBe('no_event_types');
  });

  it('scopes an agent to leads currently assigned to them', async () => {
    const { svc, prisma } = setup();
    await svc.options(agent, LEAD);
    expect(prisma.leads.findFirst.mock.calls[0][0].where).toEqual({
      id: LEAD,
      organization_id: ORG,
      lead_assignments: { some: { agent_id: AGENT_PROFILE, is_current: true } },
    });
  });

  it('gives an owner every lead in their organization, and only theirs', async () => {
    const { svc, prisma } = setup();
    await svc.options(owner, LEAD);
    expect(prisma.leads.findFirst.mock.calls[0][0].where).toEqual({ id: LEAD, organization_id: ORG });
  });

  it('is NOT_FOUND for a lead the caller cannot see, or a malformed id', async () => {
    await expect(setup({ lead: null }).svc.options(agent, LEAD)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const { svc, prisma } = setup();
    await expect(svc.options(owner, 'not-a-uuid')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.leads.findFirst).not.toHaveBeenCalled();
  });
});

describe('LeadBookingService.appointmentsFor', () => {
  it("reads in the caller's organization, scoped to an agent's current leads", async () => {
    const ok = setup();
    await ok.svc.appointmentsFor(owner, LEAD);
    expect(ok.appointments.forLead).toHaveBeenCalledWith(ORG, LEAD, null);

    await ok.svc.appointmentsFor(agent, LEAD);
    expect(ok.appointments.forLead).toHaveBeenLastCalledWith(ORG, LEAD, AGENT_PROFILE);
  });

  it('is NOT_FOUND for a lead the caller cannot see, or a malformed id', async () => {
    const hidden = setup();
    hidden.appointments.forLead.mockResolvedValue(null);
    await expect(hidden.svc.appointmentsFor(agent, LEAD)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const { svc, appointments } = setup();
    await expect(svc.appointmentsFor(owner, 'not-a-uuid')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(appointments.forLead).not.toHaveBeenCalled();
  });
});
