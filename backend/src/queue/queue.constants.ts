export const EMAIL_QUEUE = 'email';

export const EmailJob = {
  Send: 'send',
} as const;

export const CALL_QUEUE = 'call';

export const CallJob = {
  Dial: 'dial',
} as const;

export const TEXT_QUEUE = 'text';

export const TextJob = {
  /** A text the lead asked for at a set time ("message me in 10 minutes"). */
  TextBack: 'text-back',
} as const;

export const SMS_REPLY_QUEUE = 'sms-reply';

export const SmsReplyJob = {
  /** The AI's answer to a lead's text, written by this server (sms-agent) when the organization's replies come from it. */
  Reply: 'reply',
} as const;
