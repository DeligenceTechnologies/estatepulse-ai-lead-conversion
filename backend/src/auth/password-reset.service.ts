import { randomBytes } from 'node:crypto';
import { BadRequestException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '@/audit/audit.service';
import { PrismaService } from '@/common/prisma/prisma.service';
import { sha256Hex } from '@/common/utils/crypto';
import { hashPassword } from '@/common/utils/password';
import { AccountEmailService } from './account-email.service';
import { AuthErrorCode, authError } from './auth.constants';
import type { SessionMeta } from './auth.types';
import type { ResetPasswordDto } from './dto/reset-password.dto';

const TOKEN_TTL_MINUTES = 30;
/** A second link for the same account inside this window is not sent. */
const RESEND_COOLDOWN_MS = 60_000;
/** Caps the mail one address can be sent, whatever IPs the requests come from. */
const MAX_LINKS_PER_HOUR = 5;
const HOUR_MS = 60 * 60_000;

const invalidLink = () =>
  authError(
    HttpStatus.BAD_REQUEST,
    'This password reset link is invalid or has expired. Request a new one.',
    AuthErrorCode.PASSWORD_RESET_INVALID,
  );

/**
 * "Forgot password". The link carries 256 random bits and the database keeps
 * only their SHA-256. A link works once, for TOKEN_TTL_MINUTES, and only while
 * it is the newest one: asking again, using it, or the password changing any
 * other way after it was issued all retire it.
 *
 * Uses the unguarded client: the caller is not signed in, so there is no
 * tenant yet. The account is resolved from the email or the token alone.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emails: AccountEmailService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Answers identically whether or not the address has an account, and in the
   * same time: the lookup and the send run after the response, so neither the
   * body nor the latency tells an attacker which emails are registered.
   */
  requestReset(email: string, meta: SessionMeta): void {
    if (!this.emails.canSendLinks) {
      throw authError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'Password reset by email is not available. Ask your administrator to reset your password.',
        AuthErrorCode.PASSWORD_RESET_UNAVAILABLE,
      );
    }
    void this.issue(email, meta).catch((error) =>
      this.logger.error(`Password reset request failed: ${(error as Error).message}`),
    );
  }

  async validate(token: string): Promise<{ expiresAt: Date }> {
    const record = await this.findUsable(token);
    return { expiresAt: record.expiresAt };
  }

  async reset(dto: ResetPasswordDto, meta: SessionMeta): Promise<void> {
    if (dto.newPassword !== dto.confirmPassword) {
      throw new BadRequestException('Passwords do not match');
    }

    const record = await this.findUsable(dto.token);
    const { user } = record;
    const passwordHash = await hashPassword(dto.newPassword);
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      // Claims the link; a second submit racing this one finds it used.
      const claimed = await tx.passwordResetToken.updateMany({
        where: { id: record.id, usedAt: null },
        data: { usedAt: now },
      });
      if (claimed.count === 0) throw invalidLink();

      await tx.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: now } });
      await tx.user.update({
        where: { id: user.id },
        // Opening a link sent to the address proves it as well as sign-up verification does.
        data: { password: passwordHash, passwordChangedAt: now, emailVerifiedAt: user.emailVerifiedAt ?? now },
      });
      await tx.userSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now } });
      await this.audit.record(
        {
          orgId: user.orgId,
          actorType: 'user',
          actorId: user.id,
          action: 'user.password_reset',
          entityType: 'user',
          entityId: user.id,
          payload: { ipAddress: meta.ipAddress ?? null },
        },
        tx,
      );
    });

    await this.emails.sendPasswordChanged({
      userId: user.id,
      email: user.email,
      firstName: user.firstName,
      timezone: user.timezone,
      organizationName: user.organization.name,
      kind: 'reset',
      changedAt: now,
      ipAddress: meta.ipAddress,
    });
  }

  private async issue(email: string, meta: SessionMeta): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, firstName: true, status: true, organization: { select: { status: true } } },
    });
    if (!user || user.status !== 'active' || user.organization.status !== 'active') return;

    const now = new Date();
    const recent = await this.prisma.passwordResetToken.findMany({
      where: { userId: user.id, createdAt: { gt: new Date(now.getTime() - HOUR_MS) } },
      select: { createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    if (recent.length >= MAX_LINKS_PER_HOUR || (recent[0] && now.getTime() - recent[0].createdAt.getTime() < RESEND_COOLDOWN_MS)) {
      this.logger.warn(`Password reset for user ${user.id} not sent: requested too often`);
      return;
    }

    const token = randomBytes(32).toString('base64url');
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: now } });
      return tx.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: sha256Hex(token),
          expiresAt: new Date(now.getTime() + TOKEN_TTL_MINUTES * 60_000),
          requestedIp: meta.ipAddress?.slice(0, 64),
        },
        select: { id: true },
      });
    });

    await this.emails.sendPasswordReset({
      tokenId: created.id,
      email: user.email,
      firstName: user.firstName,
      token,
      expiresInMinutes: TOKEN_TTL_MINUTES,
    });
  }

  private async findUsable(token: string) {
    const record = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: sha256Hex(token) },
      include: {
        user: {
          select: {
            id: true,
            orgId: true,
            email: true,
            firstName: true,
            timezone: true,
            status: true,
            passwordChangedAt: true,
            emailVerifiedAt: true,
            organization: { select: { name: true, status: true } },
          },
        },
      },
    });
    const { user } = record ?? {};
    if (
      !record ||
      !user ||
      record.usedAt ||
      record.expiresAt.getTime() <= Date.now() ||
      user.status !== 'active' ||
      user.organization.status !== 'active' ||
      // Any password change after the link was issued retires it.
      (user.passwordChangedAt && user.passwordChangedAt > record.createdAt)
    ) {
      throw invalidLink();
    }
    return { ...record, user };
  }
}
