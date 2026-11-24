import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthErrorCode, authError } from '@/auth/auth.constants';
import type { AuthContext } from '@/auth/auth.types';
import type { Feature } from '../billing-plans';
import { EntitlementService } from './entitlement.service';

const FEATURE_KEY = 'billing:feature';

/** Runs after the global auth/permission guards. */
@Injectable()
export class EntitlementGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: EntitlementService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.getAllAndOverride<Feature | undefined>(FEATURE_KEY, [context.getHandler(), context.getClass()]);
    if (!feature) return true;
    const { auth } = context.switchToHttp().getRequest<Request & { auth?: AuthContext }>();
    if (!auth) throw authError(HttpStatus.UNAUTHORIZED, 'Authentication required.', AuthErrorCode.UNAUTHENTICATED);
    await this.entitlements.assertFeature(auth.organizationId, feature);
    return true;
  }
}

/** The route needs a plan that includes `feature` (403 PLAN_UPGRADE_REQUIRED otherwise). */
export const RequireFeature = (feature: Feature) => applyDecorators(SetMetadata(FEATURE_KEY, feature), UseGuards(EntitlementGuard));
