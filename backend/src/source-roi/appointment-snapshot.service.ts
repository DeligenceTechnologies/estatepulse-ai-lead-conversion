import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthContext } from '@/auth/auth.types';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { visibleLeads } from '@/lead/lead-scope';
import { LeadStateService } from '@/lead/lead-state.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Keeps lead_appointments, the lasting copy of each lead's meetings.
 *
 * calendar_meetings is a cache of the provider: rows are pruned 90 days after
 * they end and deleted outright when the calendar is disconnected. A report on
 * what a lead source produced must outlive both, so every lead's meeting is
 * copied here whenever it is written, and the "no-show" a person records lives
 * on the copy, where a re-sync never touches it.
 */
@Injectable()
export class AppointmentSnapshotService {
  private readonly logger = new Logger(AppointmentSnapshotService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly state: LeadStateService,
  ) {}

  /** Copies every lead meeting of a connection; called after the sync has written them. Never fails the sync. */
  async syncConnection(connectionId: string): Promise<void> {
    await this.copy(Prisma.sql`m.connection_id = ${connectionId}::uuid`).catch((error) =>
      this.logger.warn(`appointment snapshot for connection ${connectionId}: ${(error as Error).message}`),
    );
  }

  /** Copies one meeting; called after the AI booked it on a call or in a text. Never fails the booking. */
  async syncMeeting(connectionId: string, externalId: string): Promise<void> {
    await this.copy(Prisma.sql`m.connection_id = ${connectionId}::uuid AND m.external_id = ${externalId}`).catch((error) =>
      this.logger.warn(`appointment snapshot for meeting ${externalId}: ${(error as Error).message}`),
    );
  }

  /**
   * Called just before a calendar connection is deleted. Its meetings go with it, so nothing will
   * ever refresh their copies again: one still to come would stay "scheduled" for good and count
   * as held once its time passed, whatever really happened. Those are marked "disconnected"
   * (neither booked nor held in a report). Reconnecting the same calendar syncs them back to
   * their real status. Meetings that already ended keep what they had. Never fails the disconnect.
   */
  async releaseConnection(connectionId: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE lead_appointments a
         SET status = 'disconnected', updated_at = now()
        FROM calendar_meetings m
       WHERE m.connection_id = ${connectionId}::uuid
         AND a.meeting_id = m.id
         AND a.status IN ('scheduled', 'pending')
         AND a.ends_at > now()`.catch((error) =>
      this.logger.warn(`appointment snapshot release for connection ${connectionId}: ${(error as Error).message}`),
    );
  }

  /**
   * meeting id → when it was marked a no-show (null when it was not), for the meetings that have a copy.
   * Every appointment list reads this, Source ROI on or off, so it never fails one: if the marks
   * cannot be read (the table is not there yet on a server mid-deploy) the list simply has none.
   */
  async noShows(orgId: string, meetingIds: string[]): Promise<Map<string, Date | null>> {
    if (!meetingIds.length) return new Map();
    try {
      const rows = await this.prisma.leadAppointment.findMany({
        where: { orgId, meetingId: { in: meetingIds } },
        select: { meetingId: true, noShowAt: true },
      });
      return new Map(rows.map((row) => [row.meetingId!, row.noShowAt]));
    } catch (error) {
      this.logger.warn(`no-show marks for organization ${orgId}: ${(error as Error).message}`);
      return new Map();
    }
  }

  /**
   * Records that the lead did not show up, or takes that back. Only a meeting
   * that was due to happen can be a no-show: it is still scheduled and its
   * time has passed. A meeting on a lead the caller cannot see is NOT_FOUND.
   */
  async setNoShow(auth: AuthContext, meetingId: string, noShow: boolean): Promise<{ meetingId: string; noShowAt: string | null }> {
    const appointment = UUID.test(meetingId)
      ? await this.prisma.leadAppointment.findFirst({
          where: { orgId: auth.organizationId, meetingId, lead: visibleLeads(auth) },
          select: { id: true, leadId: true, status: true, endsAt: true, noShowAt: true },
        })
      : null;
    if (!appointment) throw new AppError('NOT_FOUND', 'No such appointment');

    if (noShow === (appointment.noShowAt !== null)) {
      return { meetingId, noShowAt: appointment.noShowAt?.toISOString() ?? null };
    }
    if (noShow) {
      if (appointment.status !== 'scheduled') {
        throw new AppError('CONFLICT', 'Only a scheduled appointment can be marked as a no-show.');
      }
      if (appointment.endsAt.getTime() > Date.now()) {
        throw new AppError('CONFLICT', 'This appointment has not ended yet.');
      }
    }

    const noShowAt = noShow ? new Date() : null;
    await this.prisma.$transaction(async (tx) => {
      await tx.leadAppointment.update({
        where: { id: appointment.id },
        data: { noShowAt, noShowById: noShow ? auth.userId : null },
      });
      await this.state.record(
        {
          orgId: auth.organizationId,
          leadId: appointment.leadId,
          type: noShow ? 'appointment_no_show' : 'appointment_no_show_cleared',
          source: 'agent',
          actor: { type: 'user', id: auth.userId },
          payload: { meetingId },
        },
        tx,
      );
    });
    return { meetingId, noShowAt: noShowAt?.toISOString() ?? null };
  }

  /**
   * One statement: insert the copies that are missing, refresh the ones that
   * exist. A re-sync never sets a no-show and keeps the one a person recorded,
   * unless the meeting moved to another time: the mark was about the old time,
   * so it is dropped with it. A copy that already matches is left alone: a
   * sync runs this for every meeting of the connection, every time.
   */
  private async copy(where: Prisma.Sql): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO lead_appointments (id, organization_id, lead_id, meeting_id, provider, external_id, status,
                                     starts_at, ends_at, booked_via, host_user_id, booked_at, created_at, updated_at)
      SELECT gen_random_uuid(), m.organization_id, m.lead_id, m.id, c.provider::text, m.external_id, m.status::text,
             m.starts_at, m.ends_at, m.booked_via, m.host_user_id, m.created_at, now(), now()
        FROM calendar_meetings m
        JOIN calendar_connections c ON c.id = m.connection_id
       WHERE m.lead_id IS NOT NULL AND ${where}
      ON CONFLICT (organization_id, provider, external_id) DO UPDATE
         SET lead_id = EXCLUDED.lead_id,
             meeting_id = EXCLUDED.meeting_id,
             status = EXCLUDED.status,
             starts_at = EXCLUDED.starts_at,
             ends_at = EXCLUDED.ends_at,
             booked_via = coalesce(EXCLUDED.booked_via, lead_appointments.booked_via),
             host_user_id = EXCLUDED.host_user_id,
             no_show_at = CASE WHEN lead_appointments.starts_at = EXCLUDED.starts_at THEN lead_appointments.no_show_at END,
             no_show_by_id = CASE WHEN lead_appointments.starts_at = EXCLUDED.starts_at THEN lead_appointments.no_show_by_id END,
             updated_at = now()
       WHERE (lead_appointments.lead_id, lead_appointments.meeting_id, lead_appointments.status,
              lead_appointments.starts_at, lead_appointments.ends_at, lead_appointments.host_user_id,
              lead_appointments.booked_via)
             IS DISTINCT FROM
             (EXCLUDED.lead_id, EXCLUDED.meeting_id, EXCLUDED.status,
              EXCLUDED.starts_at, EXCLUDED.ends_at, EXCLUDED.host_user_id,
              coalesce(EXCLUDED.booked_via, lead_appointments.booked_via))`;
  }
}
