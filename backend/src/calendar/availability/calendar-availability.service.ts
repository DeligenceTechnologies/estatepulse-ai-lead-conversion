import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { CalendarBlockKind, CalendarProvider } from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';
import { addDays, localDate, zonedToInstant } from '@/common/utils/zoned-time';
import {
  PROVIDER_LABEL,
  type BusySource,
  type CalendarMemberView,
  type MemberAvailabilitySource,
  type WorkspaceRole,
} from '../calendar.types';
import type { AvailabilityQueryDto } from '../dto/availability-query.dto';
import type { CalendlySchedule } from '../providers/calendly.client';
import { CalendarSyncService, SYNC_HORIZON_DAYS, type SyncOutcome } from '../sync/calendar-sync.service';
import { MIN_FREE_MS, expandSchedule, freeTime, summarize, type AvailabilitySummary, type Busy } from './availability-math';
import { clip, merge, type Interval } from './intervals';

const DEFAULT_TIMEZONE = 'UTC';
const HISTORY_VIEW_DAYS = 30;

const CONNECTION_FIELDS = {
  id: true,
  provider: true,
  status: true,
  lastError: true,
  syncedAt: true,
  syncError: true,
  syncLeaseUntil: true,
} as const;

const MEMBER_FIELDS = {
  id: true,
  externalId: true,
  name: true,
  email: true,
  role: true,
  timezone: true,
  username: true,
  schedulingUrl: true,
  schedule: true,
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
  timezone: string | null;
  userId: string | null;
  userName: string | null;
  summary: AvailabilitySummary;
}

export interface SyncState {
  syncedAt: string | null;
  syncing: boolean;
  error: string | null;
}

export interface AvailabilityReport {
  provider: CalendarProvider;
  timezone: string;
  generatedAt: string;
  days: AvailabilityDay[];
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

@Injectable()
export class CalendarAvailabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: CalendarSyncService,
  ) {}

  async report(orgId: string, query: AvailabilityQueryDto): Promise<AvailabilityReport> {
    const connection = await this.freshConnection(orgId);
    const timezone = query.timezone ?? (await this.orgTimezone(orgId));
    const span = query.days ?? 1;
    const today = localDate(Date.now(), timezone);
    const minDate = addDays(today, -HISTORY_VIEW_DAYS);
    const maxDate = addDays(today, SYNC_HORIZON_DAYS - span);
    const date = query.date ?? today;
    if (date < minDate || date > maxDate) {
      throw new BadRequestException(`Pick a date between ${minDate} and ${maxDate}.`);
    }

    const days: AvailabilityDay[] = Array.from({ length: span }, (_, index) => {
      const day = addDays(date, index);
      return {
        date: day,
        start: new Date(zonedToInstant(day, 0, timezone)).toISOString(),
        end: new Date(zonedToInstant(addDays(day, 1), 0, timezone)).toISOString(),
      };
    });
    const window: Interval = { start: Date.parse(days[0].start), end: Date.parse(days[days.length - 1].end) };
    const now = Date.now();
    const upcoming: Interval = { start: Math.min(Math.max(window.start, now), window.end), end: window.end };

    const [members, blocks] = await Promise.all([
      this.prisma.calendarMember.findMany({
        where: { connectionId: connection.id },
        select: MEMBER_FIELDS,
        orderBy: { name: 'asc' },
      }),
      this.prisma.calendarTimeBlock.findMany({
        where: {
          connectionId: connection.id,
          startsAt: { lt: new Date(window.end) },
          endsAt: { gt: new Date(window.start) },
        },
        select: { memberId: true, kind: true, startsAt: true, endsAt: true, blockedStartsAt: true, blockedEndsAt: true },
        orderBy: { startsAt: 'asc' },
      }),
    ]);

    const byMember = new Map<string, StoredBlock[]>();
    for (const block of blocks) {
      const list = byMember.get(block.memberId);
      if (list) list.push(block);
      else byMember.set(block.memberId, [block]);
    }
    const users = await this.linkUsers(orgId, members);

    return {
      provider: connection.provider,
      timezone,
      generatedAt: new Date(now).toISOString(),
      days,
      range: { minDate, maxDate },
      totalMembers: members.length,
      sync: syncState(connection),
      members: members.map((member) => {
        const own = byMember.get(member.id) ?? [];
        const busy: (Busy & { source: BusySource })[] = own
          .filter((block) => block.kind !== 'free')
          .map((block) => ({
            start: block.startsAt.getTime(),
            end: block.endsAt.getTime(),
            blockedStart: block.blockedStartsAt.getTime(),
            blockedEnd: block.blockedEndsAt.getTime(),
            source: block.kind as BusySource,
          }));

        let hours: Interval[] | null = null;
        let free: Interval[];
        if (connection.provider === 'calendly') {
          hours = member.schedule ? expandSchedule(member.schedule as unknown as CalendlySchedule, window) : null;
          free = hours ? freeTime(hours, busy, upcoming) : [];
        } else {
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
          timezone: member.timezone,
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

  async members(orgId: string): Promise<CalendarMemberView[]> {
    const connection = await this.freshConnection(orgId);
    const members = await this.prisma.calendarMember.findMany({
      where: { connectionId: connection.id },
      select: MEMBER_FIELDS,
      orderBy: { name: 'asc' },
    });
    const users = await this.linkUsers(orgId, members);
    return members.map((member) => {
      const user = users.get(member.email.toLowerCase());
      return {
        externalId: member.externalId,
        name: member.name,
        email: member.email,
        role: member.role as WorkspaceRole,
        schedulingUrl: member.schedulingUrl,
        timezone: member.timezone,
        username: member.username,
        userId: user?.id ?? null,
        userName: user?.name ?? null,
      };
    });
  }

  async syncNow(orgId: string): Promise<{ outcome: SyncOutcome; sync: SyncState }> {
    const outcome = await this.sync.syncNow(orgId);
    const connection = await this.prisma.calendarConnection.findFirst({
      where: { orgId, isActive: true },
      select: CONNECTION_FIELDS,
    });
    if (!connection) throw new NotFoundException('No calendar is connected.');
    return { outcome, sync: syncState(connection) };
  }

  private async freshConnection(orgId: string) {
    const find = () =>
      this.prisma.calendarConnection.findFirst({ where: { orgId, isActive: true }, select: CONNECTION_FIELDS });
    const connection = await find();
    if (!connection) throw new NotFoundException('No calendar is connected.');
    if (connection.status === 'error') {
      throw new ConflictException(connection.lastError ?? `${PROVIDER_LABEL[connection.provider]} needs to be reconnected.`);
    }
    await this.sync.ensureFresh(connection);
    if (connection.syncedAt) return connection;
    const synced = await find();
    if (!synced) throw new NotFoundException('No calendar is connected.');
    return synced;
  }

  private async linkUsers(orgId: string, members: { email: string }[]) {
    const emails = members.map((member) => member.email).filter(Boolean);
    const users = emails.length
      ? await this.prisma.user.findMany({
          where: { orgId, email: { in: emails, mode: 'insensitive' } },
          select: { id: true, email: true, firstName: true, lastName: true },
        })
      : [];
    return new Map(
      users.map((user) => [user.email.toLowerCase(), { id: user.id, name: `${user.firstName} ${user.lastName}`.trim() }]),
    );
  }

  private async orgTimezone(orgId: string): Promise<string> {
    const settings = await this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { timezone: true } });
    return settings?.timezone ?? DEFAULT_TIMEZONE;
  }
}

function syncState(connection: { syncedAt: Date | null; syncError: string | null; syncLeaseUntil: Date | null }): SyncState {
  return {
    syncedAt: connection.syncedAt?.toISOString() ?? null,
    syncing: !connection.syncError && Boolean(connection.syncLeaseUntil && connection.syncLeaseUntil.getTime() > Date.now()),
    error: connection.syncError,
  };
}

function toRange({ start, end }: Interval) {
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}
