import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UnrecoverableError, type Job } from 'bullmq';
import { MailDeliveryError, MailService } from '@/common/service/mail.service';
import type { QueueEnv } from '@/common/utils/interface';
import { EMAIL_QUEUE, EmailJob } from '../queue.constants';
import type { EmailJobData } from './email.types';


@Processor(EMAIL_QUEUE, { autorun: false, limiter: { max: 10, duration: 1_000 } })
export class EmailWorker extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(EmailWorker.name);

  constructor(
    private readonly mail: MailService,
    private readonly config: ConfigService<QueueEnv, true>,
  ) {
    super();
  }

  onApplicationBootstrap(): void {
    if (!this.config.get('EMAIL_WORKER_ENABLED', { infer: true })) {
      this.logger.log('Email worker is off on this instance (EMAIL_WORKER_ENABLED=false)');
      return;
    }
    this.worker.concurrency = this.config.get('EMAIL_WORKER_CONCURRENCY', { infer: true });
    void this.worker.run().catch((error) => this.logger.error(`Email worker stopped: ${(error as Error).message}`));
    this.logger.log(`Email worker started (concurrency ${this.worker.concurrency})`);
  }

  async process(job: Job<EmailJobData>): Promise<void> {
    if (job.name !== EmailJob.Send) throw new UnrecoverableError(`Unknown email job "${job.name}"`);
    if (!this.mail.enabled) throw new Error('Email is not configured on the server');

    const { kind: _kind, ...message } = job.data;
    try {
      await this.mail.send({ ...message, idempotencyKey: `${job.queueName}-${job.id}` });
    } catch (error) {
      if (error instanceof MailDeliveryError && error.permanent) throw new UnrecoverableError(error.message);
      throw error;
    }
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<EmailJobData>): void {
    this.logger.log(`Sent ${job.data.kind} email (job ${job.id}, attempt ${job.attemptsMade})`);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<EmailJobData> | undefined, error: Error): void {
    if (!job) return;
    const final = error instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1);
    const message = `${job.data.kind} email (job ${job.id}) failed on attempt ${job.attemptsMade}: ${error.message}`;
    if (final) this.logger.error(`${message}; giving up`);
    else this.logger.warn(`${message}; will retry`);
  }

  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.error(`Email worker error: ${error.message}`);
  }
}
