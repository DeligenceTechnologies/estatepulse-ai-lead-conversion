import { HttpException, HttpStatus } from '@nestjs/common';

export const REFRESH_TOKEN_COOKIE = 'refresh_token';
export const REFRESH_TOKEN_COOKIE_PATH = '/auth';

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
}

export function authError(status: HttpStatus, message: string, code: AuthErrorCode): HttpException {
  return new HttpException({ statusCode: status, message, code }, status);
}
