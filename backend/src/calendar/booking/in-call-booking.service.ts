import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '@/audit/audit.service';
import { PrismaService } from '@/common/prisma/prisma.service';
import { isValidEmail } from '@/ingest/processing/transforms';
import { LeadAssignmentService } from '@/lead/lead-assignment.service';
import { fullName } from '@/lead/lead-scope';
import { EngineService } from '@/telnyx/engine.service';
import type { BookedMeeting } from '../calendar.types';
import { CalendarAccessService, type UsableConnection } from '../connection/calendar-access.service';
import { CalendlyClient, type CalendlyBookedEvent, type CalendlyEventTypeDetail } from '../providers/calendly.client';
import { ProviderHttpError } from '../providers/provider-http';
import { meetingRow } from '../sync/calendar-sync.service';
import { localDate, parseTime, pickSlots, resolveDay, searchWindow, spoken, zonedToUtc } from './booking-time';
import type { ToolContext } from './tool-auth.service';

/** Enough to choose from, few enough to say aloud. */
const MAX_SLOTS = 4;

export interface Slot {
  /** UTC ISO; what book_appointment must be sent back. */
  start: string;
  /** What the assistant reads to the caller, in the organization's timezone. */
  spoken: string;
}

/** Always a 200: `{ ok: false, reason, say }` is something the model can act on, a failed request is not. */
export type AvailabilityResult =
  | { ok: true; timezone: string; today: string; requestedTimeAvailable: boolean | null; slots: Slot[]; say?: string }
  | { ok: false; reason: string; say: string };

export type BookingResult =
  | { ok: true; booked: true; agentName: string | null; spoken: string; say: string }
  | { ok: false; reason: string; say: string; slots?: Slot[] };

/** Location kinds Calendly fills in itself, needing no answer from the caller. */
const SELF_SERVED_KINDS = new Set(['physical', 'custom', 'inbound_call']);

/**
 * The location to book with, from the event type's own settings: a
 * conferencing kind first (it produces a join link), else one Calendly fills
 * in itself. Kinds that need the caller's input are never chosen.
 */
export function inviteeLocation(locations: CalendlyEventTypeDetail['locations']): { kind: string; location?: string } | undefined {
  const list = locations ?? [];
  const pick = list.find((l) => l.kind.endsWith('_conference')) ?? list.find((l) => SELF_SERVED_KINDS.has(l.kind));
  if (!pick) return undefined;
  return pick.location && list.filter((l) => l.kind === pick.kind).length > 1
    ? { kind: pick.kind, location: pick.location }
    : { kind: pick.kind };
}

const UNAVAILABLE = {
  ok: false as const,
  reason: 'calendar_unavailable',
  say: 'Apologise that booking is unavailable right now, and say an agent will call them to schedule.',
};

/**
 * Booking a meeting during a live AI call on the organization's Calendly
 * round-robin event type. Calendly picks the host; the meeting is then
 * recorded on the lead straight away (the sync later finds the same row and
 * keeps its links), and the lead goes to that host when they are a teammate.
 */
@Injectable()
export class InCallBookingService {
  private readonly logger = new Logger(InCallBookingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CalendarAccessService,
    private readonly calendly: CalendlyClient,
    private readonly assignments: LeadAssignmentService,
    private readonly engine: EngineService,
    private readonly audit: AuditService,
  ) {}

  async availability(ctx: ToolContext, input: { day?: string; preferred_time?: string }, now = new Date()): Promise<AvailabilityResult> {
    const tz = await this.timezone(ctx.orgId);
    const day = resolveDay(input.day, now, tz);
    if (input.day?.trim() && !day) {
      return { ok: false, reason: 'unknown_day', say: 'Ask which day they mean, e.g. "tomorrow" or "Thursday".' };
    }
    const time = parseTime(input.preferred_time);
    const preferred = day && time ? zonedToUtc(day, time, tz) : null;

    try {
      return await this.withCalendly(ctx.orgId, async (_, token) => {
        let open = await this.openTimes(token, ctx, searchWindow(day, now, tz));
        let say: string | undefined;
        if (day && open.length === 0) {
          open = await this.openTimes(token, ctx, searchWindow(null, now, tz));
          say = 'Nothing is open that day. Offer these next openings instead.';
        }
        const slots = pickSlots(open, preferred, MAX_SLOTS).map((d) => ({ start: d.toISOString(), spoken: spoken(d, tz) }));
        if (slots.length === 0) say = 'Nothing is open in the next week. Tell the caller an agent will call them to find a time.';
        return {
          ok: true as const,
          timezone: tz,
          today: spoken(now, tz).replace(/ at .*$/, ''),
          requestedTimeAvailable: preferred ? open.some((d) => d.getTime() === preferred.getTime()) : null,
          slots,
          ...(say ? { say } : {}),
        };
      });
    } catch (error) {
      this.logger.warn(`in-call availability for lead ${ctx.leadId}: ${(error as Error).message}`);
      return UNAVAILABLE;
    }
  }

  async book(ctx: ToolContext, input: { start_time?: string; email?: string; name?: string }): Promise<BookingResult> {
    const start = new Date(input.start_time ?? '');
    if (!input.start_time || Number.isNaN(start.getTime())) {
      return { ok: false, reason: 'bad_start_time', say: 'Call check_availability and use a returned slot start.' };
    }
    const tz = await this.timezone(ctx.orgId);

    const lead = await this.prisma.lead.findFirst({
      where: { id: ctx.leadId, orgId: ctx.orgId },
      select: { firstName: true, lastName: true, email: true },
    });
    if (!lead) return { ok: false, reason: 'lead_not_found', say: 'Apologise; an agent will follow up to schedule.' };

    const given = input.email?.trim().toLowerCase();
    if (given && !isValidEmail(given)) {
      return { ok: false, reason: 'email_invalid', say: 'That email does not look right. Ask for it again and spell it back.' };
    }
    const email = given || lead.email?.trim().toLowerCase();
    if (!email) {
      return {
        ok: false,
        reason: 'email_required',
        say: 'Ask for their email address, spell it back to confirm, then call book_appointment again with email.',
      };
    }
    const name = fullName(lead.firstName, lead.lastName) || input.name?.trim() || 'Home buyer';

    let booked: { connection: UsableConnection; event: CalendlyBookedEvent | null; cancelUrl: string | null; rescheduleUrl: string | null };
    try {
      booked = await this.withCalendly(ctx.orgId, async (connection, token) => {
        const eventType = await this.calendly.eventType(token, ctx.config.eventTypeUri).catch((error) => {
          this.logger.warn(`reading event type ${ctx.config.eventTypeUri}: ${(error as Error).message}`);
          return null;
        });
        const location = inviteeLocation(eventType?.locations ?? null);
        const invitee = await this.calendly.createInvitee(token, {
          event_type: ctx.config.eventTypeUri,
          start_time: start.toISOString(),
          invitee: { name, email, timezone: tz },
          ...(location ? { location } : {}),
        });
        const event = await this.calendly.scheduledEvent(token, invitee.event).catch((error) => {
          this.logger.warn(`reading booked event ${invitee.event}: ${(error as Error).message}; the sync will attribute it`);
          return null;
        });
        return { connection, event, cancelUrl: invitee.cancel_url, rescheduleUrl: invitee.reschedule_url };
      });
    } catch (error) {
      if (error instanceof ProviderHttpError && error.status === 409) {
        const again = await this.availability(ctx, {
          day: localDate(start, tz),
          preferred_time: new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(start),
        });
        if (again.ok && !again.slots.some((s) => s.start === start.toISOString())) {
          return { ok: false, reason: 'slot_taken', say: 'That time was just taken. Offer these instead.', slots: again.slots };
        }
      }
      this.logger.error(`in-call booking for lead ${ctx.leadId} failed: ${(error as Error).message}`);
      return {
        ok: false,
        reason: 'booking_failed',
        say: 'Apologise that you could not book it right now, and say an agent will call them to confirm a time.',
      };
    }

    if (!lead.email && given) {
      await this.prisma.lead
        .update({ where: { id: ctx.leadId }, data: { email: given, normalizedEmail: given, emailValid: true } })
        .catch((error) => this.logger.warn(`saving email for lead ${ctx.leadId}: ${(error as Error).message}`));
    }

    const { event } = booked;
    const hosts = event?.event_memberships ?? [];
    const hostEmails = hosts.map((h) => h.user_email).filter((e): e is string => !!e);
    const users = hostEmails.length
      ? await this.prisma.user.findMany({
          where: { orgId: ctx.orgId, email: { in: hostEmails, mode: 'insensitive' } },
          select: { id: true, email: true, firstName: true, lastName: true },
        })
      : [];
    const host = hosts.find((h) => users.some((u) => u.email.toLowerCase() === h.user_email?.toLowerCase())) ?? hosts[0];
    const agent = users.find((u) => u.email.toLowerCase() === host?.user_email?.toLowerCase()) ?? null;
    const agentName = agent ? fullName(agent.firstName, agent.lastName, agent.email) : (host?.user_name ?? null);

    if (event) {
      try {
        await this.recordMeeting(ctx, booked.connection, event, { name, email, timezone: tz }, agent?.id ?? null, booked);
        await this.engine.appointmentBooked(ctx.orgId, ctx.leadId);
      } catch (error) {
        this.logger.error(`recording in-call booking for lead ${ctx.leadId}: ${(error as Error).message}`);
      }
      if (agent) await this.assign(ctx, agent.id, agentName ?? agent.email);
      else this.note(ctx, 'appointment.host_unlinked', { host: host?.user_email ?? null });
    }

    const when = spoken(start, tz);
    return {
      ok: true,
      booked: true,
      agentName,
      spoken: when,
      say: `Confirm it is booked for ${when}${agentName ? ` with ${agentName}` : ''}, and that a calendar invite is on its way by email.`,
    };
  }

  /** The host Calendly chose takes the lead, unless that would break their lead cap. */
  private async assign(ctx: ToolContext, userId: string, name: string): Promise<void> {
    try {
      await this.assignments.assign(ctx.orgId, ctx.leadId, userId, {
        actorType: 'ai',
        actorId: null,
        assignmentType: 'ai',
        reason: `Booked during the AI call; Calendly round robin chose ${name}`,
      });
    } catch (error) {
      const why = `Meeting booked with ${name} during the AI call, but the lead was not assigned: ${(error as Error).message}`;
      this.logger.warn(`lead ${ctx.leadId}: ${why}`);
      this.note(ctx, 'lead.assignment_skipped', { userId, reason: why });
    }
  }

  /** The same row the sync writes (same connection and external id), so it is never duplicated. */
  private async recordMeeting(
    ctx: ToolContext,
    connection: UsableConnection,
    event: CalendlyBookedEvent,
    invitee: { name: string; email: string; timezone: string },
    hostUserId: string | null,
    links: { cancelUrl: string | null; rescheduleUrl: string | null },
  ): Promise<void> {
    const meeting: BookedMeeting = {
      id: event.uri,
      eventTypeId: ctx.config.eventTypeUri,
      title: event.name || ctx.config.eventTypeName,
      start: event.start_time,
      end: event.end_time,
      timezone: null,
      status: 'scheduled',
      invitees: [invitee],
      hosts: event.event_memberships.map((h) => ({ name: h.user_name ?? h.user_email ?? 'Host', email: h.user_email ?? null, timezone: null })),
      meetingUrl: event.location?.join_url ?? null,
      location: event.location?.location ?? null,
      rescheduleUrl: links.rescheduleUrl,
      cancelUrl: links.cancelUrl,
      canceledReason: null,
    };
    const data = meetingRow(meeting, new Date());
    const linked = { leadId: ctx.leadId, ...(hostUserId ? { hostUserId } : {}) };
    await this.prisma.calendarMeeting.upsert({
      where: { connectionId_externalId: { connectionId: connection.id, externalId: data.externalId } },
      create: { orgId: ctx.orgId, connectionId: connection.id, ...data, ...linked, bookedVia: 'ai_call' },
      update: { ...data, ...linked, bookedVia: 'ai_call' },
    });
  }

  private async openTimes(token: string, ctx: ToolContext, window: { start: Date; end: Date } | null): Promise<Date[]> {
    if (!window) return [];
    return this.calendly.availableTimes(token, ctx.config.eventTypeUri, window.start, window.end);
  }

  private withCalendly<T>(orgId: string, run: (connection: UsableConnection, token: string) => Promise<T>): Promise<T> {
    return this.access.useActive(orgId, async (connection, token) => {
      if (connection.provider !== 'calendly') throw new Error('The connected calendar is not Calendly');
      return run(connection, token);
    });
  }

  private async timezone(orgId: string): Promise<string> {
    const settings = await this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { timezone: true } });
    return settings?.timezone || 'UTC';
  }

  private note(ctx: ToolContext, action: string, payload: Record<string, string | null>): void {
    this.audit.quietly({
      orgId: ctx.orgId,
      actorType: 'ai',
      action,
      entityType: 'lead',
      entityId: ctx.leadId,
      payload: { callId: ctx.callId, ...payload },
    });
  }
}
