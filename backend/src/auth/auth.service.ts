import { randomUUID } from 'node:crypto';
import { BadRequestException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import type { User } from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';
import { rethrowPrismaError } from '@/common/prisma/prisma-errors';
import { hashPassword, verifyPassword } from '@/common/utils/password';
import { AuthErrorCode, authError } from './auth.constants';
import { AuthTokenService } from './auth-token.service';
import type { AuthContext, IssuedTokens, SessionMeta } from './auth.types';
import { ChangePasswordDto } from './dto/change-password.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { DEFAULT_ROLES, effectivePermissions } from '@/role/permissions';

const OMIT_PASSWORD = { password: true } as const;

const dummyPasswordHash = hashPassword(randomUUID());

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: AuthTokenService,
  ) {}

  async register(dto: RegisterDto, meta: SessionMeta) {
    const { organizationName, password, ...owner } = dto;
    const passwordHash = await hashPassword(password);

    let user: User;
    try {
      user = await this.prisma.$transaction(async (tx) => {
        const organization = await tx.organization.create({
          data: { name: organizationName },
        });
        const ownerRole = await tx.role.create({
          data: { ...DEFAULT_ROLES.OWNER, orgId: organization.id },
        });
        await tx.role.create({
          data: { ...DEFAULT_ROLES.AGENT, orgId: organization.id },
        });
        return tx.user.create({
          data: { ...owner, orgId: organization.id, roleId: ownerRole.id, password: passwordHash },
        });
      });
    } catch (error) {
      rethrowPrismaError(error, 'User');
    }

    return this.startSession(user, false, meta);
  }

  async login({ email, password, keepSignIn = false }: LoginDto, meta: SessionMeta) {
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { organization: { select: { status: true } } },
    });

    const isMatch = await verifyPassword(password, user?.password ?? (await dummyPasswordHash));
    if (!user || !isMatch) {
      throw authError(HttpStatus.UNAUTHORIZED, 'Invalid credentials', AuthErrorCode.INVALID_CREDENTIALS);
    }
    if (user.status !== 'active' || user.organization.status !== 'active') {
      throw authError(HttpStatus.FORBIDDEN, 'This account is inactive.', AuthErrorCode.ACCOUNT_INACTIVE);
    }

    return this.startSession(user, keepSignIn, meta);
  }

  async refreshToken(token: string | undefined) {
    if (!token) {
      throw authError(
        HttpStatus.UNAUTHORIZED,
        'Refresh token is missing. Please log in again.',
        AuthErrorCode.REFRESH_TOKEN_MISSING,
      );
    }

    const decoded = this.tokens.verifyRefreshToken(token);

    const session = await this.prisma.userSession.findUnique({
      where: { id: decoded.sid },
      include: { user: { include: { organization: { select: { status: true } } } } },
    });
    if (!session || session.userId !== decoded.sub) {
      throw authError(
        HttpStatus.UNAUTHORIZED,
        'Refresh token is invalid. Please log in again.',
        AuthErrorCode.REFRESH_TOKEN_INVALID,
      );
    }
    if (session.revokedAt) {
      throw authError(
        HttpStatus.UNAUTHORIZED,
        'This session is no longer active. Please log in again.',
        AuthErrorCode.SESSION_REVOKED,
      );
    }

    const storedHash = session.refreshTokenHash;
    if (!this.tokens.verifyRefreshTokenHash(storedHash, token)) {
      await this.revokeAllSessions(session.userId);
      throw authError(
        HttpStatus.UNAUTHORIZED,
        'This session was ended for security reasons. Please log in again.',
        AuthErrorCode.REFRESH_TOKEN_REUSED,
      );
    }

    const sessionExpiresAt = session.expiresAt;
    if (sessionExpiresAt.getTime() <= Date.now()) {
      await this.revokeSession(session.id);
      throw authError(
        HttpStatus.UNAUTHORIZED,
        'Your session has expired. Please log in again.',
        AuthErrorCode.SESSION_EXPIRED,
      );
    }

    const { user } = session;
    if (user.status !== 'active' || user.organization.status !== 'active') {
      await this.revokeSession(session.id);
      throw authError(HttpStatus.FORBIDDEN, 'This account is inactive.', AuthErrorCode.ACCOUNT_INACTIVE);
    }

    const access = this.tokens.generateAccessToken({
      sub: user.id,
      orgId: user.orgId,
      sid: session.id,
    });
    const newRefreshToken = this.tokens.generateRefreshToken(user.id, session.id, sessionExpiresAt);

    const rotated = await this.prisma.userSession.updateMany({
      where: { id: session.id, refreshTokenHash: storedHash, revokedAt: null },
      data: {
        refreshTokenHash: this.tokens.hashRefreshToken(newRefreshToken),
        lastSeenAt: new Date(),
      },
    });
    if (rotated.count === 0) {
      throw authError(
        HttpStatus.CONFLICT,
        'Session was refreshed by another request. Please retry.',
        AuthErrorCode.REFRESH_TOKEN_RACE,
      );
    }

    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: newRefreshToken,
      refreshTokenExpiresAt: sessionExpiresAt,
      keepSignedIn: session.keepSignedIn,
    } satisfies IssuedTokens;
  }

  async logout(auth: AuthContext) {
    await this.revokeSession(auth.sessionId);
  }

  async logoutAll(auth: AuthContext) {
    await this.revokeAllSessions(auth.userId);
  }

  async me(auth: AuthContext) {
    const user = await this.prisma.user.findUnique({
      where: { id: auth.userId },
      omit: OMIT_PASSWORD,
      include: { organization: true, role: true },
    });
    if (!user) throw new NotFoundException('User not found');
    return { ...user, permissions: effectivePermissions(user.role) };
  }

  async changePassword(dto: ChangePasswordDto, auth: AuthContext) {
    const user = await this.prisma.user.findUnique({
      where: { id: auth.userId },
      select: { id: true, password: true },
    });
    if (!user) throw new NotFoundException('User not found');

    const isMatch = await verifyPassword(dto.oldPassword, user.password);
    if (!isMatch) {
      throw new BadRequestException('Old password is incorrect');
    }
    if (dto.newPassword !== dto.confirmPassword) {
      throw new BadRequestException('Passwords do not match');
    }
    if (dto.newPassword === dto.oldPassword) {
      throw new BadRequestException('New password must be different from the old password');
    }

    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: { password: await hashPassword(dto.newPassword), passwordChangedAt: now },
      }),
      this.prisma.userSession.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: now },
      }),
    ]);
    return true;
  }

  private async startSession(user: User, keepSignedIn: boolean, meta: SessionMeta) {
    const sessionId = randomUUID();
    const expiresAt = this.tokens.getRefreshTokenExpiryDate(keepSignedIn);
    const refreshToken = this.tokens.generateRefreshToken(user.id, sessionId, expiresAt);
    const access = this.tokens.generateAccessToken({
      sub: user.id,
      orgId: user.orgId,
      sid: sessionId,
    });

    await this.prisma.$transaction([
      this.prisma.userSession.create({
        data: {
          id: sessionId,
          userId: user.id,
          refreshTokenHash: this.tokens.hashRefreshToken(refreshToken),
          keepSignedIn,
          expiresAt,
          userAgent: meta.userAgent?.slice(0, 512),
          ipAddress: meta.ipAddress?.slice(0, 64),
        },
      }),
      this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }),
    ]);

    const tokens: IssuedTokens = {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken,
      refreshTokenExpiresAt: expiresAt,
      keepSignedIn,
    };
    const { password: _password, ...safeUser } = user;
    return { ...tokens, user: safeUser };
  }

  private revokeSession(sessionId: string) {
    return this.prisma.userSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private revokeAllSessions(userId: string) {
    return this.prisma.userSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
