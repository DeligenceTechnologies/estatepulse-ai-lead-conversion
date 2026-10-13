import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
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
import { SecretBoxService } from '@/common/service/secret-box.service';
import type { IntegrationEnv } from '@/common/utils/interface';
import { mapLimit } from '@/common/utils/map-limit';
import { merge } from '../availability/intervals';
import { CalendarService, type UsableConnection } from '../calendar.service';
import { PROVIDER_LABEL, type SchedulingMember } from '../calendar.types';
import { CalClient, type CalBookingWindow } from '../providers/cal.client';
import { CalendlyClient } from '../providers/calendly.client';
import { ProviderHttpError } from '../providers/provider-http';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const SYNC_INTERVAL_MS = 5 * MINUTE_MS;
const STALE_AFTER_MS = 10 * MINUTE_MS;
const LEASE_MS = 4 * MINUTE_MS;
const FAILURE_BACKOFF_MS = 2 * MINUTE_MS;
const MANUAL_COOLDOWN_MS = 30_000;
const SCHEDULE_TTL_MS = 6 * 60 * MINUTE_MS;
const WEBHOOK_RETRY_MS = DAY_MS;
const WEBHOOK_DEBOUNCE_MS = 5_000;
const WEBHOOK_BUSY_RETRY_MS = 30_000;
const SIGNATURE_TOLERANCE_MS = 5 * MINUTE_MS;
const CALENDLY_BUSY_SPAN_MS = 7 * DAY_MS;
const CONCURRENCY = 4;
const CRON_CONCURRENCY = 2;
const CRON_BATCH = 200;

export const SYNC_HORIZON_DAYS = 14;
export const HISTORY_DAYS = 90;

export type SyncOutcome = 'synced' | 'busy' | 'skipped';

interface SyncedMember {
  id: string;
  externalId: string;
  name: string;
  username: string | null;
  scheduleSyncedAt: Date | null;
}

interface MemberPull {
  blocks: { kind: CalendarBlockKind; start: number; end: number; blockedStart?: number; blockedEnd?: number }[];
  schedule?: Prisma.InputJsonValue | null;
  status: CalendarMemberSyncStatus;
  message: string | null;
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
    private readonly calendar: CalendarService,
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
        isActive: true,
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
    const { count } = await this.prisma.calendarTimeBlock.deleteMany({
      where: { endsAt: { lt: new Date(Date.now() - HISTORY_DAYS * DAY_MS) } },
    });
    if (count) this.logger.log(`Pruned ${count} calendar blocks older than ${HISTORY_DAYS} days.`);
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
      where: { orgId, isActive: true },
      select: { id: true, syncedAt: true },
    });
    if (!connection) throw new NotFoundException('No calendar is connected.');
    if (connection.syncedAt && Date.now() - connection.syncedAt.getTime() < MANUAL_COOLDOWN_MS) return 'skipped';
    return this.sync(connection.id);
  }

  async receiveWebhook(connectionId: string, headers: Record<string, string | string[] | undefined>, body: Buffer | undefined) {
    const connection = await this.prisma.calendarConnection.findUnique({
      where: { id: connectionId },
      select: { provider: true, webhookSecret: true },
    });
    const secret = connection?.webhookSecret && this.secrets.enabled ? this.openSecret(connection.webhookSecret) : null;
    if (!connection || !secret) throw new NotFoundException();
    if (!body || !this.verifySignature(connection.provider, secret, headers, body)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }
    this.requestSync(connectionId);
    return { received: true };
  }

  async sync(connectionId: string): Promise<SyncOutcome> {
    const now = new Date();
    const lease = await this.prisma.calendarConnection.updateMany({
      where: {
        id: connectionId,
        isActive: true,
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
      await this.calendar.useActive(orgId, async (connection, secret) => {
        if (connection.id !== connectionId) return;
        await this.pull(connection, secret);
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
        this.sync(connectionId)
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
    const members = await this.saveMembers(connection, await this.calendar.membersFor(connection, secret));
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

  private async pullCalendly(token: string, member: SyncedMember, window: Window): Promise<MemberPull> {
    const scheduleDue = !member.scheduleSyncedAt || Date.now() - member.scheduleSyncedAt.getTime() > SCHEDULE_TTL_MS;
    const spans: Window[] = [];
    for (let start = window.from; start < window.until; start += CALENDLY_BUSY_SPAN_MS) {
      spans.push({ from: start, until: Math.min(start + CALENDLY_BUSY_SPAN_MS, window.until) });
    }

    const [schedule, ...busy] = await Promise.all([
      scheduleDue ? this.calendly.defaultSchedule(token, member.externalId) : Promise.resolve(undefined),
      ...spans.map((span) => this.calendly.busyTimes(token, member.externalId, new Date(span.from), new Date(span.until))),
    ]);

    const current =
      schedule !== undefined
        ? schedule
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
      ...(schedule !== undefined ? { schedule: (schedule ?? null) as Prisma.InputJsonValue | null } : {}),
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

    if (!member.username) {
      return { blocks: busy, status: 'limited', message: `${member.name} has no Cal.com username, so free time cannot be read.` };
    }
    const eventType = await this.cal.shortestEventType(apiKey, member.username);
    if (!eventType) {
      return {
        blocks: busy,
        status: 'limited',
        message: `${member.name} has no public meeting type in Cal.com, so free time cannot be read.`,
      };
    }
    const slots = await this.cal.slots(apiKey, eventType.id, new Date(window.from), new Date(window.until));
    const free = merge(slots).map(({ start, end }) => ({ kind: 'free' as const, start, end }));
    return { blocks: [...free, ...busy], status: 'ok', message: null };
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
        select: { id: true, externalId: true, name: true, username: true, scheduleSyncedAt: true },
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
            ? { schedule: pull.schedule === null ? Prisma.DbNull : pull.schedule, scheduleSyncedAt: now }
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
