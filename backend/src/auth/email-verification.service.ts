import { randomBytes } from 'node:crypto';
import { HttpStatus, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { User } from '@prisma/client';
import { AuditService } from '@/audit/audit.service';
import { PrismaService } from '@/common/prisma/prisma.service';
import { sha256Hex } from '@/common/utils/crypto';
import type { AuthEnv } from '@/common/utils/interface';
import { AccountEmailService } from './account-email.service';
import { AuthErrorCode, authError } from './auth.constants';
import type { SessionMeta } from './auth.types';

const TOKEN_TTL_HOURS = 24;
/** A second link for the same account inside this window is not sent. */
const RESEND_COOLDOWN_MS = 60_000;
/** Caps the mail one address can be sent, whatever IPs the requests come from. */
const MAX_LINKS_PER_HOUR = 5;
const HOUR_MS = 60 * 60_000;

const invalidLink = () =>
  authError(
    HttpStatus.BAD_REQUEST,
    'This verification link is invalid or has expired. Request a new one.',
    AuthErrorCode.EMAIL_VERIFICATION_INVALID,
  );

/**
 * Email verification for self sign-ups. An owner who registers cannot sign in
 * until they open the emailed link; opening it verifies the address and signs
 * them in. Members an admin adds are verified at creation: the admin vouches
 * for the address, and their password only ever reaches them through it.
 *
 * Tokens follow PasswordResetService: 256 random bits, only the SHA-256
 * stored, single use, and only the newest link for an account works.
 *
 * Uses the unguarded client: the caller is not signed in, so there is no
 * tenant yet. The account is resolved from the email or the token alone.
 */
@Injectable()
export class EmailVerificationService implements OnModuleInit {
  private readonly logger = new Logger(EmailVerificationService.name);
  readonly required: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly emails: AccountEmailService,
    private readonly audit: AuditService,
    config: ConfigService<AuthEnv, true>,
  ) {
    this.required = config.get('EMAIL_VERIFICATION_REQUIRED', { infer: true });
  }

  /** Fails the boot rather than let sign-ups create accounts that can never be verified. */
  onModuleInit(): void {
    if (this.required && !this.emails.canSendLinks) {
      throw new Error(
        'EMAIL_VERIFICATION_REQUIRED is on, but verification emails cannot be sent: set MAIL_PROVIDER and APP_URL, or turn it off.',
      );
    }
  }

  /** Sends the first link right after sign-up. Never throws: the owner can ask for another. */
  async sendAfterSignup(user: Pick<User, 'id' | 'email' | 'firstName'>, organizationName: string, meta: SessionMeta): Promise<void> {
    try {
      await this.issue({ ...user, organizationName }, meta);
    } catch (error) {
      this.logger.error(`Could not send the verification email for user ${user.id}: ${(error as Error).message}`);
    }
  }

  /**
   * Answers identically whether or not the address has an account waiting, and
   * in the same time: the work runs after the response.
   */
  requestResend(email: string, meta: SessionMeta): void {
    if (!this.required) return;
    void this.resend(email, meta).catch((error) =>
      this.logger.error(`Verification resend failed: ${(error as Error).message}`),
    );
  }

  /** Verifies the address the link was sent to and returns the account to sign in. */
  async verify(token: string, meta: SessionMeta): Promise<User> {
    const record = await this.prisma.emailVerificationToken.findUnique({
      where: { tokenHash: sha256Hex(token) },
      include: { user: { include: { organization: { select: { status: true } } } } },
    });
    const user = record?.user;
    if (
      !record ||
      !user ||
      record.usedAt ||
      record.expiresAt.getTime() <= Date.now() ||
      user.status !== 'active' ||
      user.organization.status !== 'active'
    ) {
      throw invalidLink();
    }

    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      // Claims the link; a second click racing this one finds it used.
      const claimed = await tx.emailVerificationToken.updateMany({
        where: { id: record.id, usedAt: null },
        data: { usedAt: now },
      });
      if (claimed.count === 0) throw invalidLink();

      await tx.emailVerificationToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: now } });
      const verified = await tx.user.update({
        where: { id: user.id },
        data: { emailVerifiedAt: user.emailVerifiedAt ?? now },
      });
      if (!user.emailVerifiedAt) {
        await this.audit.record(
          {
            orgId: user.orgId,
            actorType: 'user',
            actorId: user.id,
            action: 'user.email_verified',
            entityType: 'user',
            entityId: user.id,
            payload: { ipAddress: meta.ipAddress ?? null },
          },
          tx,
        );
      }
      return verified;
    });
  }

  private async resend(email: string, meta: SessionMeta): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        firstName: true,
        status: true,
        emailVerifiedAt: true,
        organization: { select: { name: true, status: true } },
      },
    });
    if (!user || user.emailVerifiedAt || user.status !== 'active' || user.organization.status !== 'active') return;
    await this.issue({ ...user, organizationName: user.organization.name }, meta);
  }

  private async issue(
    user: { id: string; email: string; firstName: string; organizationName: string },
    meta: SessionMeta,
  ): Promise<void> {
    const now = new Date();
    const recent = await this.prisma.emailVerificationToken.findMany({
      where: { userId: user.id, createdAt: { gt: new Date(now.getTime() - HOUR_MS) } },
      select: { createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    if (recent.length >= MAX_LINKS_PER_HOUR || (recent[0] && now.getTime() - recent[0].createdAt.getTime() < RESEND_COOLDOWN_MS)) {
      this.logger.warn(`Verification email for user ${user.id} not sent: requested too often`);
      return;
    }

    const token = randomBytes(32).toString('base64url');
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.emailVerificationToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: now } });
      return tx.emailVerificationToken.create({
        data: {
          userId: user.id,
          tokenHash: sha256Hex(token),
          expiresAt: new Date(now.getTime() + TOKEN_TTL_HOURS * HOUR_MS),
          requestedIp: meta.ipAddress?.slice(0, 64),
        },
        select: { id: true },
      });
    });

    await this.emails.sendEmailVerification({
      tokenId: created.id,
      email: user.email,
      firstName: user.firstName,
      organizationName: user.organizationName,
      token,
      expiresInHours: TOKEN_TTL_HOURS,
    });
  }
}
