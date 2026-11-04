import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import type { QueueEnv } from '@/common/utils/interface';
import { SMS_REPLY_QUEUE } from '@/queue/queue.constants';
import { SmsAgentService, type SmsReplyJobData } from './sms-agent.service';

/** Replies to different leads written at once on one instance; one lead's texts are kept in order by the jobs themselves. */
const CONCURRENCY = 5;

/**
 * Writes the AI's reply to a lead's text when the organization's replies come
 * from this server. Each job is tried once (a turn may already have booked or
 * scheduled something); SmsAgentService flags the lead for a person when it
 * cannot answer. Runs on the instances that run the call worker.
 */
@Processor(SMS_REPLY_QUEUE, { autorun: false, concurrency: CONCURRENCY })
export class SmsReplyWorker extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(SmsReplyWorker.name);

  constructor(
    private readonly config: ConfigService<QueueEnv, true>,
    private readonly agent: SmsAgentService,
  ) {
    super();
  }

  onApplicationBootstrap(): void {
    if (!this.config.get('CALL_WORKER_ENABLED', { infer: true })) {
      this.logger.log('SMS reply worker is off on this instance (CALL_WORKER_ENABLED=false)');
      return;
    }
    void this.worker.run().catch((error) => this.logger.error(`SMS reply worker stopped: ${(error as Error).message}`));
    this.logger.log('SMS reply worker started');
  }

  async process(job: Job<SmsReplyJobData>): Promise<void> {
    const started = Date.now();
    try {
      const outcome = await this.agent.answer(job.data);
      this.logger.log(`lead ${job.data.leadId}: AI reply ${outcome} (${Date.now() - started} ms)`);
    } catch (error) {
      // Not thrown on: the job is tried once, and whatever was done must not be done again.
      this.logger.error(`lead ${job.data.leadId}: AI reply crashed: ${(error as Error).message}`);
    }
  }
}
