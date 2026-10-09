import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppError } from '../../../common/errors';
import { newId } from '../../../common/ids';
import { TENANT_PRISMA, type GuardedPrisma } from '../../../prisma/prisma.service';
import { EngineService } from '../../../telnyx/engine.service';
import { LeadAssignmentService } from '../../leads/lead-assignment.service';
import { isValidEmail } from '../../processing/transforms';
import { CalendarConnectionsService } from '../calendar-connections.service';
import { CalendlyClientService } from '../calendly.client';
import type { CalendlyCreateInviteeBody, CalendlyEventType, CalendlyScheduledEvent } from '../types';
import { localDate, parseTime, pickSlots, resolveDay, searchWindow, spoken, zonedToUtc } from './booking-time';
import type { ToolContext } from './tool-auth.service';

/** How many times to offer at once — enough to choose from, few enough to say aloud. */
const MAX_SLOTS = 4;

export interface Slot {
  /** UTC ISO; what book_appointment must be sent back. */
  start: string;
  /** What the AI reads to the caller, in the office's time zone. */
  spoken: string;
}

/**
 * Every answer is a 200 with `ok`, because a failed HTTP call is something the
 * model can only shrug at, while `{ok:false, reason, say}` is something it can
 * act on. `say` is guidance for the model, not a script.
 */
export type AvailabilityResult =
  | { ok: true; timezone: string; today: string; requestedTimeAvailable: boolean | null; slots: Slot[]; say?: string }
  | { ok: false; reason: string; say: string };

export type BookingResult =
  | { ok: true; booked: true; agentName: string | null; spoken: string; say: string }
  | { ok: false; reason: string; say: string; slots?: Slot[] };

/** Location kinds Calendly fills in itself — no answer needed from the caller. */
const SELF_SERVED_KINDS = new Set(['physical', 'custom', 'inbound_call']);

/**
 * The `location` to book with, from the event type's own settings.
 *
 * Calendly requires one whenever the event type has a location, and only a
 * conferencing kind (Zoom, Google Meet, Teams...) produces a join link, so that
 * is preferred. Kinds that need the caller's input (ask_invitee, outbound_call)
 * are not chosen. No locations: omitted, as Calendly requires.
 */
export function inviteeLocation(
  locations: CalendlyEventType['locations'],
): CalendlyCreateInviteeBody['location'] | undefined {
  const list = locations ?? [];
  const pick = list.find((l) => l.kind.endsWith('_conference')) ?? list.find((l) => SELF_SERVED_KINDS.has(l.kind));
  if (!pick) return undefined;
  // With several physical/custom places Calendly needs to be told which one.
  return pick.location && list.filter((l) => l.kind === pick.kind).length > 1
    ? { kind: pick.kind, location: pick.location }
    : { kind: pick.kind };
}

/**
 * Booking a meeting during a live AI call (Calendly round robin).
 *
 * The office's chosen round-robin event type decides who: Calendly offers the
 * pool's openings and assigns a host when the meeting is booked. We then make
 * that visible here straight away — the lead is assigned to that agent and the
 * appointment row is written — instead of waiting for the 5-minute sync, which
 * later finds the same row (same provider + event id) and only updates it.
 */
@Injectable()
export class InCallBookingService {
  private readonly logger = new Logger(InCallBookingService.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma,
    private readonly connections: CalendarConnectionsService,
    private readonly calendly: CalendlyClientService,
    private readonly assignments: LeadAssignmentService,
    private readonly engine: EngineService,
  ) {}

  async availability(
    ctx: ToolContext,
    input: { day?: string; preferred_time?: string },
    now = new Date(),
  ): Promise<AvailabilityResult> {
    const conn = await this.calendlyConnection(ctx.organizationId);
    if (!conn) return this.unavailable();
    const tz = await this.officeTimezone(ctx.organizationId);

    const day = resolveDay(input.day, now, tz);
    if (input.day?.trim() && !day) {
      return { ok: false, reason: 'unknown_day', say: 'Ask which day they mean, e.g. "tomorrow" or "Thursday".' };
    }
    const time = parseTime(input.preferred_time);
    const preferred = day && time ? zonedToUtc(day, time, tz) : null;

    let open = await this.openTimes(conn, ctx, searchWindow(day, now, tz));
    let say: string | undefined;
    // Nothing that day: offer the next openings instead of a dead end.
    if (day && open.length === 0) {
      open = await this.openTimes(conn, ctx, searchWindow(null, now, tz));
      say = 'Nothing is open that day. Offer these next openings instead.';
    }

    const slots = pickSlots(open, preferred, MAX_SLOTS).map((d) => ({ start: d.toISOString(), spoken: spoken(d, tz) }));
    if (slots.length === 0) {
      say = 'Nothing is open in the next week. Tell the caller an agent will call them to find a time.';
    }
    return {
      ok: true,
      timezone: tz,
      today: spoken(now, tz).replace(/ at .*$/, ''),
      requestedTimeAvailable: preferred ? open.some((d) => d.getTime() === preferred.getTime()) : null,
      slots,
      ...(say ? { say } : {}),
    };
  }

  async book(ctx: ToolContext, input: { start_time?: string; email?: string; name?: string }): Promise<BookingResult> {
    const conn = await this.calendlyConnection(ctx.organizationId);
    if (!conn) return this.unavailable();
    const tz = await this.officeTimezone(ctx.organizationId);

    const start = new Date(input.start_time ?? '');
    if (!input.start_time || Number.isNaN(start.getTime())) {
      return { ok: false, reason: 'bad_start_time', say: 'Call check_availability and use a returned slot start.' };
    }

    const lead = await this.prisma.leads.findFirst({
      where: { id: ctx.leadId, organization_id: ctx.organizationId },
      select: { first_name: true, last_name: true, email: true },
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
    const name = [lead.first_name, lead.last_name].filter(Boolean).join(' ').trim() || input.name?.trim() || 'Home buyer';

    // Read fresh each booking: the office can change the location in Calendly
    // at any time. If this read fails, book as before and let Calendly decide.
    const eventType = await this.calendly.getEventType(conn, ctx.config.eventTypeUri).catch((e) => {
      this.logger.warn(`reading event type ${ctx.config.eventTypeUri}: ${(e as Error).message}`);
      return null;
    });
    const location = inviteeLocation(eventType?.locations);

    let eventUri: string;
    let inviteeUri: string;
    let cancelUrl: string | null;
    let rescheduleUrl: string | null;
    try {
      const invitee = await this.calendly.createInvitee(conn, {
        event_type: ctx.config.eventTypeUri,
        start_time: start.toISOString(),
        invitee: { name, email, timezone: tz },
        ...(location ? { location } : {}),
        // No `tracking`: Calendly's Scheduling API rejects a tracking object
        // unless all six of its fields are present. It is not needed here —
        // this booking is recorded against the lead right below, and the sync
        // then finds that row by event id (or, failing that, by email).
      });
      ({ event: eventUri, uri: inviteeUri, cancel_url: cancelUrl, reschedule_url: rescheduleUrl } = invitee);
    } catch (e) {
      if (e instanceof AppError && e.code === 'CONFLICT') {
        // Re-read the day: if the time is gone it was taken; if it is still
        // open, Calendly refused for another reason (e.g. a required question).
        const again = await this.availability(ctx, {
          day: localDate(start, tz),
          preferred_time: new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(start),
        });
        const stillOpen = again.ok && again.slots.some((s) => s.start === start.toISOString());
        if (!stillOpen && again.ok) {
          return { ok: false, reason: 'slot_taken', say: 'That time was just taken. Offer these instead.', slots: again.slots };
        }
      }
      this.logger.error(`in-call booking for lead ${ctx.leadId} failed: ${(e as Error).message}`);
      return {
        ok: false,
        reason: 'booking_failed',
        say: 'Apologise that you could not book it right now, and say an agent will call them to confirm a time.',
      };
    }

    // Booked. Everything below makes it visible here; none of it may undo it.
    if (!lead.email && given) {
      await this.prisma.leads
        .update({ where: { id: ctx.leadId }, data: { email: given, normalized_email: given } })
        .catch((e) => this.logger.warn(`saving email for lead ${ctx.leadId}: ${(e as Error).message}`));
    }

    const event = await this.calendly.getScheduledEvent(conn, eventUri).catch((e) => {
      this.logger.warn(`reading booked event ${eventUri}: ${(e as Error).message} — the sync will attribute it`);
      return null;
    });
    // A round robin names one host; a multi-pool event can name several (a
    // fixed co-host plus the rotated one). The lead goes to the first host, in
    // Calendly's order, who is linked to an agent here.
    const hosts = event?.event_memberships ?? [];
    const linked = hosts.length
      ? await this.prisma.agent_profiles.findMany({
          where: { organization_id: ctx.organizationId, calendly_user_uri: { in: hosts.map((h) => h.user) } },
          select: { id: true, display_name: true, calendly_user_uri: true },
        })
      : [];
    const host = hosts.find((h) => linked.some((a) => a.calendly_user_uri === h.user)) ?? hosts[0];
    const agent = linked.find((a) => a.calendly_user_uri === host?.user) ?? null;

    if (event && agent) {
      try {
        await this.recordAppointment(ctx, conn.id, event, agent.id, { inviteeUri, name, email, cancelUrl, rescheduleUrl });
        await this.engine.appointmentBooked(ctx.organizationId, ctx.leadId);
        await this.assign(ctx, agent);
      } catch (e) {
        // The meeting IS booked in Calendly; the caller must hear that. The
        // 5-minute sync writes the appointment if this did not.
        this.logger.error(`recording in-call booking for lead ${ctx.leadId}: ${(e as Error).message}`);
      }
    } else if (event) {
      await this.audit(ctx, 'appointment.host_unlinked', {
        host: host?.user ?? null,
        reason: 'Booked during the AI call, but the Calendly host is not linked to an agent. Press Sync agents on Integrations.',
      });
    }

    const agentName = agent?.display_name ?? host?.user_name ?? null;
    return {
      ok: true,
      booked: true,
      agentName,
      spoken: spoken(start, tz),
      say:
        `Confirm it is booked for ${spoken(start, tz)}` +
        (agentName ? ` with ${agentName}` : '') +
        ', and that a calendar invite is on its way by email.',
    };
  }

  /** The agent Calendly chose takes the lead — unless that would break their lead cap. */
  private async assign(ctx: ToolContext, agent: { id: string; display_name: string }) {
    try {
      await this.assignments.assign(ctx.organizationId, null, ctx.leadId, agent.id, {
        actorType: 'ai',
        actorId: null,
        assignmentType: 'round_robin',
        reason: `Booked during the AI call; Calendly round robin chose ${agent.display_name}`,
      });
    } catch (e) {
      // The meeting stands, but the cap is never silently overridden: the lead
      // stays unassigned with a visible reason for the owner.
      const why = `Meeting booked with ${agent.display_name} during the AI call, but the lead was not assigned: ${(e as Error).message}`;
      this.logger.warn(`lead ${ctx.leadId}: ${why}`);
      await this.audit(ctx, 'lead.assignment_skipped', { agentId: agent.id, reason: why });
      await this.prisma.leads
        .update({ where: { id: ctx.leadId }, data: { ai_summary: why.slice(0, 2000) } })
        .catch(() => undefined);
    }
  }

  /** The same row the sync would write — same unique key — so it is never duplicated. */
  private async recordAppointment(
    ctx: ToolContext,
    connectionId: string,
    event: CalendlyScheduledEvent,
    agentId: string,
    invitee: { inviteeUri: string; name: string; email: string; cancelUrl: string | null; rescheduleUrl: string | null },
  ) {
    const externalEventId = (event.uri.split('/').filter(Boolean).pop() ?? event.uri).slice(0, 255);
    const shared = {
      status: 'scheduled',
      agent_id: agentId,
      start_at: new Date(event.start_time),
      end_at: new Date(event.end_time),
      meeting_url: event.location?.join_url ?? event.location?.location ?? null,
      metadata: {
        externalUpdatedAt: event.updated_at,
        eventTypeName: event.name ?? ctx.config.eventTypeName,
        inviteeUri: invitee.inviteeUri,
        inviteeName: invitee.name,
        inviteeEmail: invitee.email,
        cancelUrl: invitee.cancelUrl,
        rescheduleUrl: invitee.rescheduleUrl,
        canceledReason: null,
        bookedVia: 'ai_call',
      } as object,
      updated_at: new Date(),
    };
    await this.prisma.appointments.upsert({
      where: {
        organization_id_provider_external_event_id: {
          organization_id: ctx.organizationId,
          provider: 'calendly',
          external_event_id: externalEventId,
        },
      },
      create: {
        id: newId(),
        organization_id: ctx.organizationId,
        lead_id: ctx.leadId,
        calendar_connection_id: connectionId,
        provider: 'calendly',
        external_event_id: externalEventId,
        notes: null,
        ...shared,
      },
      update: shared,
    });
  }

  private async openTimes(
    conn: Awaited<ReturnType<InCallBookingService['calendlyConnection']>> & object,
    ctx: ToolContext,
    window: { start: Date; end: Date } | null,
  ): Promise<Date[]> {
    if (!window) return [];
    const res = await this.calendly.listAvailableTimes(conn, {
      eventTypeUri: ctx.config.eventTypeUri,
      start: window.start,
      end: window.end,
    });
    return res.collection.filter((t) => t.status === 'available').map((t) => new Date(t.start_time));
  }

  private async calendlyConnection(organizationId: string) {
    const conn = await this.connections.syncableOrgRow(organizationId);
    return conn?.provider === 'calendly' ? conn : null;
  }

  private async officeTimezone(organizationId: string): Promise<string> {
    const org = await this.prisma.organizations.findUnique({ where: { id: organizationId }, select: { timezone: true } });
    return org?.timezone || 'UTC';
  }

  private unavailable(): { ok: false; reason: string; say: string } {
    return {
      ok: false,
      reason: 'calendar_unavailable',
      say: 'Apologise that booking is unavailable right now, and say an agent will call them to schedule.',
    };
  }

  private async audit(ctx: ToolContext, action: string, payload: Record<string, unknown>) {
    await this.prisma.audit_logs
      .create({
        data: {
          id: newId(),
          organization_id: ctx.organizationId,
          actor_type: 'ai',
          actor_id: null,
          action,
          entity_type: 'lead',
          entity_id: ctx.leadId,
          payload: { callId: ctx.callId, ...payload } as never,
        },
      })
      .catch((e) => this.logger.warn(`audit ${action}: ${(e as Error).message}`));
  }
}
