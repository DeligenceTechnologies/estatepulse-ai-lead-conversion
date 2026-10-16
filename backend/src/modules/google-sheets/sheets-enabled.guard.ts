import { CanActivate, HttpException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** The rollout flag: Google Sheets import exists only where GOOGLE_SHEETS_ENABLED=1. */
export const sheetsEnabled = (config: ConfigService): boolean => config.get<string>('GOOGLE_SHEETS_ENABLED') === '1';
/** Its own flag: CSV / XLSX upload exists only where FILE_IMPORT_ENABLED=1. */
export const fileImportEnabled = (config: ConfigService): boolean => config.get<string>('FILE_IMPORT_ENABLED') === '1';
/** A connected CRM imports into the same review queue (see modules/crm). */
export const crmImportEnabled = (config: ConfigService): boolean => config.get<string>('HUBSPOT_ENABLED') === '1';

const off = (code: string, message: string) => new HttpException({ error: { code, message } }, 404);

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
    if (!sheetsEnabled(this.config)) throw off('GOOGLE_SHEETS_DISABLED', 'Google Sheets import is not enabled on this server.');
    return true;
  }
}

/** The same, for the file upload. */
@Injectable()
export class FileImportEnabledGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(): boolean {
    if (!fileImportEnabled(this.config)) throw off('FILE_IMPORT_DISABLED', 'File import is not enabled on this server.');
    return true;
  }
}

/** Import Review serves every import — sheets, files, a CRM — so it is open while any is switched on. */
@Injectable()
export class ImportReviewEnabledGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(): boolean {
    if (!sheetsEnabled(this.config) && !fileImportEnabled(this.config) && !crmImportEnabled(this.config)) {
      throw off('IMPORT_REVIEW_DISABLED', 'Lead import is not enabled on this server.');
    }
    return true;
  }
}
