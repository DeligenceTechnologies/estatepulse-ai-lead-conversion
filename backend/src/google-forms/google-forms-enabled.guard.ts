import { CanActivate, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { httpError } from '@/common/errors/app-error';
import type { IntegrationEnv } from '@/common/utils/interface';

/** The rollout flag: Google Forms exists only where GOOGLE_FORMS_ENABLED=1. */
export const googleFormsEnabled = (config: ConfigService<IntegrationEnv, true>): boolean =>
  config.get('GOOGLE_FORMS_ENABLED', { infer: true });

/**
 * Off, every management route answers 404 — the same answer the Sheets and
 * custom-webhook guards give, and the same one the public ingest route gives
 * (it checks the flag itself). The UI hides the card on that 404, and a caller
 * who may not use the feature anyway learns nothing about whether it is on.
 *
 * Switching it off changes no data: sources keep their state and their held
 * deliveries stay held.
 */
@Injectable()
export class GoogleFormsEnabledGuard implements CanActivate {
  constructor(private readonly config: ConfigService<IntegrationEnv, true>) {}

  canActivate(): boolean {
    if (!googleFormsEnabled(this.config)) {
      throw httpError(404, 'GOOGLE_FORMS_DISABLED', 'Google Forms is not enabled on this server.');
    }
    return true;
  }
}
