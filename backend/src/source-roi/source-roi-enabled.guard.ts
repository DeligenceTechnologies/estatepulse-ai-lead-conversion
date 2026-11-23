import { CanActivate, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { httpError } from '@/common/errors/app-error';
import type { IntegrationEnv } from '@/common/utils/interface';

/** The rollout flag: Source ROI exists only where SOURCE_ROI_ENABLED=1. */
export const sourceRoiEnabled = (config: ConfigService<IntegrationEnv, true>): boolean =>
  config.get('SOURCE_ROI_ENABLED', { infer: true });

/**
 * Off, every Source ROI route answers 404, which is how the screens know to
 * hide the page and its controls. Switching it off changes no data: spend,
 * deal outcomes, no-shows and the cost ledger all stay as they were.
 */
@Injectable()
export class SourceRoiEnabledGuard implements CanActivate {
  constructor(private readonly config: ConfigService<IntegrationEnv, true>) {}

  canActivate(): boolean {
    if (!sourceRoiEnabled(this.config)) {
      throw httpError(404, 'SOURCE_ROI_DISABLED', 'Source ROI is not enabled on this server.');
    }
    return true;
  }
}
