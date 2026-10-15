import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import type { MailEnv, MailProvider } from '@/common/utils/interface';

export interface SendMailInput {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  /** Makes a retried send of the same message a no-op where the provider supports it (Resend). */
  idempotencyKey?: string;
}

const RESEND_API_URL = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 30_000;

/** A send that failed. `permanent` means retrying the same message cannot succeed (bad address, rejected content, bad credentials). */
export class MailDeliveryError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = 'MailDeliveryError';
  }
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly provider?: MailProvider;
  private readonly from?: string;
  private readonly smtpTransport?: Transporter;
  private readonly resendApiKey?: string;

  constructor(config: ConfigService<MailEnv, true>) {
    this.provider = config.get('MAIL_PROVIDER', { infer: true });
    this.from = config.get('MAIL_FROM', { infer: true });

    if (this.provider === 'smtp') {
      const port = config.get('SMTP_PORT', { infer: true });
      const user = config.get('SMTP_USER', { infer: true });
      const pass = config.get('SMTP_PASS', { infer: true });

      this.smtpTransport = createTransport({
        host: config.getOrThrow('SMTP_HOST', { infer: true }),
        port,
        secure: config.get('SMTP_SECURE', { infer: true }) || port === 465,
        ...(user && pass ? { auth: { user, pass } } : {}),
        pool: true,
        connectionTimeout: SEND_TIMEOUT_MS,
        greetingTimeout: SEND_TIMEOUT_MS,
        socketTimeout: SEND_TIMEOUT_MS,
      });
    }

    if (this.provider === 'resend') {
      this.resendApiKey = config.getOrThrow('RESEND_API_KEY', { infer: true });
    }

    this.logger.log(this.provider ? `Mail provider: ${this.provider}` : 'Mail is disabled (MAIL_PROVIDER not set)');
  }

  get enabled(): boolean {
    return this.provider !== undefined;
  }

  async send(mail: SendMailInput): Promise<void> {
    switch (this.provider) {
      case 'smtp':
        return this.sendWithSmtp(mail);
      case 'resend':
        return this.sendWithResend(mail);
      default:
        throw new Error('Mail is not configured: set MAIL_PROVIDER to "smtp" or "resend"');
    }
  }

  private async sendWithSmtp(mail: SendMailInput): Promise<void> {
    if (!this.smtpTransport) {
      throw new Error('SMTP transport is not initialised');
    }

    try {
      await this.smtpTransport.sendMail({
        from: this.from,
        to: mail.to,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
      });
    } catch (error) {
      const { message, responseCode, code } = error as { message: string; responseCode?: number; code?: string };
      const permanent = (responseCode !== undefined && responseCode >= 500) || code === 'EENVELOPE' || code === 'EAUTH';
      throw new MailDeliveryError(`SMTP failed: ${message}`, permanent);
    }
  }

  private async sendWithResend(mail: SendMailInput): Promise<void> {
    let response: Response;
    try {
      response = await fetch(RESEND_API_URL, {
        method: 'POST',
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${this.resendApiKey}`,
          'Content-Type': 'application/json',
          ...(mail.idempotencyKey ? { 'Idempotency-Key': mail.idempotencyKey } : {}),
        },
        body: JSON.stringify({
          from: this.from,
          to: mail.to,
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
        }),
      });
    } catch (error) {
      throw new MailDeliveryError(`Resend unreachable: ${(error as Error).message}`, false);
    }

    if (!response.ok) {
      const body = (await response.text()).slice(0, 500);
      const permanent = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429;
      throw new MailDeliveryError(`Resend failed with ${response.status}: ${body}`, permanent);
    }
  }
}
