import type { SendMailInput } from '@/common/service/mail.service';

export type EmailJobData = Omit<SendMailInput, 'idempotencyKey'> & {
  kind: string;
};

export interface EnqueueEmailOptions {
  dedupeKey?: string;
  delayMs?: number;
  sensitive?: boolean;
}
