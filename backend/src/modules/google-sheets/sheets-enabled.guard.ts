import { CanActivate, HttpException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** The rollout flag: Google Sheets import exists only where GOOGLE_SHEETS_ENABLED=1. */
export const sheetsEnabled = (config: ConfigService): boolean => config.get<string>('GOOGLE_SHEETS_ENABLED') === '1';

/**
 * Declared after SessionGuard and OwnerGuard, so a caller who may not use the
 * feature anyway learns nothing about whether it is switched on. Switching it
 * off changes no data: sources keep their state, and imported leads stay paused
 * in review until it is switched back on.
 */
@Injectable()
export class SheetsEnabledGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(): boolean {
    if (!sheetsEnabled(this.config)) {
      throw new HttpException(
        { error: { code: 'GOOGLE_SHEETS_DISABLED', message: 'Google Sheets import is not enabled on this server.' } },
        404,
      );
    }
    return true;
  }
}
