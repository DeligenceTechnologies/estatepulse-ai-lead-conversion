import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { CalendarBlockKind, CalendarProvider } from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';
import { addDays, isTimeZone, localDate, zonedToInstant } from '@/common/utils/zoned-time';
import type { BusySource, MemberAvailabilitySource } from '../calendar.types';
import { findLinkedUsers } from '../members/linked-users';
import { readDateOverrides, readWeeklySchedule } from '../members/schedule-to-working-hours';
import type { CalendlySchedule } from '../providers/calendly.client';
import {
  CalendarSyncService,
  SYNC_HORIZON_DAYS,
  SYNC_STATUS_FIELDS,
  syncState,
  type SyncOutcome,
  type SyncState,
} from '../sync/calendar-sync.service';
import { MIN_FREE_MS, expandSchedule, freeTime, summarize, type AvailabilitySummary, type Busy } from './availability-math';
import type { AvailabilityQueryDto } from './dto/availability-query.dto';
import { clip, merge, type Interval } from './intervals';
import { inUse } from '../connection/connection-state';

const DEFAULT_TIMEZONE = 'UTC';
const HISTORY_VIEW_DAYS = 30;
/** The earliest and latest clocks on Earth, so a date is in range for whoever is viewing. */
const EARLIEST_ZONE = 'Etc/GMT+12';
const LATEST_ZONE = 'Etc/GMT-14';

const MEMBER_FIELDS = {
  id: true,
  externalId: true,
  name: true,
  email: true,
  timezone: true,
  schedule: true,
  scheduleTimezone: true,
  syncStatus: true,
  syncMessage: true,
} as const;

export interface AvailabilityDay {
  date: string;
  start: string;
  end: string;
}

export interface MemberAvailability extends MemberAvailabilitySource {
  externalId: string;
  name: string;
  email: string;
  /** The timezone this member's row is in: their calendar's. */
  timezone: string;
  /** The report's dates as this member's own days, midnight to midnight in `timezone`. */
  days: AvailabilityDay[];
  userId: string | null;
  userName: string | null;
  summary: AvailabilitySummary;
}

export interface AvailabilityReport {
  provider: CalendarProvider;
  generatedAt: string;
  /** The calendar dates shown; each member sees them in their own timezone. */
  dates: string[];
  range: { minDate: string; maxDate: string };
  members: MemberAvailability[];
  totalMembers: number;
  sync: SyncState;
}

interface StoredBlock {
  memberId: string;
  kind: CalendarBlockKind;
  startsAt: Date;
  endsAt: Date;
  blockedStartsAt: Date;
  blockedEndsAt: Date;
}

/**
 * Who is free and who is busy, from synced calendar blocks. Every member is
 * shown in their own calendar timezone: a date is their day, midnight to
 * midnight where they are.
 */
@Injectable()
export class CalendarAvailabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: CalendarSyncService,
  ) {}

  async report(orgId: string, query: AvailabilityQueryDto): Promise<AvailabilityReport> {
    const connection = await this.sync.freshConnection(orgId);
    const now = Date.now();
    const span = query.days ?? 1;
    const minDate = addDays(localDate(now, EARLIEST_ZONE), -HISTORY_VIEW_DAYS);
    const maxDate = addDays(localDate(now, LATEST_ZONE), SYNC_HORIZON_DAYS - span);

    const [members, organizationTimezone] = await Promise.all([
      this.prisma.calendarMember.findMany({
        where: { connectionId: connection.id },
        select: MEMBER_FIELDS,
        orderBy: { name: 'asc' },
      }),
      this.orgTimezone(orgId),
    ]);
    const date = query.date ?? localDate(now, organizationTimezone);
    if (date < minDate || date > maxDate) {
      throw new BadRequestException(`Pick a date between ${minDate} and ${maxDate}.`);
    }
    const dates = Array.from({ length: span }, (_, index) => addDays(date, index));

    const rows = members.map((member) => {
      const timezone = workingTimezone(member) ?? organizationTimezone;
      const days = dates.map((day) => ({
        date: day,
        start: zonedToInstant(day, 0, timezone),
        end: zonedToInstant(addDays(day, 1), 0, timezone),
      }));
      return { member, timezone, days, window: { start: days[0].start, end: days[days.length - 1].end } };
    });

    const blocks = rows.length
      ? await this.prisma.calendarTimeBlock.findMany({
          where: {
            connectionId: connection.id,
            startsAt: { lt: new Date(Math.max(...rows.map((row) => row.window.end))) },
            endsAt: { gt: new Date(Math.min(...rows.map((row) => row.window.start))) },
          },
          select: { memberId: true, kind: true, startsAt: true, endsAt: true, blockedStartsAt: true, blockedEndsAt: true },
          orderBy: { startsAt: 'asc' },
        })
      : [];
    const byMember = new Map<string, StoredBlock[]>();
    for (const block of blocks) {
      const list = byMember.get(block.memberId);
      if (list) list.push(block);
      else byMember.set(block.memberId, [block]);
    }
    const users = await findLinkedUsers(this.prisma, orgId, members);

    return {
      provider: connection.provider,
      generatedAt: new Date(now).toISOString(),
      dates,
      range: { minDate, maxDate },
      totalMembers: members.length,
      sync: syncState(connection),
      members: rows.map(({ member, timezone, days, window }) => {
        const own = (byMember.get(member.id) ?? []).filter(
          (block) => block.startsAt.getTime() < window.end && block.endsAt.getTime() > window.start,
        );
        const busy: (Busy & { source: BusySource })[] = own
          .filter((block) => block.kind !== 'free')
          .map((block) => ({
            start: block.startsAt.getTime(),
            end: block.endsAt.getTime(),
            blockedStart: block.blockedStartsAt.getTime(),
            blockedEnd: block.blockedEndsAt.getTime(),
            source: block.kind as BusySource,
          }));
        const upcoming: Interval = { start: Math.min(Math.max(window.start, now), window.end), end: window.end };

        const schedule = scheduleOf(member);
        const hours = schedule ? expandSchedule(schedule, window) : null;
        let free: Interval[];
        if (connection.provider === 'calendly') {
          free = hours ? freeTime(hours, busy, upcoming) : [];
        } else {
          // Cal.com's slots already apply the hours (shown for the key's owner only).
          const slots = own
            .filter((block) => block.kind === 'free')
            .map((block) => ({ start: block.startsAt.getTime(), end: block.endsAt.getTime() }));
          free = clip(merge(slots), upcoming).filter((interval) => interval.end - interval.start >= MIN_FREE_MS);
        }

        const user = users.get(member.email.toLowerCase());
        return {
          externalId: member.externalId,
          name: member.name,
          email: member.email,
          timezone,
          days: days.map(({ date: day, start, end }) => ({ date: day, ...toRange({ start, end }) })),
          userId: user?.id ?? null,
          userName: user?.name ?? null,
          hours: hours ? hours.map(toRange) : null,
          free: free.map(toRange),
          busy: busy.flatMap((entry) => clip([entry], window).map((interval) => ({ ...toRange(interval), source: entry.source }))),
          status: member.syncStatus,
          message: member.syncMessage,
          summary: summarize(free, busy, now),
        };
      }),
    };
  }

  async syncNow(orgId: string): Promise<{ outcome: SyncOutcome; sync: SyncState }> {
    const outcome = await this.sync.syncNow(orgId);
    const connection = await this.prisma.calendarConnection.findFirst({
      where: inUse(orgId),
      select: SYNC_STATUS_FIELDS,
    });
    if (!connection) throw new NotFoundException('No calendar is connected.');
    return { outcome, sync: syncState(connection) };
  }

  private async orgTimezone(orgId: string): Promise<string> {
    const settings = await this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { timezone: true } });
    return isTimeZone(settings?.timezone) ? settings.timezone : DEFAULT_TIMEZONE;
  }
}

interface ScheduledMember {
  timezone: string | null;
  schedule: unknown;
  scheduleTimezone: string | null;
}

/**
 * The timezone a member works in: their schedule's (Calendly keeps one per
 * schedule, and it can differ from the profile), else their profile's.
 */
export function workingTimezone(member: Omit<ScheduledMember, 'schedule'>): string | null {
  return [member.scheduleTimezone, member.timezone].find(isTimeZone) ?? null;
}

/** The saved working hours in the shape `expandSchedule` reads; null when there are none or no zone for them. */
export function scheduleOf(member: ScheduledMember): CalendlySchedule | null {
  const weekly = readWeeklySchedule(member.schedule);
  const timezone = workingTimezone(member);
  if (!weekly || !timezone) return null;
  return { timezone, weekly: weekly.weekly, dates: readDateOverrides((member.schedule as { dates?: unknown }).dates) };
}

function toRange({ start, end }: Interval) {
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}
