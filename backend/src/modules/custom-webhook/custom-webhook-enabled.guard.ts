import { CanActivate, HttpException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** The rollout flag: custom webhooks exist only where CUSTOM_WEBHOOK_ENABLED=1. */
export const customWebhookEnabled = (config: ConfigService): boolean => config.get<string>('CUSTOM_WEBHOOK_ENABLED') === '1';

/**
 * Declared after SessionGuard and OwnerGuard, as the Sheets guard is, so a
 * caller who may not use the feature anyway learns nothing about whether it is
 * switched on. Off, every management route answers 404 and the public ingest
 * route does too (it checks the same flag itself); switching it off changes no
 * data — sources keep their state and held deliveries stay held.
 */
@Injectable()
export class CustomWebhookEnabledGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(): boolean {
    if (!customWebhookEnabled(this.config)) {
      throw new HttpException({ error: { code: 'CUSTOM_WEBHOOK_DISABLED', message: 'Custom webhooks are not enabled on this server.' } }, 404);
    }
    return true;
  }
}
