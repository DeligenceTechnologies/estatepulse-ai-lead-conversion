import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Request, RequestHandler } from 'express';
import { AppError } from '../common/errors';
import { SessionGuard } from '../common/guards/session.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

const passthrough: RequestHandler = (_req, _res, next) => next();

/**
 * Per-route throttles for the credential endpoints.
 *
 * Tighter than the global limiter because these are the routes worth attacking:
 * signup is how an unauthenticated caller creates rows, and login is where
 * passwords get guessed. Applied as Nest middleware rather than a guard so the
 * request is rejected before the body parser and bcrypt ever run.
 */
function limited(
  config: ConfigService,
  windowMs: number,
  max: number,
  keyByEmail = false,
): RequestHandler {
  // The integration suite performs more signups than the hourly cap allows, so
  // the limiters are inert under NODE_ENV=test. They are live everywhere else.
  if (config.get<string>('NODE_ENV') === 'test') return passthrough;

  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Keying login on IP + email means one shared NAT cannot lock out a whole
    // office, and one account cannot be sprayed from a single address.
    keyGenerator: (req: Request): string => {
      const ip = ipKeyGenerator(req.ip ?? '');
      if (!keyByEmail) return ip;
      const body: unknown = req.body;
      const email =
        typeof body === 'object' && body !== null && typeof (body as { email?: unknown }).email === 'string'
          ? (body as { email: string }).email.trim().toLowerCase()
          : '';
      return ip + '|' + email;
    },
    handler: (_req, _res, next) => {
      next(new AppError('RATE_LIMITED', 'Too many requests, please try again later'));
    },
  });
}

/**
 * Exports AuthService and both guards: SessionGuard and TenantGuard both need
 * to verify tokens and resolve memberships, and every feature module that
 * guards a route needs them injectable.
 */
@Module({
  controllers: [AuthController],
  providers: [AuthService, SessionGuard, TenantGuard],
  exports: [AuthService, SessionGuard, TenantGuard],
})
export class AuthModule implements NestModule {
  constructor(private readonly config: ConfigService) {}

  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(limited(this.config, 60 * 60 * 1000, 3))
      .forRoutes({ path: 'api/auth/signup', method: RequestMethod.POST });

    consumer
      .apply(limited(this.config, 15 * 60 * 1000, 5, true))
      .forRoutes({ path: 'api/auth/login', method: RequestMethod.POST });

    consumer
      .apply(limited(this.config, 60 * 1000, 60))
      .forRoutes({ path: 'api/auth/me', method: RequestMethod.GET });
  }
}
