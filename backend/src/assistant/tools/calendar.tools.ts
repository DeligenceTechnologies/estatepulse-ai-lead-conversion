import { z } from 'zod';
import type { AuthContext } from '@/auth/auth.types';
import type { AppointmentsService } from '@/calendar/appointments/appointments.service';
import { spoken } from '@/calendar/booking/booking-time';
import type { InCallBookingSettingsService } from '@/calendar/booking/in-call-booking-settings.service';
import type { InCallBookingService, Slot } from '@/calendar/booking/in-call-booking.service';
import type { LeadBookingService } from '@/calendar/booking/lead-booking.service';
import type { ToolContext as BookingContext } from '@/calendar/booking/tool-auth.service';
import { AppError } from '@/common/errors/app-error';
import type { GuardedPrisma, PrismaService } from '@/common/prisma/prisma.service';
import { contactZone, leadZone } from '@/common/utils/lead-timezone';
import { visibleLeads } from '@/lead/lead-scope';
import { nextMeeting } from '@/lead/upcoming-meeting';
import { PERMISSIONS } from '@/role/permissions';
import { findVisibleLead, leadName, officeTimezone } from './lead-access';
import { MAX_TEXT, TEXT_LEAD, sendLeadText, textBlocker, textNotes, type LeadTextDeps, type TextLead } from './lead-text';
import { leadRef, refOf, slotRef, userRef, type RefTable } from './refs';
import { readTool, writeTool, type AssistantTool } from './tool';

export interface CalendarToolDeps {
  prisma: GuardedPrisma;
  appointments: AppointmentsService;
  booking: InCallBookingService;
  bookingSettings: InCallBookingSettingsService;
  leadBooking: LeadBookingService;
  text: LeadTextDeps;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const UPCOMING_DAYS = 14;
/** A slot this close to now is too late to book. */
const MIN_AHEAD_MS = 60_000;

const BOOKING_OFF =
  'Booking from the assistant uses in-call booking, which is off for this office. Turn it on under Calendar settings, or text the lead a booking link with booking_link_send.';

const LINK_BLOCKER = {
  no_agent: 'This lead has no agent. Assign one first: the link books a meeting on their calendar.',
  no_calendar: 'No calendar is connected. Connect Calendly or Cal.com under Calendar settings.',
  agent_not_linked: "The lead's agent is not linked to a member of the connected calendar. Link them under Calendar settings.",
  no_event_types: "The lead's agent has no meeting types to book on.",
} as const;

/** The office's in-call booking set-up, which assistant bookings use too. */
async function bookingConfig(deps: CalendarToolDeps, orgId: string) {
  const config = await deps.bookingSettings.activeConfig(orgId);
  if (!config) throw new AppError('CONFLICT', BOOKING_OFF);
  return config;
}

async function bookingContext(deps: CalendarToolDeps, auth: AuthContext, leadId: string): Promise<BookingContext> {
  return { orgId: auth.organizationId, leadId, callId: null, config: await bookingConfig(deps, auth.organizationId), staff: { userId: auth.userId } };
}

/** The open times as refs, with the lead's clock beside the office's when it differs. */
async function slotRefs(refs: RefTable, slots: Slot[], leadClock: string | null, officeClock: string) {
  const refByStart = await refs.issue('slot', slots.map((s) => s.start));
  return slots.map((s) => ({
    ref: refByStart.get(s.start)!,
    time: s.spoken,
    ...(leadClock && leadClock !== officeClock ? { leadTime: spoken(new Date(s.start), leadClock) } : {}),
  }));
}

/** The lead's own time zone, when there is one to go on. */
const clockOf = (lead: { timezone: string | null; normalizedPhone: string | null }): string | null => contactZone(leadZone(lead));

/** The booking text: the person's own words or a standard line, then the link. */
function bookingText(lead: { firstName: string | null }, agent: string, url: string, message?: string): string {
  const intro = message?.trim() || `Hi ${lead.firstName?.trim() || 'there'}, here is a link to pick a time with ${agent.split(' ')[0]}:`;
  return `${intro} ${url}`;
}

export function calendarTools(deps: CalendarToolDeps): AssistantTool[] {
  const { prisma } = deps;

  /** What the card and the send both work from, so the text that goes is the one the card showed. */
  async function bookingLink(auth: AuthContext, refs: RefTable, input: { lead: string; message?: string }) {
    const lead = await findVisibleLead(prisma, auth, refs, input.lead, { ...TEXT_LEAD, email: true });
    const options = await deps.leadBooking.options(auth, lead.id);
    if (options.blocker) throw new AppError('CONFLICT', LINK_BLOCKER[options.blocker]);
    const meetingType = options.eventTypes[0];
    const agent = options.agent!.name;
    const text = bookingText(lead, agent, meetingType.bookingUrl, input.message);
    if (text.length > MAX_TEXT) throw new AppError('VALIDATION_ERROR', 'That message is too long with the link added. Shorten it.');
    const blocked = await textBlocker(deps.text, auth, lead);
    if (blocked) throw new AppError('CONFLICT', blocked);
    return { lead, agent, meetingType, text };
  }

  return [
    readTool({
      name: 'meeting_list',
      label: 'Looking up meetings',
      description: `Meetings booked with leads, soonest first, with the agent and the time. Without dates it covers the next ${UPCOMING_DAYS} days; for one lead, its recent and upcoming meetings.`,
      permissions: [],
      input: z
        .object({
          lead: leadRef.optional(),
          agent: userRef.optional().describe('Only meetings this team member hosts, ref from team_list'),
          from: z.iso.datetime({ offset: true }).optional(),
          to: z.iso.datetime({ offset: true }).optional(),
          includeCanceled: z.boolean().default(false),
          limit: z.number().int().min(1).max(50).default(20),
        })
        .strict(),
      async run({ auth, refs }, input) {
        const orgId = auth.organizationId;
        const [leadId, agentId] = await Promise.all([
          input.lead ? refs.resolve('lead', input.lead) : undefined,
          input.agent ? refs.resolve('user', input.agent) : undefined,
        ]);
        const now = Date.now();
        const rows = await deps.appointments.listInRange(orgId, {
          leadId,
          agentId,
          from: input.from ? new Date(input.from) : leadId ? undefined : new Date(now),
          to: input.to ? new Date(input.to) : leadId ? undefined : new Date(now + UPCOMING_DAYS * DAY_MS),
        });
        // A meeting shows when its lead is one the user may see, or when they host it.
        const leadIds = [...new Set(rows.map((r) => r.leadId))];
        const seen = new Set(
          (await prisma.lead.findMany({ where: { id: { in: leadIds }, ...visibleLeads(auth) }, select: { id: true } })).map((l) => l.id),
        );
        const shown = rows.filter((r) => (seen.has(r.leadId) || r.agentId === auth.userId) && (input.includeCanceled || r.status !== 'cancelled'));
        const page = shown.slice(0, input.limit);
        const [timezone, meetingRefs, leadRefs, agentRefs] = await Promise.all([
          officeTimezone(prisma, orgId),
          refs.issue('meeting', page.map((m) => m.id)),
          refs.issue('lead', page.map((m) => m.leadId)),
          refs.issue('user', page.flatMap((m) => (m.agentId ? [m.agentId] : []))),
        ]);
        return {
          timezone,
          total: shown.length,
          meetings: page.map((m) => ({
            ref: meetingRefs.get(m.id)!,
            lead: { ref: leadRefs.get(m.leadId)!, name: m.leadName },
            agent: m.agentId ? { ref: agentRefs.get(m.agentId)!, name: m.agentName } : null,
            title: m.appointmentType,
            when: spoken(new Date(m.startTime), timezone),
            start: m.startTime,
            end: m.endTime,
            status: m.status,
            joinLink: m.meetingUrl,
            ...(m.canceledReason ? { canceledReason: m.canceledReason } : {}),
          })),
        };
      },
    }),

    readTool({
      name: 'meeting_slots',
      label: 'Checking open times',
      description:
        "Open times on the office's booking calendar, as slot refs (T1, T2) to offer and then pass to meeting_book. Give a day for that day's times; a time picks the ones nearest to it.",
      permissions: [],
      input: z
        .object({
          day: z.string().trim().max(20).optional().describe('today, tomorrow, a weekday like friday, or YYYY-MM-DD. Leave out for the next open times'),
          time: z
            .string()
            .regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM')
            .optional()
            .describe('A preferred time that day, 24-hour HH:MM'),
          lead: leadRef.optional().describe('The lead the meeting is for, to show the times on their clock too'),
        })
        .strict(),
      async run({ auth, refs }, input) {
        const lead = input.lead ? await findVisibleLead(prisma, auth, refs, input.lead, { id: true, timezone: true, normalizedPhone: true }) : null;
        const ctx = await bookingContext(deps, auth, lead?.id ?? '');
        const result = await deps.booking.availability(ctx, { day: input.day, preferred_time: input.time });
        if (!result.ok) {
          if (result.reason === 'unknown_day') throw new AppError('VALIDATION_ERROR', 'That day was not understood. Use today, tomorrow, a weekday or YYYY-MM-DD.');
          throw new AppError('UPSTREAM_ERROR', 'The calendar could not be reached. Try again, or text the lead a booking link.');
        }
        const slots = await slotRefs(refs, result.slots, lead ? clockOf(lead) : null, result.timezone);
        const note =
          slots.length === 0
            ? 'Nothing is open in the next 7 days.'
            : input.day && result.say
              ? 'Nothing is open that day; these are the next open times.'
              : undefined;
        return {
          timezone: result.timezone,
          meetingType: `${ctx.config.eventTypeName} (${ctx.config.durationMinutes} min)`,
          ...(result.requestedTimeAvailable === null ? {} : { requestedTimeOpen: result.requestedTimeAvailable }),
          slots,
          ...(note ? { note } : {}),
        };
      },
    }),

    writeTool({
      name: 'meeting_book',
      label: 'Preparing the booking',
      description:
        "Book a meeting for a lead at an open time from meeting_slots. Calendly picks the agent (round robin), the lead is assigned to them and gets an email invite, and the lead's AI outreach ends.",
      permissions: [PERMISSIONS.LEAD_UPDATE],
      input: z.object({ lead: leadRef, slot: slotRef }).strict(),
      async preview({ auth, refs }, input) {
        const orgId = auth.organizationId;
        const lead = await findVisibleLead(prisma, auth, refs, input.lead, {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          timezone: true,
          normalizedPhone: true,
          updatedAt: true,
        });
        const [config, start, timezone] = await Promise.all([bookingConfig(deps, orgId), refs.resolve('slot', input.slot), officeTimezone(prisma, orgId)]);
        const at = new Date(start);
        if (at.getTime() < Date.now() + MIN_AHEAD_MS) throw new AppError('CONFLICT', 'That time has passed. Get fresh times with meeting_slots.');
        const name = leadName(lead);
        if (!lead.email) {
          throw new AppError('VALIDATION_ERROR', `${name} has no email address, and Calendly needs one for the invite. Add it with lead_update first.`);
        }
        // The helper is typed for the plain client; at run time this is still the guarded one.
        const existing = await nextMeeting(prisma as unknown as PrismaService, orgId, lead.id);
        if (existing) throw new AppError('CONFLICT', `${name} already has a meeting on ${spoken(existing.startsAt, timezone)}. One upcoming meeting per lead.`);

        const clock = clockOf(lead);
        return {
          title: `Book a meeting with ${name}`,
          changes: [
            { field: 'When', from: null, to: spoken(at, timezone) },
            ...(clock && clock !== timezone ? [{ field: "Lead's time", from: null, to: spoken(at, clock) }] : []),
            { field: 'Meeting', from: null, to: `${config.eventTypeName} (${config.durationMinutes} min)` },
            { field: 'Invite to', from: null, to: lead.email },
          ],
          summary: 'Calendly picks the agent (round robin) and the lead is assigned to them. AI outreach to the lead ends once it is booked.',
          entity: { type: 'lead', id: lead.id, version: lead.updatedAt },
        };
      },
      async run({ auth, refs }, input) {
        const [leadId, start] = await Promise.all([refs.resolve('lead', input.lead), refs.resolve('slot', input.slot)]);
        const ctx = await bookingContext(deps, auth, leadId);
        const result = await deps.booking.book(ctx, { start_time: start });
        if (result.ok) return { booked: true, when: result.spoken, agent: result.agentName };
        switch (result.reason) {
          case 'slot_taken': {
            const timezone = await officeTimezone(prisma, auth.organizationId);
            const open = await slotRefs(refs, 'slots' in result ? (result.slots ?? []) : [], null, timezone);
            const list = open.map((s) => `${s.time} (${s.ref})`).join('; ');
            throw new AppError('CONFLICT', `That time was just taken; nothing was booked.${list ? ` Open now: ${list}.` : ''}`);
          }
          case 'already_booked':
            throw new AppError('CONFLICT', 'This lead already has an upcoming meeting; nothing new was booked. See meeting_list.');
          case 'email_required':
          case 'email_invalid':
            throw new AppError('VALIDATION_ERROR', "The lead's email is missing or not valid, and Calendly needs it. Fix it with lead_update.");
          default:
            throw new AppError('UPSTREAM_ERROR', 'Calendly did not take the booking, so nothing was booked. Try again, or text the lead a booking link.');
        }
      },
    }),

    writeTool({
      name: 'booking_link_send',
      label: 'Preparing the booking link',
      description:
        "Text a lead a link to book a meeting on their agent's calendar. The lead's name and email are filled in, and the meeting is matched back to the lead.",
      permissions: [PERMISSIONS.LEAD_UPDATE],
      input: z
        .object({
          lead: leadRef,
          message: z.string().trim().max(400).optional().describe('Words before the link, as the user wants them. Leave out for a standard line'),
        })
        .strict(),
      async preview({ auth, refs }, input) {
        const { lead, agent, meetingType, text } = await bookingLink(auth, refs, input);
        return {
          title: `Text ${leadName(lead)} a booking link`,
          changes: [
            { field: 'To', from: null, to: lead.phone },
            { field: 'Message', from: null, to: text },
            { field: 'Books', from: null, to: `${meetingType.name} (${meetingType.durationMinutes} min) with ${agent}` },
          ],
          summary: textNotes(auth, lead),
          entity: { type: 'lead', id: lead.id, version: lead.updatedAt },
        };
      },
      async run({ auth, refs }, input) {
        const { lead, text } = await bookingLink(auth, refs, input);
        return sent(await sendLeadText(deps.text, auth, lead as TextLead, text), await refOf(refs, 'lead', lead.id));
      },
    }),
  ];
}

/** What the model hears back after a text went. */
export const sent = (result: { footerAdded: boolean }, lead: string) => ({
  sent: true,
  lead,
  ...(result.footerAdded ? { note: 'An opt-out line was added, as the rules ask for this text.' } : {}),
});
