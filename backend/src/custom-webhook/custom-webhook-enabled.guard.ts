import { CanActivate, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { httpError } from '@/common/errors/app-error';
import type { IntegrationEnv } from '@/common/utils/interface';

/** The rollout flag: custom webhooks exist only where CUSTOM_WEBHOOK_ENABLED=1. */
export const customWebhookEnabled = (config: ConfigService<IntegrationEnv, true>): boolean =>
  config.get('CUSTOM_WEBHOOK_ENABLED', { infer: true });

/**
 * Runs after the permission guard, as the Sheets guard does, so a caller who
 * may not use the feature anyway learns nothing about whether it is switched
 * on. Off, every management route answers 404 and the public ingest route does
 * too (it checks the same flag itself); switching it off changes no data —
 * sources keep their state and held deliveries stay held.
 */
@Injectable()
export class CustomWebhookEnabledGuard implements CanActivate {
  constructor(private readonly config: ConfigService<IntegrationEnv, true>) {}

  canActivate(): boolean {
    if (!customWebhookEnabled(this.config)) {
      throw httpError(404, 'CUSTOM_WEBHOOK_DISABLED', 'Custom webhooks are not enabled on this server.');
    }
    return true;
  }
}
