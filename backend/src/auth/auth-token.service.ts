import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import type { AuthEnv } from '@/common/utils/interface';
import { AuthErrorCode, authError } from './auth.constants';
import type { AccessTokenPayload, RefreshTokenPayload } from './auth.types';

@Injectable()
export class AuthTokenService {
  private readonly accessSecret: string;
  private readonly refreshSecret: string;
  private readonly accessTtlSeconds: number;
  private readonly refreshTtlSeconds: number;
  private readonly keepSignedInTtlSeconds: number;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService<AuthEnv, true>,
  ) {
    this.accessSecret = config.get('JWT_ACCESS_SECRET', { infer: true });
    this.refreshSecret = config.get('JWT_REFRESH_SECRET', { infer: true });
    this.accessTtlSeconds = config.get('JWT_ACCESS_EXPIRES_IN_SECONDS', { infer: true });
    this.refreshTtlSeconds = config.get('REFRESH_TOKEN_EXPIRES_IN_SECONDS', { infer: true });
    this.keepSignedInTtlSeconds = config.get('REFRESH_TOKEN_KEEP_SIGNED_IN_EXPIRES_IN_SECONDS', { infer: true });
  }

  generateAccessToken(payload: AccessTokenPayload): { token: string; expiresAt: Date } {
    const token = this.jwt.sign(payload, {
      secret: this.accessSecret,
      expiresIn: this.accessTtlSeconds,
    });

    return {
      token,
      expiresAt: new Date(
        Date.now() + this.accessTtlSeconds * 1000,
      ),
    };
  }

  generateRefreshToken(userId: string, sessionId: string, sessionExpiresAt: Date): string {
    const payload: RefreshTokenPayload = {
      sub: userId,
      sid: sessionId,
      jti: randomBytes(16).toString('hex'),
      exp: Math.floor(sessionExpiresAt.getTime() / 1000),
    };

    return this.jwt.sign(payload, {
      secret: this.refreshSecret,
    });
  }

  getRefreshTokenExpiryDate(keepSignedIn = false): Date {
    const ttl = keepSignedIn
      ? this.keepSignedInTtlSeconds
      : this.refreshTtlSeconds;

    return new Date(Date.now() + ttl * 1000);
  }

  verifyAccessToken(token: string): AccessTokenPayload {
    try {
      return this.jwt.verify<AccessTokenPayload>(token, {
        secret: this.accessSecret,
      });
    } catch (error) {
      if (isTokenExpired(error)) {
        throw authError(
          HttpStatus.UNAUTHORIZED,
          'Access token has expired.',
          AuthErrorCode.TOKEN_EXPIRED,
        );
      }

      throw authError(
        HttpStatus.UNAUTHORIZED,
        'Access token is invalid.',
        AuthErrorCode.UNAUTHENTICATED,
      );
    }
  }

  verifyRefreshToken(token: string): RefreshTokenPayload {
    try {
      return this.jwt.verify<RefreshTokenPayload>(token, {
        secret: this.refreshSecret,
      });
    } catch (error) {
      if (isTokenExpired(error)) {
        throw authError(
          HttpStatus.UNAUTHORIZED,
          'Your session has expired. Please log in again.',
          AuthErrorCode.SESSION_EXPIRED,
        );
      }

      throw authError(
        HttpStatus.UNAUTHORIZED,
        'Refresh token is invalid. Please log in again.',
        AuthErrorCode.REFRESH_TOKEN_INVALID,
      );
    }
  }

  hashRefreshToken(token: string): string {
    return createHash('sha256')
      .update(token)
      .digest('hex');
  }

  verifyRefreshTokenHash(
    storedHash: string,
    token: string,
  ): boolean {
    const expected = Buffer.from(storedHash, 'hex');
    const actual = Buffer.from(
      this.hashRefreshToken(token),
      'hex',
    );

    return (
      expected.length === actual.length &&
      timingSafeEqual(expected, actual)
    );
  }
}

function isTokenExpired(error: unknown): boolean {
  return error instanceof Error && error.name === 'TokenExpiredError';
}
