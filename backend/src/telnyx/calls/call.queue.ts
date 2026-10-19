import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { sha256Hex } from '@/common/utils/crypto';
import { CALL_QUEUE, CallJob } from '@/queue/queue.constants';
import type { CallJobData, EnqueueCallOptions } from './call.types';

const ENQUEUE_TIMEOUT_MS = 5_000;

@Injectable()
export class CallQueue {
  constructor(@InjectQueue(CALL_QUEUE) private readonly queue: Queue<CallJobData>) {}

  async enqueue(data: CallJobData, options: EnqueueCallOptions): Promise<string> {
    const add = this.queue.add(CallJob.Dial, data, { jobId: `call-${sha256Hex(options.dedupeKey).slice(0, 40)}` });
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
