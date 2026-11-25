import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { NangoWebhookEventStatus, Prisma } from '@prisma/client';
import type { Queue } from 'bullmq';
import { PrismaService } from '@/common/prisma/prisma.service';
import { sha256Hex } from '@/common/utils/crypto';
import { NANGO_QUEUE, NANGO_TAG, NangoJob, RECONCILE_DELAY_MS, type NangoIntegration } from './nango.constants';
import { NangoConnectionRegistry } from './nango-connection.registry';
import { NangoService } from './nango.service';

const ENQUEUE_TIMEOUT_MS = 5_000;
const MAX_ERROR = 500;

export type NangoWebhookResult = 'accepted' | 'duplicate' | 'ignored' | 'invalid_signature' | 'invalid_payload' | 'not_configured';

export interface NangoWebhookJobData {
  eventId: string;
  /** From the webhook's tags; needed to finish a connection, not worth a column. */
  organizationId: string | null;
  userId: string | null;
}

export interface NangoReconcileJobData {
  integration: NangoIntegration;
  connectionId: string;
  organizationId: string;
  userId: string;
}

/** The fields of an auth webhook this app acts on. Nothing else from the body is kept. */
interface AuthWebhook {
  type: 'auth';
  operation: string;
  connectionId: string;
  providerConfigKey: string;
  success: boolean;
  organizationId: string | null;
  userId: string | null;
}

/**
 * Nango's webhooks: verified, recorded once, then handed to the nango queue.
 * The request only stores and enqueues, so it answers well inside Nango's
 * 20-second timeout; the provider work happens in NangoWebhookWorker.
 * Forwarded provider webhooks (HubSpot's) go to that provider's handler.
 */
@Injectable()
export class NangoWebhookService {
  private readonly logger = new Logger('NangoWebhook');

  constructor(
    private readonly prisma: PrismaService,
    private readonly nango: NangoService,
    private readonly registry: NangoConnectionRegistry,
    @InjectQueue(NANGO_QUEUE) private readonly queue: Queue,
  ) {}

  async receive(rawBody: Buffer, headers: Record<string, unknown>): Promise<NangoWebhookResult> {
    if (!this.nango.webhooksConfigured) return 'not_configured';
    const text = rawBody.toString('utf8');
    if (!this.nango.verifyWebhook(text, headers)) return 'invalid_signature';

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return 'invalid_payload';
    }
    const type = readString(body, 'type');
    if (!type) return 'invalid_payload';

    const auth = type === 'auth' ? readAuth(body) : null;
    if (type === 'auth' && !auth) return 'invalid_payload';

    const dedupeKey = sha256Hex(text);
    if (type === 'forward') return this.forward(body, dedupeKey);
    const data = {
      dedupeKey,
      type: type.slice(0, 30),
      operation: auth?.operation.slice(0, 30) ?? null,
      providerConfigKey: (auth?.providerConfigKey ?? readString(body, 'providerConfigKey'))?.slice(0, 255) ?? null,
      connectionId: (auth?.connectionId ?? readString(body, 'connectionId'))?.slice(0, 255) ?? null,
      success: auth?.success ?? null,
    };

    // Syncs and async actions are not used by this app.
    if (!auth) {
      await this.prisma.nangoWebhookEvent.createMany({
        data: [{ ...data, status: NangoWebhookEventStatus.ignored, processedAt: new Date() }],
        skipDuplicates: true,
      });
      return 'ignored';
    }

    let event: { id: string; status: NangoWebhookEventStatus };
    try {
      event = await this.prisma.nangoWebhookEvent.create({ data, select: { id: true, status: true } });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
      const existing = await this.prisma.nangoWebhookEvent.findUnique({ where: { dedupeKey }, select: { id: true, status: true } });
      if (!existing) throw error;
      // Seen before. Only one that never reached the queue is enqueued again (the job id dedupes it there).
      if (existing.status !== NangoWebhookEventStatus.received) return 'duplicate';
      event = existing;
    }

    await this.enqueue(
      NangoJob.Webhook,
      { eventId: event.id, organizationId: auth.organizationId, userId: auth.userId } satisfies NangoWebhookJobData,
      { jobId: `webhook-${event.id}` },
    );
    return event.status === NangoWebhookEventStatus.received ? 'accepted' : 'duplicate';
  }

  /** Runs one stored event. Throws to let BullMQ retry; the row records every failure. */
  async process({ eventId, ...tags }: NangoWebhookJobData): Promise<void> {
    const event = await this.prisma.nangoWebhookEvent.update({
      where: { id: eventId },
      data: { attempts: { increment: 1 } },
    });
    if (event.status === NangoWebhookEventStatus.processed || event.status === NangoWebhookEventStatus.ignored) return;

    const integration = event.providerConfigKey ? this.nango.integrationOf(event.providerConfigKey) : null;
    const handler = integration ? this.registry.get(integration) : null;
    if (!integration || !handler || !event.connectionId) {
      await this.finish(eventId, NangoWebhookEventStatus.ignored, null);
      return;
    }

    // An API key cached from before a re-authorization or deletion must not be used again.
    if (event.operation === 'override' || event.operation === 'deletion') this.nango.forget(event.connectionId);

    try {
      switch (event.operation) {
        case 'creation':
        case 'override':
          if (!event.success) {
            this.logger.warn(`Nango reported a failed ${integration} ${event.operation} for connection ${event.connectionId}`);
            break;
          }
          if (!tags.organizationId || !tags.userId) {
            this.logger.warn(`Nango ${integration} connection ${event.connectionId} carries no organization tags; it was not created by this app`);
            break;
          }
          await this.enqueue(
            NangoJob.Reconcile,
            {
              integration,
              connectionId: event.connectionId,
              organizationId: tags.organizationId,
              userId: tags.userId,
            } satisfies NangoReconcileJobData,
            { jobId: `reconcile-${eventId}`, delay: RECONCILE_DELAY_MS },
          );
          break;
        case 'refresh':
          if (event.success) await handler.refreshRecovered(event.connectionId);
          else await handler.refreshFailed(event.connectionId);
          break;
        case 'deletion':
          await handler.deleted(event.connectionId);
          break;
        default:
          await this.finish(eventId, NangoWebhookEventStatus.ignored, null);
          return;
      }
      await this.finish(eventId, NangoWebhookEventStatus.processed, null);
    } catch (error) {
      await this.finish(eventId, NangoWebhookEventStatus.failed, (error as Error).message);
      throw error;
    }
  }

  /** A connection the browser never reported back, finished from the webhook. */
  async reconcile(job: NangoReconcileJobData): Promise<void> {
    const handler = this.registry.get(job.integration);
    if (!handler) return;
    // The person who connected may have left the organization since.
    const member = await this.prisma.user.findFirst({ where: { id: job.userId, orgId: job.organizationId }, select: { id: true } });
    if (!member) {
      this.logger.warn(`Not finishing ${job.integration} connection ${job.connectionId}: its user is no longer in the organization`);
      return;
    }
    await handler.reconcile({ organizationId: job.organizationId, userId: job.userId, connectionId: job.connectionId });
  }

  /**
   * A provider's own webhook, which Nango verified against the provider's
   * signature and forwarded. Handled inline (the handlers only record events
   * for their own queues) and recorded once, so a redelivery is not taken twice.
   */
  private async forward(body: unknown, dedupeKey: string): Promise<NangoWebhookResult> {
    const providerConfigKey = readString(body, 'providerConfigKey');
    const integration = providerConfigKey ? this.nango.integrationOf(providerConfigKey) : null;
    const handler = integration ? this.registry.forward(integration) : null;
    const record = {
      dedupeKey,
      type: 'forward',
      operation: null,
      providerConfigKey: providerConfigKey?.slice(0, 255) ?? null,
      connectionId: readString(body, 'connectionId')?.slice(0, 255) ?? null,
      success: null,
    };
    if (!handler) {
      await this.prisma.nangoWebhookEvent.createMany({
        data: [{ ...record, status: NangoWebhookEventStatus.ignored, processedAt: new Date() }],
        skipDuplicates: true,
      });
      return 'ignored';
    }
    const seen = await this.prisma.nangoWebhookEvent.findUnique({ where: { dedupeKey }, select: { status: true } });
    if (seen?.status === NangoWebhookEventStatus.processed) return 'duplicate';

    await handler({ connectionId: record.connectionId, payload: (body as { payload?: unknown }).payload ?? null });
    await this.prisma.nangoWebhookEvent.upsert({
      where: { dedupeKey },
      create: { ...record, status: NangoWebhookEventStatus.processed, attempts: 1, processedAt: new Date() },
      update: { status: NangoWebhookEventStatus.processed, attempts: { increment: 1 }, processedAt: new Date(), error: null },
    });
    return 'accepted';
  }

  private async finish(eventId: string, status: NangoWebhookEventStatus, error: string | null): Promise<void> {
    await this.prisma.nangoWebhookEvent.update({
      where: { id: eventId },
      data: { status, error: error ? error.slice(0, MAX_ERROR) : null, processedAt: status === NangoWebhookEventStatus.failed ? null : new Date() },
    });
  }

  private async enqueue(
    name: string,
    data: NangoWebhookJobData | NangoReconcileJobData,
    opts: { jobId: string; delay?: number },
  ): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('The nango queue is unavailable')), ENQUEUE_TIMEOUT_MS);
    });
    try {
      await Promise.race([this.queue.add(name, data, opts), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}

function readString(body: unknown, key: string): string | null {
  if (!body || typeof body !== 'object') return null;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' && value ? value : null;
}

function readAuth(body: unknown): AuthWebhook | null {
  const operation = readString(body, 'operation');
  const connectionId = readString(body, 'connectionId');
  const providerConfigKey = readString(body, 'providerConfigKey');
  const success = (body as Record<string, unknown>).success;
  if (!operation || !connectionId || !providerConfigKey || typeof success !== 'boolean') return null;
  const tags = (body as { tags?: unknown }).tags;
  const tag = (key: string): string | null => {
    if (!tags || typeof tags !== 'object') return null;
    const value = (tags as Record<string, unknown>)[key];
    return typeof value === 'string' && value ? value : null;
  };
  return {
    type: 'auth',
    operation,
    connectionId,
    providerConfigKey,
    success,
    organizationId: tag(NANGO_TAG.organizationId),
    userId: tag(NANGO_TAG.userId),
  };
}
