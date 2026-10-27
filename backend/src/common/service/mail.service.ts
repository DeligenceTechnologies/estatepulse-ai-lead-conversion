import {
  GetAccountCommand,
  LimitExceededException,
  SESv2Client,
  type SESv2ClientConfig,
  SESv2ServiceException,
  SendEmailCommand,
  TooManyRequestsException,
} from '@aws-sdk/client-sesv2';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import type { MailEnv, MailProvider } from '@/common/utils/interface';

export interface SendMailInput {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  idempotencyKey?: string;
}

const RESEND_API_URL = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 30_000;
const SES_CONNECT_TIMEOUT_MS = 5_000;

const SES_PERMANENT_CLIENT_ERRORS = new Set(['CredentialsProviderError', 'InvalidSignatureException', 'UnrecognizedClientException']);

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
export class MailService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MailService.name);
  private readonly provider?: MailProvider;
  private readonly from?: string;
  private readonly smtpTransport?: Transporter;
  private readonly resendApiKey?: string;
  private readonly sesClient?: SESv2Client;
  private readonly sesConfigurationSet?: string;

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

    if (this.provider === 'ses') {
      const accessKeyId = config.get('AWS_SES_ACCESS_KEY_ID', { infer: true });
      const secretAccessKey = config.get('AWS_SES_SECRET_ACCESS_KEY', { infer: true });

      const sesConfig: SESv2ClientConfig = {
        region: config.getOrThrow('AWS_SES_REGION', { infer: true }),
        maxAttempts: 3,
        requestHandler: new NodeHttpHandler({ connectionTimeout: SES_CONNECT_TIMEOUT_MS, requestTimeout: SEND_TIMEOUT_MS }),
      };
      if (accessKeyId && secretAccessKey) {
        sesConfig.credentials = { accessKeyId, secretAccessKey };
      }

      this.sesClient = new SESv2Client(sesConfig);
      this.sesConfigurationSet = config.get('AWS_SES_CONFIGURATION_SET', { infer: true });
    }

    this.logger.log(this.provider ? `Mail provider: ${this.provider}` : 'Mail is disabled (MAIL_PROVIDER not set)');
  }

  onModuleInit(): void {
    if (this.sesClient) void this.checkSesAccount(this.sesClient);
  }

  onModuleDestroy(): void {
    this.smtpTransport?.close();
    this.sesClient?.destroy();
  }

  get enabled(): boolean {
    return this.provider !== undefined;
  }

  private async checkSesAccount(client: SESv2Client): Promise<void> {
    try {
      const account = await client.send(new GetAccountCommand({}), { abortSignal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
      if (!account.SendingEnabled) {
        this.logger.error('SES sending is paused for this account; no email will be delivered');
      } else if (!account.ProductionAccessEnabled) {
        this.logger.warn('SES account is in the sandbox: email is delivered only to verified addresses');
      } else {
        const quota = account.SendQuota;
        this.logger.log(`SES ready (max ${quota?.MaxSendRate ?? '?'}/s, ${quota?.Max24HourSend ?? '?'} per 24h)`);
      }
    } catch (error) {
      this.logger.warn(`Could not read the SES account status: ${(error as Error).message}`);
    }
  }

  async send(mail: SendMailInput): Promise<void> {
    switch (this.provider) {
      case 'smtp':
        return this.sendWithSmtp(mail);
      case 'resend':
        return this.sendWithResend(mail);
      case 'ses':
        return this.sendWithSes(mail);
      default:
        throw new Error('Mail is not configured: set MAIL_PROVIDER to "smtp", "resend" or "ses"');
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

  private async sendWithSes(mail: SendMailInput): Promise<void> {
    if (!this.sesClient) {
      throw new Error('SES client is not initialised');
    }

    const command = new SendEmailCommand({
      FromEmailAddress: this.from,
      Destination: { ToAddresses: Array.isArray(mail.to) ? mail.to : [mail.to] },
      Content: {
        Simple: {
          Subject: { Data: mail.subject, Charset: 'UTF-8' },
          Body: {
            Html: { Data: mail.html, Charset: 'UTF-8' },
            ...(mail.text ? { Text: { Data: mail.text, Charset: 'UTF-8' } } : {}),
          },
        },
      },
      ...(this.sesConfigurationSet ? { ConfigurationSetName: this.sesConfigurationSet } : {}),
    });

    try {
      await this.sesClient.send(command, { abortSignal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
    } catch (error) {
      throw new MailDeliveryError(`SES failed: ${(error as Error).name}: ${(error as Error).message}`, isPermanentSesError(error));
    }
  }
}

function isPermanentSesError(error: unknown): boolean {
  if (error instanceof TooManyRequestsException || error instanceof LimitExceededException) return false;
  if (error instanceof SESv2ServiceException) {
    const status = error.$metadata.httpStatusCode;
    return status !== undefined && status >= 400 && status < 500 && status !== 408;
  }
  return error instanceof Error && SES_PERMANENT_CLIENT_ERRORS.has(error.name);
}
