import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma, type CalendarBlockKind, type CalendarMemberSyncStatus } from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';
import { isTimeZone } from '@/common/utils/zoned-time';
import { SecretBoxService } from '@/common/service/secret-box.service';
import type { IntegrationEnv } from '@/common/utils/interface';
import { mapLimit } from '@/common/utils/map-limit';
import { merge } from '../availability/intervals';
import { CalendarAccessService, type UsableConnection } from '../connection/calendar-access.service';
import { inUse } from '../connection/connection-state';
import { PROVIDER_LABEL, type BookedMeeting, type SchedulingMember } from '../calendar.types';
import { CalClient, type CalBookingWindow } from '../providers/cal.client';
import { CalendlyClient } from '../providers/calendly.client';
import { ProviderHttpError } from '../providers/provider-http';
import { SchedulingProvider } from '../providers/scheduling-provider';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const SYNC_INTERVAL_MS = 5 * MINUTE_MS;
const STALE_AFTER_MS = 10 * MINUTE_MS;
const LEASE_MS = 4 * MINUTE_MS;
const FAILURE_BACKOFF_MS = 2 * MINUTE_MS;
const MANUAL_COOLDOWN_MS = 30_000;
const WEBHOOK_RETRY_MS = DAY_MS;
const WEBHOOK_DEBOUNCE_MS = 5_000;
const WEBHOOK_BUSY_RETRY_MS = 30_000;
const SIGNATURE_TOLERANCE_MS = 5 * MINUTE_MS;
const CALENDLY_BUSY_SPAN_MS = 7 * DAY_MS;
const CONCURRENCY = 4;
const CRON_CONCURRENCY = 2;
const CRON_BATCH = 200;
/** Booked meetings cost a call per meeting (Calendly invitees), so routine syncs refresh them at most this often. */
const MEETINGS_TTL_MS = 15 * MINUTE_MS;

export const SYNC_HORIZON_DAYS = 14;
export const HISTORY_DAYS = 90;
/** Booked meetings kept in sync: two weeks back covers "Last week", a month ahead covers upcoming. */
export const MEETINGS_PAST_DAYS = 14;
export const MEETINGS_AHEAD_DAYS = 30;

/** 'now' also refreshes booked meetings (a webhook, Sync now); 'due' only when they are older than the TTL. */
export type MeetingsRefresh = 'due' | 'now';

export type SyncOutcome = 'synced' | 'busy' | 'skipped';

/** The columns that say which connection is active and how fresh its synced data is. */
export const SYNC_STATUS_FIELDS = {
  id: true,
  provider: true,
  status: true,
  lastError: true,
  syncedAt: true,
  syncError: true,
  syncLeaseUntil: true,
  meetingsSyncedAt: true,
  meetingsError: true,
} as const satisfies Prisma.CalendarConnectionSelect;

export type SyncedConnection = Prisma.CalendarConnectionGetPayload<{ select: typeof SYNC_STATUS_FIELDS }>;

export interface SyncState {
  syncedAt: string | null;
  syncing: boolean;
  error: string | null;
}

export function syncState(connection: Pick<SyncedConnection, 'syncedAt' | 'syncError' | 'syncLeaseUntil'>): SyncState {
  return {
    syncedAt: connection.syncedAt?.toISOString() ?? null,
    syncing: !connection.syncError && Boolean(connection.syncLeaseUntil && connection.syncLeaseUntil.getTime() > Date.now()),
    error: connection.syncError,
  };
}

interface SyncedMember {
  id: string;
  externalId: string;
  name: string;
  username: string | null;
}

interface MemberPull {
  blocks: { kind: CalendarBlockKind; start: number; end: number; blockedStart?: number; blockedEnd?: number }[];
  schedule?: SavedSchedule;
  status: CalendarMemberSyncStatus;
  message: string | null;
}

/** Working hours as saved: wall-clock `{ weekly, dates }` and the timezone they are in. */
interface SavedSchedule {
  hours: Prisma.InputJsonValue | null;
  timezone: string | null;
}

interface Window {
  from: number;
  until: number;
}

@Injectable()
export class CalendarSyncService implements OnModuleDestroy {
  private readonly logger = new Logger(CalendarSyncService.name);
  private readonly webhookBase?: string;
  private readonly pending = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretBoxService,
    private readonly access: CalendarAccessService,
    private readonly provider: SchedulingProvider,
    private readonly calendly: CalendlyClient,
    private readonly cal: CalClient,
    config: ConfigService<IntegrationEnv, true>,
  ) {
    this.webhookBase = config.get('CALENDAR_WEBHOOK_BASE_URL', { infer: true })?.replace(/\/+$/, '');
  }

  onModuleDestroy(): void {
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'calendar-availability-sync' })
  async syncDue(): Promise<void> {
    const due = await this.prisma.calendarConnection.findMany({
      where: {
        status: 'active',
        OR: [{ syncedAt: null }, { syncedAt: { lt: new Date(Date.now() - SYNC_INTERVAL_MS + 30_000) } }],
      },
      select: { id: true },
      orderBy: { syncedAt: { sort: 'asc', nulls: 'first' } },
      take: CRON_BATCH,
    });
    await mapLimit(due, CRON_CONCURRENCY, ({ id }) => this.sync(id).catch(() => undefined));
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'calendar-availability-prune' })
  async prune(): Promise<void> {
    const before = new Date(Date.now() - HISTORY_DAYS * DAY_MS);
    const [blocks, meetings] = await Promise.all([
      this.prisma.calendarTimeBlock.deleteMany({ where: { endsAt: { lt: before } } }),
      this.prisma.calendarMeeting.deleteMany({ where: { endsAt: { lt: before } } }),
    ]);
    if (blocks.count || meetings.count) {
      this.logger.log(`Pruned ${blocks.count} calendar blocks and ${meetings.count} meetings older than ${HISTORY_DAYS} days.`);
    }
  }

  /**
   * The organization's active, working connection, with its synced data
   * guaranteed to exist: the first read waits for a sync, later reads refresh
   * stale data in the background. Every screen that reads synced members or
   * availability starts here.
   */
  async freshConnection(orgId: string): Promise<SyncedConnection> {
    const find = () =>
      this.prisma.calendarConnection.findFirst({ where: inUse(orgId), select: SYNC_STATUS_FIELDS });
    const connection = await find();
    if (!connection) throw new NotFoundException('No calendar is connected.');
    if (connection.status === 'error') {
      throw new ConflictException(connection.lastError ?? `${PROVIDER_LABEL[connection.provider]} needs to be reconnected.`);
    }
    await this.ensureFresh(connection);
    if (connection.syncedAt) return connection;
    const synced = await find();
    if (!synced) throw new NotFoundException('No calendar is connected.');
    return synced;
  }

  async ensureFresh(connection: { id: string; syncedAt: Date | null }): Promise<void> {
    if (!connection.syncedAt) {
      await this.sync(connection.id);
      return;
    }
    if (Date.now() - connection.syncedAt.getTime() > STALE_AFTER_MS) {
      void this.sync(connection.id).catch(() => undefined);
    }
  }

  async syncNow(orgId: string): Promise<SyncOutcome> {
    const connection = await this.prisma.calendarConnection.findFirst({
      where: inUse(orgId),
      select: { id: true, syncedAt: true },
    });
    if (!connection) throw new NotFoundException('No calendar is connected.');
    if (connection.syncedAt && Date.now() - connection.syncedAt.getTime() < MANUAL_COOLDOWN_MS) return 'skipped';
    return this.sync(connection.id, 'now');
  }

  async receiveWebhook(connectionId: string, headers: Record<string, string | string[] | undefined>, body: Buffer | undefined) {
    const connection = await this.prisma.calendarConnection.findUnique({
      where: { id: connectionId },
      select: { provider: true, status: true, webhookSecret: true },
    });
    // A switched-off connection is not synced, so it accepts no webhooks either.
    if (!connection || connection.status === 'inactive') throw new NotFoundException();
    const secret = connection.webhookSecret && this.secrets.enabled ? this.openSecret(connection.webhookSecret) : null;
    if (!secret) throw new NotFoundException();
    if (!body || !this.verifySignature(connection.provider, secret, headers, body)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }
    this.requestSync(connectionId);
    return { received: true };
  }

  async sync(connectionId: string, meetings: MeetingsRefresh = 'due'): Promise<SyncOutcome> {
    const now = new Date();
    const lease = await this.prisma.calendarConnection.updateMany({
      where: {
        id: connectionId,
        status: 'active',
        OR: [{ syncLeaseUntil: null }, { syncLeaseUntil: { lt: now } }],
      },
      data: { syncLeaseUntil: new Date(now.getTime() + LEASE_MS) },
    });
    if (lease.count === 0) return 'busy';

    let retryAfter: Date | null = null;
    try {
      const { orgId } = await this.prisma.calendarConnection.findUniqueOrThrow({
        where: { id: connectionId },
        select: { orgId: true },
      });
      await this.access.useActive(orgId, async (connection, secret) => {
        if (connection.id !== connectionId) return;
        await this.pull(connection, secret);
        await this.pullMeetings(connection, secret, meetings);
        await this.ensureWebhook(connection, secret);
      });
      await this.prisma.calendarConnection.updateMany({
        where: { id: connectionId },
        data: { syncedAt: new Date(), syncError: null },
      });
      return 'synced';
    } catch (error) {
      const message =
        error instanceof HttpException ? error.message : 'The calendar could not be synced. It will be retried shortly.';
      if (!(error instanceof HttpException)) {
        this.logger.error(`Calendar sync failed for ${connectionId}`, error instanceof Error ? error.stack : String(error));
      } else {
        this.logger.warn(`Calendar sync failed for ${connectionId}: ${message}`);
      }
      retryAfter = new Date(Date.now() + FAILURE_BACKOFF_MS);
      await this.prisma.calendarConnection.updateMany({
        where: { id: connectionId },
        data: { syncError: message.slice(0, 500) },
      });
      throw error;
    } finally {
      await this.prisma.calendarConnection.updateMany({
        where: { id: connectionId },
        data: { syncLeaseUntil: retryAfter },
      });
    }
  }

  private requestSync(connectionId: string, attempt = 0): void {
    clearTimeout(this.pending.get(connectionId));
    const timer = setTimeout(
      () => {
        this.pending.delete(connectionId);
        // A webhook means a booking changed, so its meetings are read now.
        this.sync(connectionId, 'now')
          .then((outcome) => {
            if (outcome === 'busy' && attempt < 3) this.requestSync(connectionId, attempt + 1);
          })
          .catch(() => undefined);
      },
      attempt === 0 ? WEBHOOK_DEBOUNCE_MS : WEBHOOK_BUSY_RETRY_MS,
    );
    timer.unref();
    this.pending.set(connectionId, timer);
  }

  private async pull(connection: UsableConnection, secret: string): Promise<void> {
    const from = (Math.floor(Date.now() / MINUTE_MS) + 1) * MINUTE_MS;
    const window: Window = { from, until: from + SYNC_HORIZON_DAYS * DAY_MS };
    const members = await this.saveMembers(connection, await this.provider.members(connection, secret));
    const label = PROVIDER_LABEL[connection.provider];

    let bookings: CalBookingWindow[] = [];
    if (connection.provider === 'cal') {
      bookings = await this.cal.bookings(
        secret,
        new Date(window.from - DAY_MS),
        new Date(window.until),
        connection.workspaceType === 'personal' ? null : connection.workspaceId,
      );
    }

    await mapLimit(members, CONCURRENCY, async (member) => {
      let result: MemberPull;
      try {
        result =
          connection.provider === 'calendly'
            ? await this.pullCalendly(secret, member, window)
            : await this.pullCal(secret, connection, member, window, bookings);
      } catch (error) {
        if (!(error instanceof ProviderHttpError) || error.credentialRejected) throw error;
        this.logger.warn(`${label} availability for member ${member.externalId} failed: ${error.message} (HTTP ${error.status})`);
        await this.prisma.calendarMember.update({
          where: { id: member.id },
          data: { syncStatus: 'unavailable', syncMessage: memberError(label, member.name, error.status), syncedAt: new Date() },
        });
        return;
      }
      await this.saveBlocks(connection, member, window, result);
    });
  }

  /**
   * Saves the booked meetings from two weeks back to a month ahead. Best
   * effort: when they cannot be read the saved ones stay and the error is
   * kept for the page to show; only a rejected credential fails the sync.
   * Meetings are never deleted here, as both providers keep a canceled one
   * (with its status); they age out with `prune`.
   */
  private async pullMeetings(connection: UsableConnection, secret: string, refresh: MeetingsRefresh): Promise<void> {
    if (refresh === 'due') {
      const state = await this.prisma.calendarConnection.findUnique({
        where: { id: connection.id },
        select: { meetingsSyncedAt: true },
      });
      if (state?.meetingsSyncedAt && Date.now() - state.meetingsSyncedAt.getTime() < MEETINGS_TTL_MS) return;
    }

    const now = Date.now();
    let meetings: BookedMeeting[];
    try {
      meetings = await this.provider.meetings(
        connection,
        secret,
        new Date(now - MEETINGS_PAST_DAYS * DAY_MS),
        new Date(now + MEETINGS_AHEAD_DAYS * DAY_MS),
      );
    } catch (error) {
      if (error instanceof ProviderHttpError && error.credentialRejected) throw error;
      const message = (error as Error).message;
      this.logger.warn(`${PROVIDER_LABEL[connection.provider]} meetings for connection ${connection.id} unavailable: ${message}`);
      await this.prisma.calendarConnection.updateMany({
        where: { id: connection.id },
        data: { meetingsError: message.slice(0, 500) },
      });
      return;
    }

    const syncedAt = new Date();
    const zones = await this.memberZones(connection.id);
    const unique = [...new Map(meetings.map((meeting) => [meeting.id, withHostZones(meeting, zones)])).values()].filter(
      validMeeting,
    );
    for (let index = 0; index < unique.length; index += MEETING_WRITE_BATCH) {
      await this.prisma.$transaction(
        unique.slice(index, index + MEETING_WRITE_BATCH).map((meeting) => {
          const data = meetingRow(meeting, syncedAt);
          return this.prisma.calendarMeeting.upsert({
            where: { connectionId_externalId: { connectionId: connection.id, externalId: data.externalId } },
            create: { orgId: connection.orgId, connectionId: connection.id, ...data },
            update: data,
          });
        }),
      );
    }
    await this.prisma.calendarConnection.updateMany({
      where: { id: connection.id },
      data: { meetingsSyncedAt: syncedAt, meetingsError: null },
    });
  }

  /** Each calendar member's working timezone by email, for hosts the provider gives no timezone for. */
  private async memberZones(connectionId: string): Promise<Map<string, string>> {
    const members = await this.prisma.calendarMember.findMany({
      where: { connectionId },
      select: { email: true, timezone: true, scheduleTimezone: true },
    });
    const zones = new Map<string, string>();
    for (const member of members) {
      const zone = [member.scheduleTimezone, member.timezone].find(isTimeZone);
      if (zone && member.email) zones.set(member.email.toLowerCase(), zone);
    }
    return zones;
  }

  private async pullCalendly(token: string, member: SyncedMember, window: Window): Promise<MemberPull> {
    const spans: Window[] = [];
    for (let start = window.from; start < window.until; start += CALENDLY_BUSY_SPAN_MS) {
      spans.push({ from: start, until: Math.min(start + CALENDLY_BUSY_SPAN_MS, window.until) });
    }

    const [schedule, ...busy] = await Promise.all([
      this.readSchedule('Calendly', member, () => this.calendly.defaultSchedule(token, member.externalId)),
      ...spans.map((span) => this.calendly.busyTimes(token, member.externalId, new Date(span.from), new Date(span.until))),
    ]);

    const current =
      schedule !== undefined
        ? schedule.hours
        : (
            await this.prisma.calendarMember.findUnique({ where: { id: member.id }, select: { schedule: true } })
          )?.schedule;

    return {
      blocks: dedupe(busy.flat()).map((entry) => ({
        kind: entry.source,
        start: entry.start,
        end: entry.end,
        blockedStart: entry.blockedStart,
        blockedEnd: entry.blockedEnd,
      })),
      ...(schedule !== undefined ? { schedule } : {}),
      status: current ? 'ok' : 'limited',
      message: current ? null : `${member.name} has no working hours set in Calendly.`,
    };
  }

  private async pullCal(
    apiKey: string,
    connection: UsableConnection,
    member: SyncedMember,
    window: Window,
    bookings: CalBookingWindow[],
  ): Promise<MemberPull> {
    const own =
      connection.workspaceType === 'personal'
        ? bookings
        : bookings.filter((booking) => booking.hostIds.includes(member.externalId));
    const busy = merge(own).map(({ start, end }) => ({ kind: 'booking' as const, start, end }));
    const schedule =
      member.externalId === connection.accountId
        ? await this.readSchedule('Cal.com', member, () => this.cal.defaultSchedule(apiKey))
        : undefined;

    if (!member.username) {
      return {
        blocks: busy,
        ...(schedule !== undefined ? { schedule } : {}),
        status: 'limited',
        message: `${member.name} has no Cal.com username, so free time cannot be read.`,
      };
    }
    const eventType = await this.cal.shortestEventType(apiKey, member.username);
    if (!eventType) {
      return {
        blocks: busy,
        ...(schedule !== undefined ? { schedule } : {}),
        status: 'limited',
        message: `${member.name} has no public meeting type in Cal.com, so free time cannot be read.`,
      };
    }
    const slots = await this.cal.slots(apiKey, eventType.id, new Date(window.from), new Date(window.until));
    const free = merge(slots).map(({ start, end }) => ({ kind: 'free' as const, start, end }));
    return { blocks: [...free, ...busy], ...(schedule !== undefined ? { schedule } : {}), status: 'ok', message: null };
  }

  /**
   * The member's working hours, read on every sync so a change in the calendar
   * shows on the next one (neither provider sends a webhook for it). Cal.com
   * shows a schedule only to its owner, so there only the API key's own member
   * has one, and it is display only (Cal.com slots already account for it).
   * Best effort: when it cannot be read the stored hours stay (undefined), and
   * only a rejected credential fails the sync.
   */
  private async readSchedule(
    label: string,
    member: SyncedMember,
    read: () => Promise<{ timezone: string | null } | null>,
  ): Promise<SavedSchedule | undefined> {
    try {
      const schedule = await read();
      if (!schedule) return { hours: null, timezone: null };
      const { timezone, ...hours } = schedule;
      return { hours: hours as Prisma.InputJsonValue, timezone: isTimeZone(timezone) ? timezone : null };
    } catch (error) {
      if (error instanceof ProviderHttpError && error.credentialRejected) throw error;
      this.logger.warn(`${label} schedule for member ${member.externalId} unavailable, keeping the last one: ${(error as Error).message}`);
      return undefined;
    }
  }

  private async saveMembers(connection: UsableConnection, members: SchedulingMember[]): Promise<SyncedMember[]> {
    const unique = [...new Map(members.map((member) => [member.externalId, member])).values()];
    return this.prisma.$transaction(async (tx) => {
      await tx.calendarMember.deleteMany({
        where: { connectionId: connection.id, externalId: { notIn: unique.map((member) => member.externalId) } },
      });
      for (const member of unique) {
        const profile = {
          name: member.name.slice(0, 255),
          email: member.email.slice(0, 255),
          role: member.role,
          timezone: member.timezone?.slice(0, 100) ?? null,
          username: member.username?.slice(0, 255) ?? null,
          schedulingUrl: member.schedulingUrl?.slice(0, 500) ?? null,
        };
        await tx.calendarMember.upsert({
          where: { connectionId_externalId: { connectionId: connection.id, externalId: member.externalId } },
          create: { orgId: connection.orgId, connectionId: connection.id, externalId: member.externalId, ...profile },
          update: profile,
        });
      }
      return tx.calendarMember.findMany({
        where: { connectionId: connection.id },
        select: { id: true, externalId: true, name: true, username: true },
      });
    });
  }

  private async saveBlocks(connection: UsableConnection, member: SyncedMember, window: Window, pull: MemberPull): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.calendarTimeBlock.deleteMany({ where: { memberId: member.id, endsAt: { gt: new Date(window.from) } } }),
      this.prisma.calendarTimeBlock.createMany({
        data: pull.blocks
          .filter((block) => block.end > block.start)
          .map((block) => ({
            orgId: connection.orgId,
            connectionId: connection.id,
            memberId: member.id,
            kind: block.kind,
            startsAt: new Date(block.start),
            endsAt: new Date(block.end),
            blockedStartsAt: new Date(block.blockedStart ?? block.start),
            blockedEndsAt: new Date(block.blockedEnd ?? block.end),
          })),
      }),
      this.prisma.calendarMember.update({
        where: { id: member.id },
        data: {
          syncStatus: pull.status,
          syncMessage: pull.message,
          syncedAt: now,
          ...(pull.schedule !== undefined
            ? {
                schedule: pull.schedule.hours ?? Prisma.DbNull,
                scheduleTimezone: pull.schedule.timezone,
                scheduleSyncedAt: now,
              }
            : {}),
        },
      }),
    ]);
  }

  private async ensureWebhook(connection: UsableConnection, secret: string): Promise<void> {
    if (!this.webhookBase || connection.webhookId || !this.secrets.enabled) return;
    const state = await this.prisma.calendarConnection.findUnique({
      where: { id: connection.id },
      select: { webhookAttemptAt: true },
    });
    if (state?.webhookAttemptAt && Date.now() - state.webhookAttemptAt.getTime() < WEBHOOK_RETRY_MS) return;
    await this.prisma.calendarConnection.updateMany({ where: { id: connection.id }, data: { webhookAttemptAt: new Date() } });

    const signingKey = randomBytes(32).toString('base64url');
    const url = `${this.webhookBase}/calendar-webhooks/${connection.id}`;
    try {
      const webhookId =
        connection.provider === 'calendly'
          ? await this.calendly.createWebhook(secret, connection.workspaceId, url, signingKey)
          : await this.cal.createWebhook(secret, url, signingKey);
      await this.prisma.calendarConnection.updateMany({
        where: { id: connection.id },
        data: { webhookId: webhookId.slice(0, 500), webhookSecret: this.secrets.seal(signingKey) },
      });
      this.logger.log(`${PROVIDER_LABEL[connection.provider]} webhook registered for connection ${connection.id}.`);
    } catch (error) {
      if (error instanceof ProviderHttpError && error.credentialRejected) throw error;
      this.logger.warn(
        `${PROVIDER_LABEL[connection.provider]} webhook could not be registered (${(error as Error).message}); availability keeps syncing every 5 minutes.`,
      );
    }
  }

  private verifySignature(
    provider: UsableConnection['provider'],
    secret: string,
    headers: Record<string, string | string[] | undefined>,
    body: Buffer,
  ): boolean {
    const header = (name: string) => {
      const value = headers[name];
      return Array.isArray(value) ? value[0] : value;
    };

    if (provider === 'cal') {
      const signature = header('x-cal-signature-256');
      return Boolean(signature) && safeEqual(signature!, createHmac('sha256', secret).update(body).digest('hex'));
    }

    const parts = Object.fromEntries(
      (header('calendly-webhook-signature') ?? '').split(',').map((part) => part.trim().split('=') as [string, string]),
    );
    const timestamp = Number(parts.t);
    if (!parts.v1 || !Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp * 1000) > SIGNATURE_TOLERANCE_MS) {
      return false;
    }
    const expected = createHmac('sha256', secret).update(`${parts.t}.`).update(body).digest('hex');
    return safeEqual(parts.v1, expected);
  }

  private openSecret(sealed: string): string | null {
    try {
      return this.secrets.open(sealed);
    } catch {
      return null;
    }
  }
}

const MEETING_WRITE_BATCH = 50;

/** Fills each host's timezone from their calendar member, and the meeting's from its first host. */
export function withHostZones(meeting: BookedMeeting, zones: Map<string, string>): BookedMeeting {
  const hosts = meeting.hosts.map((host) => ({
    ...host,
    timezone: host.timezone ?? (host.email ? (zones.get(host.email.toLowerCase()) ?? null) : null),
  }));
  return { ...meeting, hosts, timezone: meeting.timezone ?? hosts.find((host) => host.timezone)?.timezone ?? null };
}

/** A meeting with real start and end instants; anything else is not saved. */
function validMeeting(meeting: BookedMeeting): boolean {
  const start = Date.parse(meeting.start);
  const end = Date.parse(meeting.end);
  return Boolean(meeting.id) && Number.isFinite(start) && Number.isFinite(end) && end >= start;
}

/** A provider meeting as its database row: instants as Date (stored UTC), text cut to the column sizes. */
export function meetingRow(meeting: BookedMeeting, syncedAt: Date) {
  const cut = (value: string | null, max: number) => (value ? value.slice(0, max) : null);
  const zone = (value: string | null) => (isTimeZone(value) ? value : null);
  const people = (list: BookedMeeting['invitees']) =>
    list.slice(0, 100).map((person) => ({
      name: (person.name ?? '').slice(0, 255),
      email: cut(person.email, 255),
      timezone: zone(person.timezone),
    }));
  return {
    externalId: meeting.id.slice(0, 500),
    eventTypeId: cut(meeting.eventTypeId, 500),
    title: (meeting.title || 'Meeting').slice(0, 500),
    startsAt: new Date(meeting.start),
    endsAt: new Date(meeting.end),
    timezone: zone(meeting.timezone),
    status: meeting.status,
    invitees: people(meeting.invitees),
    hosts: people(meeting.hosts),
    meetingUrl: cut(meeting.meetingUrl, 2000),
    location: cut(meeting.location, 1000),
    rescheduleUrl: cut(meeting.rescheduleUrl, 2000),
    cancelUrl: cut(meeting.cancelUrl, 2000),
    canceledReason: cut(meeting.canceledReason, 1000),
    syncedAt,
  };
}

function dedupe<T extends { start: number; end: number; source: string }>(entries: T[]): T[] {
  return [...new Map(entries.map((entry) => [`${entry.start}|${entry.end}|${entry.source}`, entry])).values()];
}

function memberError(label: string, name: string, status: number): string {
  if (status === 403) return `${label} does not share ${name}'s availability with this connection.`;
  if (status === 404) return `${label} could not find ${name}'s calendar.`;
  return `${name}'s availability could not be loaded from ${label}. It will be retried shortly.`;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
