import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@/common/prisma/prisma.service';
import { MailService } from '@/common/service/mail.service';
import type { DailySummaryEnv } from '@/common/utils/interface';
import { mapLimit } from '@/common/utils/map-limit';
import { addDays, isTimeZone, localDate, minutesOf, zonedToInstant } from '@/common/utils/zoned-time';
import { EmailQueue } from '@/queue/email/email.queue';
import { collectDailySummary, isQuietDay, type SummaryWindow } from './daily-summary.stats';
import { dailySummaryEmail } from './templates/daily-summary-email';

/** A claim older than this was left by an instance that died mid-send, and is taken over. */
const STALE_CLAIM_MS = 10 * 60_000;
const CONCURRENCY = 5;
const DEFAULT_SEND_AT = '23:55';
/** A send time before this (minutes past midnight) summarises the whole previous day. */
const NOON = 12 * 60;
const HOUR_MS = 60 * 60_000;

interface DueOrg {
  id: string;
  name: string;
  timezone: string;
  /** The local day being summarised, YYYY-MM-DD. */
  date: string;
  window: SummaryWindow;
  /** The organization's send time, HH:MM. */
  sendAt: string;
}

/**
 * The owners' daily summary email. Each organization picks its send time in
 * Settings (org_settings.daily_summary_time, its own timezone). From noon on,
 * the email covers that day from midnight up to the send time; a morning time
 * covers the whole previous day. Each minute this finds the organizations whose
 * send time has passed, and a summary the server missed (it was down) still
 * goes out for DAILY_SUMMARY_CATCH_UP_HOURS after it.
 *
 * Exactly once per organization per day, across any number of instances: a
 * day is claimed by inserting its (organization, date) row, which is unique.
 * A failed send releases the claim so the next tick retries; the queue's job
 * ids keep owners already queued from getting it twice.
 *
 * Uses the unguarded client: it sweeps every tenant by design, and scopes
 * every query it makes to one organization id.
 */
@Injectable()
export class DailySummaryRunner implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DailySummaryRunner.name);
  private readonly catchUpMs: number;
  private readonly appUrl?: string;
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly emailQueue: EmailQueue,
    private readonly config: ConfigService<DailySummaryEnv, true>,
  ) {
    this.catchUpMs = config.get('DAILY_SUMMARY_CATCH_UP_HOURS', { infer: true }) * HOUR_MS;
    this.appUrl = config.get('APP_URL', { infer: true })?.replace(/\/+$/, '');
  }

  onModuleInit(): void {
    if (!this.config.get('DAILY_SUMMARY_ENABLED', { infer: true })) {
      this.logger.log('Daily summary email is off (DAILY_SUMMARY_ENABLED=false)');
      return;
    }
    if (!this.mail.enabled) {
      this.logger.log('Daily summary email is off: no mail provider');
      return;
    }
    this.timer = setInterval(() => void this.tick(), this.config.get('DAILY_SUMMARY_POLL_MS', { infer: true }));
    this.timer.unref();
    this.logger.log("Daily summary email on: each organization's own send time, in its timezone");
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.inFlight) await Promise.race([this.inFlight, new Promise((resolve) => setTimeout(resolve, 5000).unref())]).catch(() => undefined);
  }

  /** Public for a manual run; overlapping calls are dropped. */
  async tick(now = new Date()): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    this.inFlight = (async () => {
      try {
        const due = await this.dueOrganizations(now);
        await mapLimit(due, CONCURRENCY, (org) => (this.stopped ? Promise.resolve() : this.runFor(org, now)));
      } catch (error) {
        this.logger.error(`Daily summary tick failed: ${(error as Error).message}`);
      }
    })();
    try {
      await this.inFlight;
    } finally {
      this.running = false;
      this.inFlight = null;
    }
  }

  /**
   * Which local day, if any, an organization sending at `sendAt` (HH:MM in
   * `timeZone`) is due a summary for at `now`: the day whose send moment has
   * passed, by less than the catch-up allowance.
   */
  dueDay(now: Date, timeZone: string, sendAt: string): { date: string; window: SummaryWindow } | null {
    const minutes = minutesOf(sendAt);
    const today = localDate(now.getTime(), timeZone);
    const date = [today, addDays(today, -1)].find((day) => {
      // A morning send belongs to the day before it.
      const sendMoment = zonedToInstant(minutes < NOON ? addDays(day, 1) : day, minutes, timeZone);
      return now.getTime() >= sendMoment && now.getTime() < sendMoment + this.catchUpMs;
    });
    if (!date) return null;

    const dayEnd = zonedToInstant(addDays(date, 1), 0, timeZone);
    return {
      date,
      window: {
        from: new Date(zonedToInstant(date, 0, timeZone)),
        to: new Date(Math.min(now.getTime(), dayEnd)),
        tomorrowFrom: new Date(dayEnd),
        tomorrowTo: new Date(zonedToInstant(addDays(date, 2), 0, timeZone)),
      },
    };
  }

  private async dueOrganizations(now: Date): Promise<DueOrg[]> {
    const orgs = await this.prisma.organization.findMany({
      where: { status: 'active' },
      select: {
        id: true,
        name: true,
        settings: { select: { timezone: true, dailySummaryEnabled: true, dailySummaryTime: true } },
      },
    });

    const candidates: DueOrg[] = [];
    for (const org of orgs) {
      if (org.settings?.dailySummaryEnabled === false) continue;
      const timezone = isTimeZone(org.settings?.timezone) ? org.settings!.timezone : 'UTC';
      const sendAt = org.settings?.dailySummaryTime ?? DEFAULT_SEND_AT;
      const due = this.dueDay(now, timezone, sendAt);
      if (due) candidates.push({ id: org.id, name: org.name, timezone, sendAt, ...due });
    }
    if (!candidates.length) return [];

    // One read for all of them, rather than an insert attempt per organization every minute.
    const done = await this.prisma.dailySummaryRun.findMany({
      where: {
        orgId: { in: candidates.map((c) => c.id) },
        summaryDate: { in: [...new Set(candidates.map((c) => c.date))].map(asDbDate) },
      },
      select: { orgId: true, summaryDate: true, status: true, claimedAt: true },
    });
    const finished = new Set(
      done
        .filter((run) => run.status !== 'claimed' || now.getTime() - run.claimedAt.getTime() < STALE_CLAIM_MS)
        .map((run) => `${run.orgId}:${run.summaryDate.toISOString().slice(0, 10)}`),
    );
    return candidates.filter((c) => !finished.has(`${c.id}:${c.date}`));
  }

  private async runFor(org: DueOrg, now: Date): Promise<void> {
    if (!(await this.claim(org, now))) return;

    try {
      const owners = await this.prisma.user.findMany({
        where: { orgId: org.id, status: 'active', roles: { some: { role: { isSystem: true } } } },
        select: { id: true, email: true, firstName: true },
      });
      if (!owners.length) return await this.finish(org, 'no_recipients', 0);

      const stats = await collectDailySummary(this.prisma, org.id, org.window);
      if (isQuietDay(stats)) return await this.finish(org, 'skipped_empty', 0);

      const dayLabel = new Intl.DateTimeFormat('en-US', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(new Date(`${org.date}T12:00:00Z`));

      for (const owner of owners) {
        await this.emailQueue.enqueue(
          {
            kind: 'daily_summary',
            to: owner.email,
            ...dailySummaryEmail({
              firstName: owner.firstName,
              organizationName: org.name,
              dayLabel,
              coverage: minutesOf(org.sendAt) < NOON ? 'the whole day' : `midnight to ${clock(org.sendAt)}`,
              stats,
              dashboardUrl: this.appUrl ? `${this.appUrl}/dashboard` : undefined,
              settingsUrl: this.appUrl ? `${this.appUrl}/settings` : undefined,
            }),
          },
          { dedupeKey: `daily_summary:${org.id}:${org.date}:${owner.id}` },
        );
      }
      await this.finish(org, 'sent', owners.length);
      this.logger.log(`Daily summary for ${org.date} queued for ${owners.length} owner(s) of organization ${org.id}`);
    } catch (error) {
      // Let the next tick try again.
      await this.prisma.dailySummaryRun
        .deleteMany({ where: { orgId: org.id, summaryDate: asDbDate(org.date), status: 'claimed' } })
        .catch(() => undefined);
      this.logger.error(`Daily summary for organization ${org.id} (${org.date}) failed: ${(error as Error).message}`);
    }
  }

  /** True when this instance now owns the day: a fresh claim, or one abandoned by an instance that died. */
  private async claim(org: DueOrg, now: Date): Promise<boolean> {
    const summaryDate = asDbDate(org.date);
    const inserted = await this.prisma.dailySummaryRun.createMany({
      data: [{ orgId: org.id, summaryDate, status: 'claimed', claimedAt: now }],
      skipDuplicates: true,
    });
    if (inserted.count === 1) return true;
    const taken = await this.prisma.dailySummaryRun.updateMany({
      where: { orgId: org.id, summaryDate, status: 'claimed', claimedAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) } },
      data: { claimedAt: now },
    });
    return taken.count === 1;
  }

  private async finish(org: DueOrg, status: 'sent' | 'skipped_empty' | 'no_recipients', recipients: number): Promise<void> {
    await this.prisma.dailySummaryRun.updateMany({
      where: { orgId: org.id, summaryDate: asDbDate(org.date) },
      data: { status, recipients, finishedAt: new Date() },
    });
  }
}

/** "21:00" → "9:00 PM". */
function clock(time: string): string {
  const minutes = minutesOf(time);
  const hour = Math.floor(minutes / 60);
  return `${hour % 12 || 12}:${String(minutes % 60).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}

/** A YYYY-MM-DD local day as the value Prisma writes to a DATE column. */
function asDbDate(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}
