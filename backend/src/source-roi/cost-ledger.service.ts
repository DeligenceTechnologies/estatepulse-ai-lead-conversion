import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Prisma } from '@prisma/client';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import type { IntegrationEnv } from '@/common/utils/interface';
import { DEFAULT_RATES, MAX_RATE, METRIC, ratesFrom, round4, type CostRates } from './cost-rates';
import { smsSegments } from './sms-segments';
import { sourceRoiEnabled } from './source-roi-enabled.guard';

const BATCH = 500;
/** A full pass (the cron, and so the first backfill) may read this many batches per metric. */
const CRON_BATCHES = 400;
/** A report read only tops the ledger up: the cron does the heavy lifting. */
const READ_BATCHES = 4;
/** How far behind the newest ledger row a quick pass looks again, for rows that became costable late (a text marked sent after a retry). */
const LOOKBACK_MS = 48 * 60 * 60 * 1000;
/**
 * How often the cron reads everything instead of the recent window. The window is by when a
 * row was created, so a call repaired days later (a lost hangup webhook) or a text that
 * failed long after it was costed is only ever seen by a full pass.
 */
const FULL_PASS_EVERY_MS = 60 * 60 * 1000;
/** A report read skips its top-up when the organization was reconciled this recently: the page polls every minute. */
const TOP_UP_EVERY_MS = 5 * 60 * 1000;

interface CallRow {
  id: string;
  lead_id: string;
  provider: string | null;
  duration_seconds: number;
  occurred_at: Date;
}

interface MessageRow {
  id: string;
  lead_id: string;
  body: string;
  occurred_at: Date;
}

export interface RatesDTO extends CostRates {
  /** False where the organization still uses the default. */
  custom: { callRatePerMinute: boolean; smsRatePerSegment: boolean };
  defaults: CostRates;
}

/**
 * The cost ledger (usage_records): what each AI call and each text is estimated
 * to have cost, at the organization's rate when it was costed.
 *
 * Rows are not written where calls end and texts are sent. Those places are
 * many (five write a text) and change often; instead `reconcile` reads calls
 * and messages and adds a ledger row for each one that has none. It is safe to
 * run any number of times: (metric, source_id) is unique, so nothing is costed
 * twice, and its first run is the backfill.
 */
@Injectable()
export class CostLedgerService {
  private readonly logger = new Logger(CostLedgerService.name);
  private readonly running = new Set<string>();
  private readonly reconciledAt = new Map<string, number>();
  private cronRunning = false;
  private lastFullPassAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<IntegrationEnv, true>,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'source-roi-cost-ledger' })
  async reconcileAll(): Promise<void> {
    if (!sourceRoiEnabled(this.config) || this.cronRunning) return;
    this.cronRunning = true;
    // The first pass after a start is a full one.
    const full = Date.now() - this.lastFullPassAt >= FULL_PASS_EVERY_MS;
    try {
      const orgs = await this.prisma.organization.findMany({ select: { id: true } });
      for (const { id } of orgs) {
        await this.reconcile(id, CRON_BATCHES, full).catch((error) =>
          this.logger.warn(`cost ledger for organization ${id}: ${(error as Error).message}`),
        );
      }
      if (full) this.lastFullPassAt = Date.now();
    } finally {
      this.cronRunning = false;
    }
  }

  /** Tops the ledger up before a report is read, unless it was reconciled moments ago; never fails the read. */
  async topUp(orgId: string): Promise<void> {
    if (Date.now() - (this.reconciledAt.get(orgId) ?? 0) < TOP_UP_EVERY_MS) return;
    await this.reconcile(orgId, READ_BATCHES).catch((error) =>
      this.logger.warn(`cost ledger top-up for organization ${orgId}: ${(error as Error).message}`),
    );
  }

  /**
   * Costs the organization's calls and texts that are not in the ledger yet, and takes back the
   * texts that failed after they were costed. Returns how many rows it added. A quick pass reads
   * the recent window only; a full one reads everything.
   */
  async reconcile(orgId: string, maxBatches = CRON_BATCHES, full = false): Promise<number> {
    if (this.running.has(orgId)) return 0;
    this.running.add(orgId);
    this.reconciledAt.set(orgId, Date.now());
    try {
      const rates = ratesFrom(
        await this.prisma.organizationSetting.findUnique({
          where: { orgId },
          select: { callRatePerMinute: true, smsRatePerSegment: true },
        }),
      );
      const calls = await this.costCalls(orgId, rates.callRatePerMinute, maxBatches, full);
      const texts = await this.costMessages(orgId, rates.smsRatePerSegment, maxBatches, full);
      return calls + texts;
    } finally {
      this.running.delete(orgId);
    }
  }

  async getRates(orgId: string): Promise<RatesDTO> {
    const row = await this.prisma.organizationSetting.findUnique({
      where: { orgId },
      select: { callRatePerMinute: true, smsRatePerSegment: true },
    });
    return {
      ...ratesFrom(row),
      custom: { callRatePerMinute: row?.callRatePerMinute != null, smsRatePerSegment: row?.smsRatePerSegment != null },
      defaults: DEFAULT_RATES,
    };
  }

  /** Null puts a rate back on the default; a field left out is not changed. Rows already costed keep the rate they were costed at. */
  async setRates(orgId: string, input: { callRatePerMinute?: number | null; smsRatePerSegment?: number | null }): Promise<RatesDTO> {
    const data: Prisma.OrganizationSettingUpdateInput = {};
    for (const key of ['callRatePerMinute', 'smsRatePerSegment'] as const) {
      const value = input[key];
      if (value === undefined) continue;
      if (value !== null && (!Number.isFinite(value) || value < 0 || value > MAX_RATE)) {
        throw new AppError('VALIDATION_ERROR', `A rate must be between 0 and ${MAX_RATE}.`);
      }
      data[key] = value;
    }
    await this.prisma.organizationSetting.upsert({ where: { orgId }, create: { orgId, ...data } as Prisma.OrganizationSettingUncheckedCreateInput, update: data });
    return this.getRates(orgId);
  }

  /**
   * Answered calls only: a call that was never answered stores how long it
   * rang, not talk time, and is not billed by the minute.
   */
  private async costCalls(orgId: string, rate: number, maxBatches: number, full: boolean): Promise<number> {
    const since = full ? null : await this.since(orgId, METRIC.CALL_MINUTES);
    let added = 0;
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const rows = await this.prisma.$queryRaw<CallRow[]>`
        SELECT c.id, c.lead_id, c.provider, c.duration_seconds,
               coalesce(c.ended_at, c.started_at, c.created_at) AS occurred_at
          FROM calls c
         WHERE c.organization_id = ${orgId}::uuid
           AND c.status = 'completed' AND c.duration_seconds > 0
           AND (${since}::timestamptz IS NULL OR c.created_at >= ${since}::timestamptz)
           AND NOT EXISTS (SELECT 1 FROM usage_records u
                            WHERE u.metric = ${METRIC.CALL_MINUTES} AND u.source_id = c.id)
         ORDER BY c.created_at
         LIMIT ${BATCH}`;
      if (!rows.length) break;
      const { count } = await this.prisma.usageRecord.createMany({
        skipDuplicates: true,
        data: rows.map((row) => {
          const quantity = round4(row.duration_seconds / 60);
          return {
            orgId,
            leadId: row.lead_id,
            metric: METRIC.CALL_MINUTES,
            sourceId: row.id,
            quantity,
            unitRate: rate,
            amount: round4(quantity * rate),
            provider: row.provider,
            occurredAt: row.occurred_at,
          };
        }),
      });
      added += count;
      if (rows.length < BATCH || count === 0) break;
    }
    return added;
  }

  /**
   * Texts the carrier handled: every inbound one, and outbound ones the
   * provider accepted (it gave them an id) that did not fail. A text an agent
   * typed but the provider never took has no provider id and costs nothing.
   *
   * A text is costed once the provider accepts it, and the carrier can still
   * fail it afterwards: those estimates are removed first. A real provider cost
   * (not an estimate) is kept, the provider did charge it.
   */
  private async costMessages(orgId: string, rate: number, maxBatches: number, full: boolean): Promise<number> {
    const since = full ? null : await this.since(orgId, METRIC.SMS_SEGMENTS);
    await this.prisma.$executeRaw`
      DELETE FROM usage_records u
       USING messages m
       WHERE u.organization_id = ${orgId}::uuid
         AND u.metric = ${METRIC.SMS_SEGMENTS} AND u.is_estimated
         AND m.id = u.source_id
         AND m.direction = 'outbound' AND m.delivery_status = 'failed'
         AND (${since}::timestamptz IS NULL OR m.created_at >= ${since}::timestamptz)`;
    let added = 0;
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const rows = await this.prisma.$queryRaw<MessageRow[]>`
        SELECT m.id, m.lead_id, m.body, coalesce(m.sent_at, m.created_at) AS occurred_at
          FROM messages m
         WHERE m.organization_id = ${orgId}::uuid
           AND m.channel = 'sms'
           AND (m.direction = 'inbound' OR (m.provider_message_id IS NOT NULL AND m.delivery_status <> 'failed'))
           AND (${since}::timestamptz IS NULL OR m.created_at >= ${since}::timestamptz)
           AND NOT EXISTS (SELECT 1 FROM usage_records u
                            WHERE u.metric = ${METRIC.SMS_SEGMENTS} AND u.source_id = m.id)
         ORDER BY m.created_at
         LIMIT ${BATCH}`;
      if (!rows.length) break;
      const { count } = await this.prisma.usageRecord.createMany({
        skipDuplicates: true,
        data: rows.map((row) => {
          const quantity = smsSegments(row.body);
          return {
            orgId,
            leadId: row.lead_id,
            metric: METRIC.SMS_SEGMENTS,
            sourceId: row.id,
            quantity,
            unitRate: rate,
            amount: round4(quantity * rate),
            occurredAt: row.occurred_at,
          };
        }),
      });
      added += count;
      if (rows.length < BATCH || count === 0) break;
    }
    return added;
  }

  /** Where a quick pass starts reading: a little before the newest ledger row, or the beginning when there is none. */
  private async since(orgId: string, metric: string): Promise<Date | null> {
    const newest = await this.prisma.usageRecord.aggregate({ where: { orgId, metric }, _max: { occurredAt: true } });
    const at = newest._max.occurredAt;
    return at ? new Date(at.getTime() - LOOKBACK_MS) : null;
  }
}
