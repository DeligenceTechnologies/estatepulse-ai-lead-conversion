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
