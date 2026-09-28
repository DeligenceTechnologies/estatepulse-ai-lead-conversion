import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '../../common/errors';
import { newId } from '../../common/ids';
import { TENANT_PRISMA, type GuardedPrisma } from '../../prisma/prisma.service';
import type { PutAvailabilityBody } from './schemas';
import type { AvailabilityDTO, AvailabilityDayDTO } from './types';

/**
 * `agent_availability.start_time` / `end_time` are Postgres `time` columns, which
 * Prisma surfaces as JS Dates. The date part is meaningless; only the clock
 * reading matters, and it is WALL-CLOCK IN THE AGENT'S OWN TIMEZONE
 * (agent_profiles.timezone), not UTC and not the server's zone.
 *
 * Anchoring on the epoch in UTC keeps that unambiguous: nothing here ever
 * consults a local offset, so the value written is the value read back.
 */
const EPOCH_DATE = '1970-01-01';

function toTimeValue(hhmm: string): Date {
  return new Date(`${EPOCH_DATE}T${hhmm}:00.000Z`);
}

function fromTimeValue(value: Date): string {
  const h = String(value.getUTCHours()).padStart(2, '0');
  const m = String(value.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/** What an agent who has never touched the screen sees. Not persisted. */
function defaultWeek(): AvailabilityDayDTO[] {
  return Array.from({ length: 7 }, (_, dayOfWeek) => ({
    dayOfWeek,
    // Mon–Fri on, weekend off — a default that is obviously a default.
    isAvailable: dayOfWeek >= 1 && dayOfWeek <= 5,
    startTime: '09:00',
    endTime: '17:00',
  }));
}

@Injectable()
export class AvailabilityService {
  constructor(@Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma) {}

  async get(organizationId: string, agentId: string): Promise<AvailabilityDTO> {
    const [profile, rows] = await Promise.all([
      this.prisma.agent_profiles.findUnique({
        where: { id: agentId },
        select: { timezone: true },
      }),
      this.prisma.agent_availability.findMany({
        where: { organization_id: organizationId, agent_id: agentId },
        orderBy: { day_of_week: 'asc' },
      }),
    ]);

    if (!profile) throw new AppError('NOT_FOUND', 'No such agent');

    // No rows means "never configured", which is different from "unavailable
    // all week". Returning the default week makes the editor open on something
    // sensible; nothing is written until the agent saves.
    const days = rows.length
      ? rows.map((r) => ({
          dayOfWeek: r.day_of_week,
          isAvailable: r.is_available,
          startTime: fromTimeValue(r.start_time),
          endTime: fromTimeValue(r.end_time),
        }))
      : defaultWeek();

    return { timezone: profile.timezone, days };
  }

  /**
   * Replace the whole week in one transaction.
   *
   * Delete-then-insert rather than seven upserts: the unique key is
   * (agent_id, day_of_week), and a partial failure part-way through upserts
   * would leave a week that is neither the old one nor the new one.
   */
  async replace(
    organizationId: string,
    agentId: string,
    body: PutAvailabilityBody,
  ): Promise<AvailabilityDTO> {
    await this.prisma.$transaction(async (tx) => {
      await tx.agent_availability.deleteMany({
        where: { organization_id: organizationId, agent_id: agentId },
      });
      await tx.agent_availability.createMany({
        data: body.days.map((d) => ({
          id: newId(),
          organization_id: organizationId,
          agent_id: agentId,
          day_of_week: d.dayOfWeek,
          is_available: d.isAvailable,
          start_time: toTimeValue(d.startTime),
          end_time: toTimeValue(d.endTime),
        })),
      });
    });

    return this.get(organizationId, agentId);
  }
}
