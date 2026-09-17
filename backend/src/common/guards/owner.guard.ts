import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { AppError } from '../errors';
import type { SessionRequest } from './session.guard';

/**
 * Requires the caller's membership role to be 'owner'.
 *
 * Runs AFTER SessionGuard and reads the role SessionGuard resolved, which comes
 * from organization_members on this request and never from the token. That is
 * what makes a demotion take effect immediately: an owner demoted to agent
 * stops passing here on their very next call, with the token they already hold.
 *
 * Declare it second: `@UseGuards(SessionGuard, OwnerGuard)`. Nest runs guards in
 * order, so without SessionGuard first there is no `req.auth` to read.
 */
@Injectable()
export class OwnerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<SessionRequest>();

    // Missing auth means the route was wired without SessionGuard. Fail closed
    // rather than assuming anything about the caller.
    if (req.auth?.role !== 'owner') {
      throw new AppError('FORBIDDEN', 'Only an organization owner can manage agents');
    }
    return true;
  }
}
