import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import type { MailEnv, MailProvider } from '@/common/utils/interface';

export interface SendMailInput {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
}

const RESEND_API_URL = 'https://api.resend.com/emails';

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

    await this.smtpTransport.sendMail({
      from: this.from,
      to: mail.to,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });
  }

  private async sendWithResend(mail: SendMailInput): Promise<void> {
    const response = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: mail.to,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Resend failed with ${response.status}: ${body}`);
    }
  }
}
