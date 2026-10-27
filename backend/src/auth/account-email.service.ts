import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailService } from '@/common/service/mail.service';
import type { AppEnv } from '@/common/utils/interface';
import { EmailQueue } from '@/queue/email/email.queue';
import { passwordChangedEmail, type PasswordChangeKind } from './templates/password-changed-email';
import { passwordResetEmail } from './templates/password-reset-email';
import { verifyEmail } from './templates/verify-email';

export interface PasswordChangedNotice {
  userId: string;
  email: string;
  firstName: string;
  timezone: string;
  organizationName: string;
  kind: PasswordChangeKind;
  changedAt: Date;
  ipAddress?: string;
}

/**
 * Queues the account security emails. Sending is best effort: the change the
 * email describes has already committed, so a mail or queue outage is logged
 * and never undoes or fails it.
 */
@Injectable()
export class AccountEmailService {
  private readonly logger = new Logger(AccountEmailService.name);
  private readonly appUrl?: string;

  constructor(
    private readonly mail: MailService,
    private readonly emailQueue: EmailQueue,
    config: ConfigService<AppEnv, true>,
  ) {
    this.appUrl = config.get('APP_URL', { infer: true })?.replace(/\/+$/, '');
  }

  /** A link email needs both a mail provider and the frontend's address to point at. */
  get canSendLinks(): boolean {
    return this.mail.enabled && this.appUrl !== undefined;
  }

  private linkTo(page: string, token: string): string {
    if (!this.appUrl) throw new Error('APP_URL is not configured');
    return `${this.appUrl}/${page}?token=${encodeURIComponent(token)}`;
  }

  /** Throws when the email cannot be queued, so the caller can log against the request. */
  async sendEmailVerification(input: {
    tokenId: string;
    email: string;
    firstName: string;
    organizationName: string;
    token: string;
    expiresInHours: number;
  }) {
    await this.emailQueue.enqueue(
      {
        kind: 'auth.verify_email',
        to: input.email,
        ...verifyEmail({
          firstName: input.firstName,
          organizationName: input.organizationName,
          verifyUrl: this.linkTo('verify-email', input.token),
          expiresInHours: input.expiresInHours,
        }),
      },
      // The link signs the account in: keep it out of Redis once it is sent.
      { dedupeKey: `auth.verify_email:${input.tokenId}`, sensitive: true },
    );
  }

  /** Throws when the email cannot be queued, so the caller can log against the request. */
  async sendPasswordReset(input: { tokenId: string; email: string; firstName: string; token: string; expiresInMinutes: number }) {
    await this.emailQueue.enqueue(
      {
        kind: 'auth.password_reset',
        to: input.email,
        ...passwordResetEmail({
          firstName: input.firstName,
          resetUrl: this.linkTo('reset-password', input.token),
          expiresInMinutes: input.expiresInMinutes,
        }),
      },
      // The link is a credential: keep it out of Redis once it is sent.
      { dedupeKey: `auth.password_reset:${input.tokenId}`, sensitive: true },
    );
  }

  /** Never throws. */
  async sendPasswordChanged(notice: PasswordChangedNotice): Promise<void> {
    if (!this.mail.enabled) return;
    try {
      await this.emailQueue.enqueue(
        {
          kind: 'auth.password_changed',
          to: notice.email,
          ...passwordChangedEmail({
            firstName: notice.firstName,
            organizationName: notice.organizationName,
            kind: notice.kind,
            changedAt: notice.changedAt,
            timezone: notice.timezone,
            ipAddress: notice.ipAddress,
            forgotPasswordUrl: this.appUrl ? `${this.appUrl}/forgot-password` : undefined,
          }),
        },
        { dedupeKey: `auth.password_changed:${notice.userId}:${notice.changedAt.getTime()}` },
      );
    } catch (error) {
      this.logger.error(`Could not queue the password-changed notice for user ${notice.userId}: ${(error as Error).message}`);
    }
  }
}
