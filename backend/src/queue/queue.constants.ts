import { sha256Hex } from '@/common/utils/crypto';

export const QUEUE_PREFIX = 'estatepulse';

export const EMAIL_QUEUE = 'email';

export const EmailJob = {
  Send: 'send',
} as const;

export const CALL_QUEUE = 'call';

/** The call job's id for a dedupe key: one job per key, so a retried step never dials twice. */
export const callJobId = (dedupeKey: string) => `call-${sha256Hex(dedupeKey).slice(0, 40)}`;

export const CallJob = {
  Dial: 'dial',
} as const;
