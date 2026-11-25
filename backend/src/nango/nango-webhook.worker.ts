import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import { NANGO_QUEUE, NangoJob } from './nango.constants';
import { NangoWebhookService, type NangoReconcileJobData, type NangoWebhookJobData } from './nango-webhook.service';

/** Applies Nango webhook events off the request path, with BullMQ's retries and backoff. */
@Processor(NANGO_QUEUE, { autorun: false })
export class NangoWebhookWorker extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger('NangoWebhookWorker');

  constructor(private readonly webhooks: NangoWebhookService) {
    super();
  }

  onApplicationBootstrap(): void {
    this.worker.concurrency = 5;
    void this.worker.run().catch((error) => this.logger.error(`Nango worker stopped: ${(error as Error).message}`));
  }

  async process(job: Job<NangoWebhookJobData | NangoReconcileJobData>): Promise<void> {
    switch (job.name) {
      case NangoJob.Webhook:
        return this.webhooks.process(job.data as NangoWebhookJobData);
      case NangoJob.Reconcile:
        return this.webhooks.reconcile(job.data as NangoReconcileJobData);
      default:
        throw new UnrecoverableError(`Unknown nango job "${job.name}"`);
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error): void {
    if (!job) return;
    const final = error instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1);
    const message = `Nango ${job.name} job ${job.id} failed on attempt ${job.attemptsMade}: ${error.message}`;
    if (final) this.logger.error(`${message}; giving up`);
    else this.logger.warn(`${message}; will retry`);
  }

  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.error(`Nango worker error: ${error.message}`);
  }
}
