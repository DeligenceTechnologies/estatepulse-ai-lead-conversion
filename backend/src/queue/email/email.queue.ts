import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { MailService } from '@/common/service/mail.service';
import { sha256Hex } from '@/common/utils/crypto';
import { EMAIL_QUEUE, EmailJob } from '../queue.constants';
import type { EmailJobData, EnqueueEmailOptions } from './email.types';

const ENQUEUE_TIMEOUT_MS = 5_000;

/** Puts emails on the queue; the EmailWorker sends them. Request handlers never wait on the mail provider. */
@Injectable()
export class EmailQueue {
  constructor(
    @InjectQueue(EMAIL_QUEUE) private readonly queue: Queue<EmailJobData>,
    private readonly mail: MailService,
  ) {}

  async enqueue(data: EmailJobData, options: EnqueueEmailOptions = {}): Promise<string> {
    if (!this.mail.enabled) throw new ServiceUnavailableException('Email is not configured on the server');

    const add = this.queue.add(EmailJob.Send, data, {
      ...(options.dedupeKey ? { jobId: `email-${sha256Hex(options.dedupeKey).slice(0, 40)}` } : {}),
      ...(options.delayMs ? { delay: options.delayMs } : {}),
      ...(options.sensitive ? { removeOnComplete: true, removeOnFail: { age: 60 * 60 } } : {}),
    });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ServiceUnavailableException('The email queue is unavailable')), ENQUEUE_TIMEOUT_MS);
    });
    try {
      const job = await Promise.race([add, timeout]);
      return job.id!;
    } finally {
      clearTimeout(timer);
    }
  }
}
