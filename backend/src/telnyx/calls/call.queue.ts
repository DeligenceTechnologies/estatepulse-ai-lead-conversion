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
    return this.add(data, options.dedupeKey, 0);
  }

  /** A call at a set time (a callback). Kept in Redis, so it survives a restart. */
  async schedule(data: CallJobData, at: Date, dedupeKey: string): Promise<string> {
    return this.add(data, dedupeKey, Math.max(0, at.getTime() - Date.now()));
  }

  private async add(data: CallJobData, dedupeKey: string, delay: number): Promise<string> {
    const add = this.queue.add(CallJob.Dial, data, { jobId: `call-${sha256Hex(dedupeKey).slice(0, 40)}`, ...(delay ? { delay } : {}) });
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
