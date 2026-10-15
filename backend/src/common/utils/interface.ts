export type MailProvider = 'smtp' | 'resend';

export interface MailEnv {
  MAIL_PROVIDER?: MailProvider;
  MAIL_FROM?: string;
  SMTP_HOST?: string;
  SMTP_PORT: number;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  SMTP_SECURE: boolean;
  RESEND_API_KEY?: string;
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
}

export interface IntegrationEnv {
  APP_URL?: string;
  INTEGRATION_ENCRYPTION_KEY?: string;
  CALENDLY_CLIENT_ID?: string;
  CALENDLY_CLIENT_SECRET?: string;
  CALENDLY_REDIRECT_URI?: string;
  CALENDLY_SCOPES?: string;
  CALENDAR_WEBHOOK_BASE_URL?: string;
  PUBLIC_API_URL?: string;
  ALLOW_INSECURE_INGEST_URL: boolean;
  INGEST_MAX_BODY_BYTES: number;
  TALLY_API_BASE_URL: string;
  PROVIDER_HTTP_TIMEOUT_MS: number;
  WORKER_ENABLED: boolean;
  WORKER_POLL_INTERVAL_MS: number;
  WORKER_MAX_POLL_INTERVAL_MS: number;
  WORKER_BATCH_SIZE: number;
  WORKER_STUCK_AFTER_MS: number;
  STRATEGY_ENGINE: boolean;
  ENGINE_POLL_MS: number;
  STRATEGY_STALE_MS: number;
  FOLLOWUP_POLL_MS: number;
  FOLLOWUP_BATCH_SIZE: number;
  FOLLOWUP_STUCK_AFTER_MS: number;
  GOOGLE_SHEETS_ENABLED: boolean;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
  GOOGLE_PICKER_API_KEY?: string;
  GOOGLE_APP_ID?: string;
  SHEETS_SYNC: boolean;
  SHEETS_POLL_MS: number;
  SHEETS_SYNC_INTERVAL_MS: number;
  SHEETS_VERSION_PROBE: boolean;
  SHEETS_FULL_READ_MAX_AGE_MS: number;
  FILE_IMPORT_ENABLED: boolean;
  FILE_IMPORT_MAX_BYTES: number;
  NODE_ENV: 'development' | 'test' | 'production';
}

export interface QueueEnv {
  REDIS_URL: string;
  EMAIL_WORKER_ENABLED: boolean;
  EMAIL_WORKER_CONCURRENCY: number;
}
