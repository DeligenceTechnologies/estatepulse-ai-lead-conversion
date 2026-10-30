import { CanActivate, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { httpError } from '@/common/errors/app-error';
import type { IntegrationEnv } from '@/common/utils/interface';

/** The rollout flag: Retell exists only where RETELL_ENABLED=1. */
export const retellEnabled = (config: ConfigService<IntegrationEnv, true>): boolean => config.get('RETELL_ENABLED', { infer: true }) === true;

/**
 * Off, every Retell route (management, webhooks, booking tools) answers 404
 * and every organization calls through Telnyx. Runs after the permission
 * guard, like the custom-webhook guard, so a caller who may not use it anyway
 * learns nothing about whether it is switched on.
 */
@Injectable()
export class RetellEnabledGuard implements CanActivate {
  constructor(private readonly config: ConfigService<IntegrationEnv, true>) {}

  canActivate(): boolean {
    if (!retellEnabled(this.config)) throw httpError(404, 'RETELL_DISABLED', 'Retell is not enabled on this server.');
    return true;
  }
}
