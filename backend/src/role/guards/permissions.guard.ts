import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthErrorCode, authError } from '@/auth/auth.constants';
import type { AuthContext } from '@/auth/auth.types';
import { PERMISSIONS_KEY } from '../decorators/require-permissions.decorator';
import type { Permission } from '../permissions';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) {
      return true;
    }

    const { auth } = context.switchToHttp().getRequest<Request & { auth?: AuthContext }>();
    const granted = auth && required.every((permission) => auth.permissions.includes(permission));
    if (!granted) {
      throw authError(
        HttpStatus.FORBIDDEN,
        'You do not have permission to perform this action.',
        AuthErrorCode.FORBIDDEN,
      );
    }
    return true;
  }
}
