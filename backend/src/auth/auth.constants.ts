import { HttpException, HttpStatus } from '@nestjs/common';

export const REFRESH_TOKEN_COOKIE = 'refresh_token';
/** The auth routes' public path (server.ts serves them under /api), so the cookie reaches /api/auth/refresh. */
export const REFRESH_TOKEN_COOKIE_PATH = '/api/auth';

export const IS_PUBLIC_KEY = 'isPublic';

export enum AuthErrorCode {
  INVALID_CREDENTIALS = 'INVALID_CREDENTIALS',
  ACCOUNT_INACTIVE = 'ACCOUNT_INACTIVE',
  UNAUTHENTICATED = 'UNAUTHENTICATED',
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',
  REFRESH_TOKEN_MISSING = 'REFRESH_TOKEN_MISSING',
  REFRESH_TOKEN_INVALID = 'REFRESH_TOKEN_INVALID',
  REFRESH_TOKEN_REUSED = 'REFRESH_TOKEN_REUSED',
  REFRESH_TOKEN_RACE = 'REFRESH_TOKEN_RACE',
  SESSION_REVOKED = 'SESSION_REVOKED',
  SESSION_EXPIRED = 'SESSION_EXPIRED',
  FORBIDDEN = 'FORBIDDEN',
  PASSWORD_RESET_INVALID = 'PASSWORD_RESET_INVALID',
  PASSWORD_RESET_UNAVAILABLE = 'PASSWORD_RESET_UNAVAILABLE',
  EMAIL_NOT_VERIFIED = 'EMAIL_NOT_VERIFIED',
  EMAIL_VERIFICATION_INVALID = 'EMAIL_VERIFICATION_INVALID',
}

export function authError(status: HttpStatus, message: string, code: AuthErrorCode): HttpException {
  return new HttpException({ statusCode: status, message, code }, status);
}
