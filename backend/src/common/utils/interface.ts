export type MailProvider = 'smtp' | 'resend' | 'ses';

export interface MailEnv {
  MAIL_PROVIDER?: MailProvider;
  MAIL_FROM?: string;
  SMTP_HOST?: string;
  SMTP_PORT: number;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  SMTP_SECURE: boolean;
  RESEND_API_KEY?: string;
  AWS_SES_REGION?: string;
  AWS_SES_ACCESS_KEY_ID?: string;
  AWS_SES_SECRET_ACCESS_KEY?: string;
  AWS_SES_CONFIGURATION_SET?: string;
}

export interface AppEnv {
  /** The frontend's address, for links in emails. */
  APP_URL?: string;
}

export interface AuthEnv {
  NODE_ENV: 'development' | 'test' | 'production';
  JWT_ACCESS_SECRET: string;
  JWT_REFRESH_SECRET: string;
  JWT_ACCESS_EXPIRES_IN_SECONDS: number;
  REFRESH_TOKEN_EXPIRES_IN_SECONDS: number;
  REFRESH_TOKEN_KEEP_SIGNED_IN_EXPIRES_IN_SECONDS: number;
  COOKIE_SECURE: boolean;
  EMAIL_VERIFICATION_REQUIRED: boolean;
}

export interface IntegrationEnv {
  APP_URL?: string;
  INTEGRATION_ENCRYPTION_KEY?: string;
  CALENDAR_WEBHOOK_BASE_URL?: string;
  PUBLIC_API_URL?: string;
  STRATEGY_ENGINE: boolean;
  ENGINE_POLL_MS: number;
  AI_OPENING_WAIT_MS: number;
  STRATEGY_STALE_MS: number;
  FOLLOWUP_POLL_MS: number;
  FOLLOWUP_BATCH_SIZE: number;
  FOLLOWUP_STUCK_AFTER_MS: number;
  OUTREACH_SCHEDULING_ENABLED: boolean;
  OUTREACH_POLL_MS: number;
  NODE_ENV: 'development' | 'test' | 'production';
}

export interface QueueEnv {
  REDIS_URL: string;
  QUEUE_PREFIX: string;
  EMAIL_WORKER_ENABLED: boolean;
  EMAIL_WORKER_CONCURRENCY: number;
  CALL_WORKER_ENABLED: boolean;
  CALL_WORKER_CONCURRENCY: number;
  CALL_SLOT_TTL_MS: number;
}

export interface DailySummaryEnv {
  DAILY_SUMMARY_ENABLED: boolean;
  /** How long after its send time a summary the server missed (it was down) is still sent. */
  DAILY_SUMMARY_CATCH_UP_HOURS: number;
  DAILY_SUMMARY_POLL_MS: number;
  APP_URL?: string;
}
