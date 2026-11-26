import { InjectQueue } from '@nestjs/bullmq';
import { HttpException, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { UnrecoverableError, type Queue } from 'bullmq';
import type { Subscription } from 'rxjs';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import type { NangoEnv } from '@/common/utils/interface';
import { AuditService } from '@/audit/audit.service';
import type { AuthContext } from '@/auth/auth.types';
import { EventsBus } from '@/events/events.bus';
import { INTEGRATION_SYNC_QUEUE, IntegrationSyncJob } from '@/queue/queue.constants';
import type { AdapterContext, IntegrationAdapter } from '../adapters/adapter.interface';
import { AdapterRegistry } from '../adapters/adapter.registry';
import { ProviderClient } from '../adapters/provider-client';
import type { PushJobData, TwoWayView } from '../integrations.types';
import { NangoError, NangoService } from '../nango/nango.service';
import { ProvidersService } from '../providers/providers.service';
import { SyncService } from './sync.service';
import { WriteRefused, afterPush, leadValues, planOutbound, readState, stateJson, type SyncField, type SyncState } from './two-way';

/** Lead edits within this window go out as one write. */
const COALESCE_MS = 5_000;
/** Records checked per sweep; the next sweep takes the rest. */
const SWEEP_BATCH = 500;
/** A record whose write failed is retried by the sweep after this long (and at once when the lead changes again). */
const FAILED_RETRY_AFTER_MS = 60 * 60_000;

const LEAD_SELECT = {
  id: true,
  mergedIntoId: true,
  updatedAt: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  location: true,
  timeline: true,
  motivation: true,
  minBudget: true,
  maxBudget: true,
  bedrooms: true,
} satisfies Prisma.LeadSelect;

export type PushOutcome = 'pushed' | 'nothing' | 'skipped' | 'refused';

/**
 * Two-way sync, outbound half: lead changes made in EstatePulse are written to
 * the provider record each lead came from.
 *
 * WHEN: a `lead.updated` event (edits in the app) queues the lead's records
 * within seconds; a sweep every two minutes catches every other way a lead
 * changes (AI calls, merges, automations) by comparing `leads.updated_at`
 * with the record's `local_checked_at`. Both only queue; the push job does
 * the work, one job per record at a time (job id = record id).
 *
 * WHAT: per field, only values that differ from the last agreed base
 * (two-way.ts); a field the provider cannot take (Airtable formula column) is
 * left alone. Unchanged leads cost a database read, never an API call.
 *
 * FAILURES never lose a change: the base only moves after the provider
 * accepted the write. A refused value (404, 422) is shown on the record and
 * retried when the lead changes again or after an hour; a grant without write
 * access pauses write-back for that account with the reason; a revoked grant
 * parks the account as reauth_required; rate limits and outages are retried by
 * the queue.
 */
@Injectable()
export class WriteBackService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WriteBackService.name);
  private subscription: Subscription | null = null;
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly adapters: AdapterRegistry,
    private readonly nango: NangoService,
    private readonly providers: ProvidersService,
    private readonly sync: SyncService,
    private readonly audit: AuditService,
    private readonly events: EventsBus,
    private readonly config: ConfigService<NangoEnv, true>,
    @InjectQueue(INTEGRATION_SYNC_QUEUE) private readonly queue: Queue<PushJobData>,
  ) {}

  onModuleInit(): void {
    this.subscription = this.events.all().subscribe((event) => {
      if (event.type !== 'lead.updated' || !event.leadId) return;
      this.queueForLead(event.organizationId, event.leadId).catch((error) =>
        this.logger.warn(`Could not queue write-back for lead ${event.leadId}: ${(error as Error).message}`),
      );
    });
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  /** Whether this provider can write back at all. */
  supports(provider: string): boolean {
    return Boolean(this.adapters.get(provider)?.writeBack);
  }

  async view(connection: {
    id: string;
    provider: string;
    writeBackEnabled: boolean;
    writeBackError: string | null;
    writeBackErrorAt: Date | null;
  }): Promise<TwoWayView | null> {
    const writeBack = this.adapters.get(connection.provider)?.writeBack;
    if (!writeBack) return null;
    const [failedRecords, last] = await Promise.all([
      this.prisma.integrationRecord.count({ where: { connectionId: connection.id, pushErrorAt: { not: null } } }),
      this.prisma.integrationRecord.findFirst({
        where: { connectionId: connection.id, pushedAt: { not: null } },
        orderBy: { pushedAt: 'desc' },
        select: { pushedAt: true },
      }),
    ]);
    return {
      enabled: connection.writeBackEnabled,
      error: connection.writeBackError,
      errorAt: connection.writeBackErrorAt?.toISOString() ?? null,
      writeScopes: [...writeBack.writeScopes],
      failedRecords,
      lastPushedAt: last?.pushedAt?.toISOString() ?? null,
    };
  }

  /** Turns write-back on or off for one account. Turning it on re-reads the provider so every linked record has a base. */
  async setEnabled(auth: AuthContext, connectionId: string, enabled: boolean): Promise<void> {
    const connection = await this.prisma.integrationConnection.findFirst({ where: { id: connectionId, orgId: auth.organizationId } });
    if (!connection) throw new NotFoundException('That connection was not found.');
    const adapter = this.adapters.get(connection.provider);
    if (!adapter?.writeBack) throw new AppError('VALIDATION_ERROR', `${adapter?.displayName ?? connection.provider} cannot write changes back.`);
    if (enabled && connection.status === 'disconnected') throw new AppError('CONFLICT', 'This account was disconnected.');
    if (connection.writeBackEnabled === enabled && !(enabled && connection.writeBackError)) return;

    await this.prisma.integrationConnection.update({
      where: { id: connection.id },
      // Turning it on again is how an owner retries after fixing the grant's scopes.
      data: { writeBackEnabled: enabled, writeBackError: null, writeBackErrorAt: null },
    });
    this.audit.quietly({
      orgId: auth.organizationId,
      actorType: 'user',
      actorId: auth.userId,
      action: enabled ? 'integration.write_back_enabled' : 'integration.write_back_disabled',
      entityType: 'integration_connection',
      entityId: connection.id,
      payload: { provider: connection.provider },
    });
    if (enabled && this.sync.blocker(connection) === null) {
      // A sync gives records linked before two-way their base; the sweep then picks up lead changes.
      await this.sync.enqueue(auth.organizationId, connection.id, 'manual', auth.userId).catch((error) =>
        this.logger.warn(`Could not queue the baseline sync of ${connection.id}: ${(error as Error).message}`),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Queueing
  // ---------------------------------------------------------------------------

  /** Queues the records of one lead on accounts with write-back on. */
  async queueForLead(orgId: string, leadId: string): Promise<void> {
    const records = await this.prisma.integrationRecord.findMany({
      where: { orgId, leadId, connection: { writeBackEnabled: true, writeBackError: null, status: 'connected' } },
      select: { id: true },
      take: 50,
    });
    for (const r of records) await this.queuePush(r.id);
  }

  /**
   * One pending push per record: while one is waiting, another add is a no-op
   * (it will read the lead as it is when it runs). Completed jobs are removed
   * so the id can be queued again.
   */
  async queuePush(recordId: string, delay = COALESCE_MS): Promise<void> {
    await this.queue.add(IntegrationSyncJob.Push, { recordId }, { jobId: `integration-push-${recordId}`, delay, removeOnComplete: true, removeOnFail: true });
  }

  /** Catches lead changes no event announced. Only queues; safe on several instances (job ids dedupe). */
  @Cron('*/2 * * * *', { name: 'integration-write-back-sweep' })
  async sweep(): Promise<void> {
    if (this.sweeping || !this.nango.configured || !this.config.get('INTEGRATION_WORKER_ENABLED', { infer: true })) return;
    this.sweeping = true;
    try {
      const retryBefore = new Date(Date.now() - FAILED_RETRY_AFTER_MS);
      const due = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT r.id
        FROM integration_records r
        JOIN integration_connections c ON c.id = r.connection_id
        JOIN leads l ON l.id = r.lead_id
        WHERE c.write_back_enabled = true
          AND c.write_back_error IS NULL
          AND c.status = 'connected'
          AND (r.local_checked_at IS NULL OR l.updated_at > r.local_checked_at)
          AND (r.push_error_at IS NULL OR r.push_error_at < ${retryBefore})
        ORDER BY l.updated_at
        LIMIT ${SWEEP_BATCH}`;
      for (const r of due) await this.queuePush(r.id, 0);
      if (due.length) this.logger.log(`Write-back sweep queued ${due.length} record${due.length === 1 ? '' : 's'}`);
    } catch (error) {
      this.logger.warn(`Write-back sweep failed: ${(error as Error).message}`);
    } finally {
      this.sweeping = false;
    }
  }

  // ---------------------------------------------------------------------------
  // The push job
  // ---------------------------------------------------------------------------

  /**
   * Writes one record's pending lead changes. Throws NangoError RATE_LIMITED /
   * UNAVAILABLE for the worker to delay or retry, UnrecoverableError when
   * retrying cannot help.
   */
  async push(recordId: string): Promise<PushOutcome> {
    const record = await this.prisma.integrationRecord.findUnique({
      where: { id: recordId },
      include: { connection: true },
    });
    if (!record?.leadId) return 'skipped';
    const { connection } = record;
    if (!connection.writeBackEnabled || connection.writeBackError || connection.status !== 'connected') return 'skipped';
    const adapter = this.adapters.get(connection.provider);
    if (!adapter?.writeBack) return 'skipped';

    const lead = await this.prisma.lead.findUnique({ where: { id: record.leadId }, select: LEAD_SELECT });
    if (!lead) return 'skipped';
    if (lead.mergedIntoId) {
      // Merged away: the record now belongs to the surviving lead; the next run writes that one.
      await this.prisma.integrationRecord.update({ where: { id: record.id }, data: { leadId: lead.mergedIntoId, localCheckedAt: null } });
      await this.queuePush(record.id);
      return 'skipped';
    }

    const settings = (connection.settings ?? {}) as Record<string, unknown>;
    const fields = adapter.writeBack.fields(settings);
    const localNow = leadValues(lead, fields);
    const state = readState(record.syncState);
    // The lead version this run compares: a change after it is picked up by the next event or sweep.
    const checked = lead.updatedAt;

    let plan = planOutbound(fields, fields, localNow, state);
    if (!Object.keys(plan.changes).length) {
      await this.settle(record.id, state, plan.next, {}, checked, null);
      return 'nothing';
    }

    const ctx: AdapterContext = {
      connectionId: connection.id,
      orgId: connection.orgId,
      settings,
      client: new ProviderClient(this.nango, connection.providerConfigKey, connection.nangoConnectionId),
      actorId: null,
    };
    const { name: providerName } = await this.providers.displayOf(connection.provider);

    try {
      plan = planOutbound(fields, await adapter.writeBack.writableFields(ctx), localNow, state);
      if (!Object.keys(plan.changes).length) {
        await this.settle(record.id, state, plan.next, {}, checked, null);
        return 'nothing';
      }
      await adapter.writeBack.push(ctx, { objectType: record.objectType, externalId: record.externalId, meta: state.meta }, plan.changes, localNow);
    } catch (error) {
      return this.failed(error, record.id, connection, adapter, providerName, checked);
    }

    await this.settle(record.id, state, plan.next, plan.changes, checked, new Date());
    this.logger.log(`Wrote ${Object.keys(plan.changes).join(', ')} of lead ${lead.id} back to ${providerName} (${record.objectType} ${record.externalId})`);
    return 'pushed';
  }

  /** A write the queue gave up on (retries spent): say so on the record, keep the change pending. */
  async exhausted(recordId: string, message: string): Promise<void> {
    await this.prisma.integrationRecord
      .updateMany({
        where: { id: recordId },
        data: { pushError: `Write-back failed: ${message}`.slice(0, 500), pushErrorAt: new Date() },
      })
      .catch((error) => this.logger.warn(`Could not record the write-back failure of ${recordId}: ${(error as Error).message}`));
  }

  /**
   * Saves the new base under a lock on the record, merged onto what is there
   * now: an import that ran meanwhile keeps the fields it settled, and only
   * the fields this run wrote (or saw for the first time) move.
   */
  private async settle(
    recordId: string,
    before: SyncState,
    planned: SyncState,
    pushed: Record<string, unknown>,
    checked: Date,
    pushedAt: Date | null,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ sync_state: unknown }[]>`SELECT sync_state FROM integration_records WHERE id = ${recordId}::uuid FOR UPDATE`;
      if (!locked.length) return;
      const current = readState(locked[0].sync_state);
      const next: SyncState = { v: 1, local: { ...current.local }, remote: { ...current.remote }, meta: { ...current.meta } };
      // Fields this run took as base without writing (first sight, read-only column).
      for (const [f, v] of Object.entries(planned.local) as [SyncField, SyncState['local'][SyncField]][]) {
        if (!(f in pushed) && (!(f in before.local) || before.local[f] !== v) && current.local[f] === before.local[f]) next.local[f] = v;
      }
      const final = afterPush(next, pushed as SyncState['local']);
      await tx.integrationRecord.update({
        where: { id: recordId },
        data: {
          syncState: stateJson(final),
          localCheckedAt: checked,
          ...(pushedAt ? { pushedAt, pushError: null, pushErrorAt: null } : {}),
        },
      });
    });
  }

  private async failed(
    error: unknown,
    recordId: string,
    connection: { id: string; orgId: string; nangoConnectionId: string; provider: string },
    adapter: IntegrationAdapter,
    providerName: string,
    checked: Date,
  ): Promise<PushOutcome> {
    const refuse = async (message: string): Promise<PushOutcome> => {
      // The change stays pending (its base did not move); it is tried again when the lead changes or after an hour.
      await this.prisma.integrationRecord.update({
        where: { id: recordId },
        data: { pushError: message.slice(0, 500), pushErrorAt: new Date(), localCheckedAt: checked },
      });
      return 'refused';
    };

    if (error instanceof WriteRefused) return refuse(error.message);
    if (!(error instanceof NangoError)) {
      // A setup problem the adapter reported (table deleted...): retrying will not fix it.
      if (error instanceof HttpException) return refuse(error.message);
      throw error;
    }
    switch (error.kind) {
      case 'RATE_LIMITED':
      case 'UNAVAILABLE':
        throw error;
      case 'REAUTH': {
        await this.prisma.integrationConnection.updateMany({
          where: { id: connection.id, status: { in: ['connected', 'error'] } },
          data: {
            status: 'reauth_required',
            lastErrorCode: 'REAUTH_REQUIRED',
            lastErrorMessage: `${providerName} access was revoked or has expired. Reconnect to continue.`,
            lastErrorAt: new Date(),
          },
        });
        throw new UnrecoverableError(`${providerName} access was revoked or has expired.`);
      }
      case 'MISCONFIGURED':
        throw new UnrecoverableError('The integration is not set up correctly in Nango.');
      case 'REJECTED':
      default:
        if (error.status === 403) {
          // The grant can read but not write: every record would fail the same way. Pause the account, say what to fix.
          const scopes = adapter.writeBack?.writeScopes.join(', ') ?? 'write access';
          const message = `${providerName} refused to save changes: this connection has no write access. Add the ${scopes} scope to the ${providerName} integration in Nango, then reconnect this account.`;
          await this.prisma.integrationConnection.update({
            where: { id: connection.id },
            data: { writeBackError: message.slice(0, 500), writeBackErrorAt: new Date() },
          });
          this.audit.quietly({
            orgId: connection.orgId,
            actorType: 'system',
            action: 'integration.write_back_paused',
            entityType: 'integration_connection',
            entityId: connection.id,
            payload: { provider: connection.provider, status: 403 },
          });
          return 'refused';
        }
        if (error.status === 404) return refuse(`This ${providerName} record no longer exists, so changes stay in EstatePulse.`);
        return refuse(`${providerName} did not accept the new values (HTTP ${error.status}). Check the field types in ${providerName}.`);
    }
  }
}
