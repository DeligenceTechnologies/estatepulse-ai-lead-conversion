import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { newId } from '../../common/ids';
import { TENANT_PRISMA, type GuardedPrisma } from '../../prisma/prisma.service';
import { EngineService } from '../../telnyx/engine.service';
import { isValidEmail } from '../processing/transforms';
import { CalendarConnectionsService } from './calendar-connections.service';
import { CalendarReauthRequired, type ConnectionRef } from './calendly.client';
import { CalendarProviderRegistry } from './providers/provider.registry';
import type { NormalizedAttendee, NormalizedBooking } from './providers/types';
import type { SyncResultDTO } from './types';
import { INACTIVE_STATUSES } from '../../common/domain';

/** Guard against a runaway window; 10 pages is 1000 bookings. */
const MAX_PAGES = 10;

/** The connection row shape this service needs. */
type SyncableConnection = ConnectionRef;

/**
 * Turns the office's scheduling bookings into `appointments` rows.
 *
 * Provider-neutral. Everything below works in the normalized shapes from
 * providers/types.ts, so Calendly's OAuth-and-URIs and Cal.com's key-and-
 * integers are both already behind it — and the rules that decide whose
 * appointment a booking becomes exist once, not twice.
 *
 * ONE connection covers the whole roster. Bookings are read at team scope, so a
 * single sweep sees every member's — including round-robin ones, which are
 * assigned to a host we would have no individual credential for and which a
 * per-agent sync could therefore never see at all.
 *
 * Two attributions have to succeed for a row to exist, and they fail
 * differently:
 *
 *  - The HOST. Every booking names its scheduling user, and that is matched to
 *    whichever of `agent_profiles.calendly_user_uri` / `cal_user_id` belongs to
 *    the connected provider. `appointments.agent_id` is NOT NULL, so a booking
 *    hosted by someone not on our roster is skipped — and counted separately,
 *    because that is a roster the owner can fix.
 *
 *  - The LEAD. `appointments.lead_id` is NOT NULL, and this feature never
 *    creates a lead: a calendar booking is not evidence that somebody entered
 *    the funnel. A booking whose attendee matches no existing lead is skipped
 *    rather than stored half-attributed.
 *
 * That also means this is not a mirror of the office's calendar, and the UI
 * says so. Showing a partial calendar labelled as a full one would be worse
 * than showing a partial calendar labelled as what it is.
 */
@Injectable()
export class CalendarSyncService {
  constructor(
    private readonly config: ConfigService,
    private readonly providers: CalendarProviderRegistry,
    private readonly connections: CalendarConnectionsService,
    private readonly engine: EngineService,
    @Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma,
  ) {}

  async syncConnection(conn: SyncableConnection): Promise<SyncResultDTO> {
    const result: SyncResultDTO = {
      scanned: 0,
      created: 0,
      updated: 0,
      skippedNoLead: 0,
      skippedNoAgent: 0,
    };

    const provider = this.providers.get(conn.provider);

    // Loaded once per sweep rather than per booking. A hundred bookings from a
    // five-person office would otherwise be a hundred identical lookups, and
    // the roster cannot change mid-pass in any way that matters here.
    const hosts = await this.hostIndex(conn.organization_id, conn.provider);

    try {
      const { minStart, maxStart } = this.window();
      let pageToken: string | null | undefined;
      let pages = 0;

      do {
        const page = await provider.listBookings(conn, { minStart, maxStart, pageToken });

        for (const booking of page.bookings) {
          await this.reconcile(conn, booking, hosts, result);
        }

        pageToken = page.nextPageToken;
        pages += 1;
      } while (pageToken && pages < MAX_PAGES);

      await this.connections.recordSyncSuccess(conn.id);
    } catch (err) {
      if (err instanceof CalendarReauthRequired) {
        // Terminal. Park it so the poller stops retrying a dead credential.
        await this.connections.markReauthRequired(conn.id, err);
      } else {
        await this.connections.recordSyncError(conn.id, String(err));
      }
      throw err;
    }

    return result;
  }

  /**
   * Which agent_profiles.id each scheduling user is, for this organization.
   *
   * Keyed by the provider's host id as a STRING, which is what normalization
   * guarantees: a Calendly URI and a Cal.com integer both arrive here as text,
   * and the column they came from is decided by the registry rather than by
   * this method knowing the difference.
   *
   * The id is the key, never the email: the roster service matched on email
   * once, when it created the link, and doing it again on every sweep would let
   * an address change quietly move a colleague's appointments.
   */
  private async hostIndex(
    organizationId: string,
    provider: string,
  ): Promise<Map<string, string>> {
    const column = this.providers.hostColumn(provider);
    const rows = await this.prisma.agent_profiles.findMany({
      where: { organization_id: organizationId, NOT: { [column]: null } },
      select: { id: true, calendly_user_uri: true, cal_user_id: true },
    });

    const index = new Map<string, string>();
    for (const row of rows) {
      const raw = column === 'cal_user_id' ? row.cal_user_id : row.calendly_user_uri;
      if (raw !== null && raw !== undefined) index.set(String(raw), row.id);
    }
    return index;
  }

  /**
   * The agent who hosted this booking, or null when the host is nobody we know.
   *
   * A round-robin booking has already had its rotation resolved by the time the
   * booking exists, so there is exactly one host and it is the answer. A
   * COLLECTIVE booking genuinely has several, and the first one we recognise is
   * taken — `appointments.agent_id` holds one agent, and picking the first
   * known host is at least stable across sweeps, which picking arbitrarily
   * would not be.
   */
  private hostOf(booking: NormalizedBooking, hosts: Map<string, string>): string | null {
    for (const hostId of booking.hostIds) {
      const agentId = hosts.get(hostId);
      if (agentId) return agentId;
    }
    return null;
  }

  /** One booking -> at most one appointments row. */
  private async reconcile(
    conn: SyncableConnection,
    booking: NormalizedBooking,
    hosts: Map<string, string>,
    result: SyncResultDTO,
  ): Promise<void> {
    result.scanned += 1;

    const externalEventId = booking.externalId.slice(0, 255);
    if (!externalEventId) return;

    const existing = await this.prisma.appointments.findFirst({
      where: {
        organization_id: conn.organization_id,
        provider: conn.provider,
        external_event_id: externalEventId,
      },
    });

    // The whole reason appointments.metadata exists: an attendee may be a
    // second HTTP call (it is on Calendly), and an unchanged booking does not
    // need one. Over a steady-state window this is 1 request instead of 41.
    const existingMeta = (existing?.metadata ?? {}) as Record<string, unknown>;
    if (existing && existingMeta.externalUpdatedAt === booking.externalUpdatedAt) return;

    // Before the attendee request, not after: a booking hosted by somebody who
    // is not on our roster can never become a row, so paying for a second call
    // to discover that would be waste on every single sweep.
    const agentId = this.hostOf(booking, hosts) ?? existing?.agent_id ?? null;
    if (!agentId) {
      result.skippedNoAgent += 1;
      return;
    }

    const attendee = booking.attendee ?? (await this.providers.get(conn.provider).fetchAttendee(conn, booking));
    if (!attendee) return;

    const leadId = existing?.lead_id ?? (await this.matchLead(conn.organization_id, attendee));
    if (!leadId) {
      // No lead, no row. Deliberately silent in the data, counted in the result
      // so "Sync now" can say how many were skipped and why.
      result.skippedNoLead += 1;
      return;
    }

    const status = this.statusFor(booking, attendee);
    const metadata = {
      externalUpdatedAt: booking.externalUpdatedAt,
      eventTypeName: booking.title,
      inviteeUri: attendee.externalId,
      inviteeName: attendee.name,
      inviteeEmail: attendee.email,
      cancelUrl: attendee.cancelUrl,
      rescheduleUrl: attendee.rescheduleUrl,
      canceledReason: booking.canceledReason,
    };

    const shared = {
      status,
      // Unlike lead_id, the host IS updated. A scheduling admin can reassign a
      // booking to another member, and a stale agent_id would leave the meeting
      // on the wrong person's day and out of the right person's.
      agent_id: agentId,
      start_at: new Date(booking.startsAt),
      end_at: new Date(booking.endsAt),
      meeting_url: booking.meetingUrl,
      metadata: metadata as object,
      updated_at: new Date(),
    };

    // `upsert` and `create` are not in the tenancy guard's GUARDED_OPS, so this
    // compound selector passes without an explicit organization_id predicate.
    // organization_id IS part of the key, so it is still tenant-correct; if
    // upsert is ever added to GUARDED_OPS, hasTenantPredicate must learn to
    // look inside compound selectors or this call starts throwing.
    await this.prisma.appointments.upsert({
      where: {
        organization_id_provider_external_event_id: {
          organization_id: conn.organization_id,
          provider: conn.provider,
          external_event_id: externalEventId,
        },
      },
      create: {
        id: newId(),
        organization_id: conn.organization_id,
        // Never in `update`: once an appointment is attributed to a person, a
        // later poll must not be able to move it to a different one.
        lead_id: leadId,
        calendar_connection_id: conn.id,
        provider: conn.provider,
        external_event_id: externalEventId,
        notes: null,
        ...shared,
      },
      update: shared,
    });

    if (existing) {
      result.updated += 1;
    } else {
      result.created += 1;
    }

    // Only on the transition INTO a live appointment. Re-running this on every
    // tick would re-stamp the lead's status forever, and firing it for a
    // cancellation would be plainly wrong.
    const becameLive = status === 'scheduled' && (!existing || existing.status !== 'scheduled');
    if (becameLive) {
      await this.engine.appointmentBooked(conn.organization_id, leadId);
    }
  }

  /**
   * The final status, in the vocabulary appointments_status_check permits
   * (scheduled | rescheduled | cancelled | completed | no_show).
   *
   * The one correction applied here is the reschedule. Cal.com settles it on
   * the booking and says 'rescheduled' outright; Calendly cannot know until the
   * invitee has been fetched, so it says 'cancelled' and flags the attendee.
   * Recording a move as a cancellation would read as a lost booking on a screen
   * where lost bookings matter, so one rule covers both.
   */
  private statusFor(booking: NormalizedBooking, attendee: NormalizedAttendee): string {
    if (booking.status === 'cancelled' && attendee.rescheduled) return 'rescheduled';
    return booking.status;
  }

  /**
   * Find an EXISTING lead for this attendee. Never creates one.
   *
   * Email first, then phone, both normalized the way the ingestion path
   * normalizes them (transforms.isValidEmail, then lowercase/trim; a phone is a
   * match key only when it is already E.164) so a lead created by a form and a
   * lead looked up here agree on what counts as the same person.
   *
   * Two leads can legitimately share an address — a couple buying together
   * often does. worker.service.ts argues at length that silently merging those
   * loses leads, so this picks the most recently updated non-terminal one and
   * leaves the ambiguity visible rather than resolving it invisibly.
   */
  private async matchLead(
    organizationId: string,
    attendee: NormalizedAttendee,
  ): Promise<string | null> {
    const email = attendee.email?.trim().toLowerCase();
    if (email && isValidEmail(email)) {
      const hit = await this.prisma.leads.findFirst({
        where: {
          organization_id: organizationId,
          normalized_email: email,
          status: { notIn: INACTIVE_STATUSES },
        },
        orderBy: { updated_at: 'desc' },
        select: { id: true },
      });
      if (hit) return hit.id;
    }

    const phone = attendee.phone?.trim();
    if (phone?.startsWith('+')) {
      const hit = await this.prisma.leads.findFirst({
        where: {
          organization_id: organizationId,
          normalized_phone: phone,
          status: { notIn: INACTIVE_STATUSES },
        },
        orderBy: { updated_at: 'desc' },
        select: { id: true },
      });
      if (hit) return hit.id;
    }

    return null;
  }

  /**
   * Neither provider is polled incrementally, so a bounded fixed window is the
   * only honest way to sweep. Bookings that fall out of the window are left
   * alone — a shrinking window is not evidence of a deletion.
   */
  private window(): { minStart: Date; maxStart: Date } {
    const past = this.config.get<number>('CALENDAR_WINDOW_PAST_DAYS') ?? 7;
    const future = this.config.get<number>('CALENDAR_WINDOW_FUTURE_DAYS') ?? 90;
    const day = 24 * 60 * 60 * 1000;
    return {
      minStart: new Date(Date.now() - past * day),
      maxStart: new Date(Date.now() + future * day),
    };
  }
}
