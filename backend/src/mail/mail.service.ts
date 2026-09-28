import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { type Transporter } from 'nodemailer';

/**
 * Whether a message actually went out, and if not, why.
 *
 * Returned rather than thrown. Every caller so far sends mail *after* a write
 * has already committed, so a dead SMTP server must not turn a completed
 * action into an error — but the caller still has to know, because the
 * fallback is a human passing the information on by hand.
 */
export interface MailResult {
  sent: boolean;
  /** Present only when `sent` is false. Safe to show an owner; never an SMTP dump. */
  reason?: string;
}

interface AgentWelcome {
  to: string;
  firstName: string | null;
  organizationName: string;
  /** The password the owner chose. Logged nowhere, stored nowhere. */
  password: string;
  signInUrl: string | null;
}

/**
 * Outbound email, over SMTP.
 *
 * Disabled unless SMTP_HOST is set, and that is the normal state: development,
 * CI and the integration suites all run without it. Disabled means every send
 * is a no-op that reports `sent: false` with a reason — never a throw, and
 * never a silent success that makes a screen claim an email was delivered.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly from: string;
  private readonly transporter: Transporter | null;

  constructor(private readonly config: ConfigService) {
    const host = this.config.get<string>('SMTP_HOST');

    if (!host) {
      this.transporter = null;
      this.from = '';
      this.logger.log('SMTP not configured (no SMTP_HOST) — email sending is disabled');
      return;
    }

    const port = Number(this.config.get<string>('SMTP_PORT') ?? 587);
    const user = this.config.get<string>('SMTP_USER');
    const pass = this.config.get<string>('SMTP_PASS');

    this.from = this.config.get<string>('SMTP_FROM') ?? user ?? '';
    this.transporter = nodemailer.createTransport({
      host,
      port,
      // 465 is implicit TLS; everything else starts plain and upgrades with
      // STARTTLS. Overridable because some providers do neither by default.
      secure: this.config.get<string>('SMTP_SECURE') === 'true' || port === 465,
      // Omitted entirely when absent: passing `auth: { user: undefined }` makes
      // nodemailer attempt an AUTH the server may not offer.
      ...(user && pass ? { auth: { user, pass } } : {}),
    });

    this.logger.log(`SMTP configured for ${host}:${port}`);
  }

  /** True when a transporter exists. Lets a caller tell "off" from "failed". */
  get enabled(): boolean {
    return this.transporter !== null;
  }

  /**
   * The credentials an owner just set for a new agent.
   *
   * NOTE ON THE CONTENT: this mails a password in plaintext, because that is
   * what was asked for and it replaces the owner reading it out over the phone.
   * It is still a lasting credential sitting in an inbox. A one-time set-password
   * link would remove that, and is the natural follow-up once there is a token
   * table to hang it on.
   */
  async sendAgentWelcome(input: AgentWelcome): Promise<MailResult> {
    if (!this.transporter) {
      return { sent: false, reason: 'Email is not configured on this server' };
    }

    const greeting = input.firstName ? `Hi ${input.firstName},` : 'Hi,';
    const signIn = input.signInUrl ? `\nSign in: ${input.signInUrl}\n` : '';

    try {
      await this.transporter.sendMail({
        from: this.from,
        to: input.to,
        subject: `Your EstatePulse account for ${input.organizationName}`,
        text:
          `${greeting}\n\n` +
          `An account has been created for you at ${input.organizationName} on EstatePulse.\n` +
          `${signIn}\n` +
          `Email:    ${input.to}\n` +
          `Password: ${input.password}\n\n` +
          `Please keep this password somewhere safe — it is not shown again.\n`,
        html:
          `<p>${escapeHtml(greeting)}</p>` +
          `<p>An account has been created for you at <strong>${escapeHtml(input.organizationName)}</strong> on EstatePulse.</p>` +
          (input.signInUrl
            ? `<p><a href="${escapeHtml(input.signInUrl)}">Sign in</a></p>`
            : '') +
          `<p>Email: <strong>${escapeHtml(input.to)}</strong><br/>` +
          `Password: <strong>${escapeHtml(input.password)}</strong></p>` +
          `<p>Please keep this password somewhere safe — it is not shown again.</p>`,
      });

      // The address is enough to trace a delivery; the password is not logged
      // here or anywhere else.
      this.logger.log(`agent welcome email sent to ${input.to}`);
      return { sent: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      this.logger.error(`agent welcome email to ${input.to} failed: ${message}`);
      // Deliberately generic: an SMTP error can carry the host, the account and
      // occasionally the credential, and this string is shown to a browser.
      return { sent: false, reason: 'The email could not be delivered' };
    }
  }
}

/** The password is attacker-chosen in the sense that anyone can type one. */
const escapeHtml = (v: string): string =>
  v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
