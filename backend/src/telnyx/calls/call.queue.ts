import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { CALL_QUEUE, CallJob, callJobId } from '@/queue/queue.constants';
import type { CallJobData, EnqueueCallOptions } from './call.types';

const ENQUEUE_TIMEOUT_MS = 5_000;

@Injectable()
export class CallQueue {
  constructor(@InjectQueue(CALL_QUEUE) private readonly queue: Queue<CallJobData>) {}

  async enqueue(data: CallJobData, options: EnqueueCallOptions): Promise<string> {
    const add = this.queue.add(CallJob.Dial, data, { jobId: callJobId(options.dedupeKey) });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ServiceUnavailableException('The call queue is unavailable')), ENQUEUE_TIMEOUT_MS);
    });
    try {
      const job = await Promise.race([add, timeout]);
      return job.id!;
    } finally {
      clearTimeout(timer);
    }
  }
}
