import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { AuthContext } from '../../auth/types';
import type { SessionRequest } from '../guards/session.guard';
import type { TenantContext, TenantRequest } from '../guards/tenant.guard';

/**
 * The signed-in user, organization and role. Only meaningful behind SessionGuard,
 * which is what puts it on the request.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthContext =>
    ctx.switchToHttp().getRequest<SessionRequest>().auth,
);

/** The calling organization's id — the value nearly every handler actually wants. */
export const OrgId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string =>
    ctx.switchToHttp().getRequest<SessionRequest>().auth.organizationId,
);

/** The resolved tenant behind TenantGuard, whichever credential was presented. */
export const CurrentTenant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): TenantContext =>
    ctx.switchToHttp().getRequest<TenantRequest>().tenant,
);

/** The calling organization's id, behind TenantGuard. */
export const TenantOrgId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string =>
    ctx.switchToHttp().getRequest<TenantRequest>().tenant.organizationId,
);
