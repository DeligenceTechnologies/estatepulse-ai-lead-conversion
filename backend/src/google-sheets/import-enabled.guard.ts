import { CanActivate, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { httpError } from '@/common/errors/app-error';
import type { IntegrationEnv } from '@/common/utils/interface';

/** A feature that is switched off answers 404, so the UI hides it and nothing about it leaks. */
@Injectable()
abstract class FeatureGuard implements CanActivate {
  constructor(protected readonly config: ConfigService<IntegrationEnv, true>) {}

  protected abstract enabled(): boolean;
  protected abstract readonly code: string;
  protected abstract readonly message: string;

  canActivate(): boolean {
    if (!this.enabled()) throw httpError(404, this.code, this.message);
    return true;
  }
}

@Injectable()
export class SheetsEnabledGuard extends FeatureGuard {
  protected readonly code = 'GOOGLE_SHEETS_DISABLED';
  protected readonly message = 'Google Sheets import is not enabled on this server.';
  protected enabled() {
    return this.config.get('GOOGLE_SHEETS_ENABLED', { infer: true });
  }
}

@Injectable()
export class FileImportEnabledGuard extends FeatureGuard {
  protected readonly code = 'FILE_IMPORT_DISABLED';
  protected readonly message = 'File import is not enabled on this server.';
  protected enabled() {
    return this.config.get('FILE_IMPORT_ENABLED', { infer: true });
  }
}

@Injectable()
export class ImportReviewEnabledGuard extends FeatureGuard {
  protected readonly code = 'IMPORT_REVIEW_DISABLED';
  protected readonly message = 'Lead import is not enabled on this server.';
  protected enabled() {
    return (
      this.config.get('GOOGLE_SHEETS_ENABLED', { infer: true }) ||
      this.config.get('FILE_IMPORT_ENABLED', { infer: true }) ||
      this.config.get('HUBSPOT_ENABLED', { infer: true })
    );
  }
}

@Injectable()
export class OutreachSchedulingEnabledGuard extends FeatureGuard {
  protected readonly code = 'OUTREACH_SCHEDULING_DISABLED';
  protected readonly message = 'Outreach scheduling is not enabled on this server.';
  protected enabled() {
    return this.config.get('OUTREACH_SCHEDULING_ENABLED', { infer: true });
  }
}
