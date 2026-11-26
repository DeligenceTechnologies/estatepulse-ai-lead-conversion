import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { ROOT_ROUTES } from './root-routes';
import { AppError } from './common/errors/app-error';
import { sha256Hex } from './common/utils/crypto';

/** Provider deliveries (Telnyx, calendars, booking tools, Stripe) get their own generous per-IP bucket. */
const INBOUND_PREFIXES = ['/webhooks/', '/tools/', '/calendar/webhooks/', '/billing/webhook'];

/** Every route the app's own frontend calls lives under this, in development and production alike. */
const API_PREFIX = '/api';

const SHUTDOWN_GRACE_MS = 10_000;

function exitIfShutdownHangs(): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      setTimeout(() => {
        console.error(`Shutdown on ${signal} took over ${SHUTDOWN_GRACE_MS / 1000}s; exiting without waiting.`);
        process.exit(1);
      }, SHUTDOWN_GRACE_MS).unref();
    });
  }
}

async function bootstrap() {
  exitIfShutdownHangs();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  app.setGlobalPrefix(API_PREFIX, { exclude: ROOT_ROUTES });

  const config = app.get(ConfigService);
  const port = config.get<number>('PORT', 4000);
  const testing = config.get<string>('NODE_ENV') === 'test';

  // X-Forwarded-For is a header anyone can write, so it is read only from hops we run:
  // TRUST_PROXY names them by address, subnet or keyword ('loopback' for a proxy on this
  // box). Unset, nothing is in front and the socket's own address is the client — which is
  // what rate limits are counted per, so a spoofed header cannot buy a fresh bucket.
  app.set('trust proxy', config.get<string>('TRUST_PROXY')?.trim() || false);
  app.disable('x-powered-by');
  app.use(helmet());
  app.useBodyParser('json', { limit: '1mb' });
  app.enableShutdownHooks();

  const limited = (message: string) => (_req: Request, _res: Response, next: NextFunction) =>
    next(new AppError('RATE_LIMITED', message));
  const inbound = (path: string) => INBOUND_PREFIXES.some((prefix) => path.startsWith(prefix));

  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: testing ? Number.MAX_SAFE_INTEGER : 600,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      keyGenerator: (req) => ipKeyGenerator(req.ip ?? ''),
      skip: (req) => !inbound(req.path),
      handler: limited('Too many deliveries, please retry shortly'),
    }),
  );
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: testing ? Number.MAX_SAFE_INTEGER : 240,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      keyGenerator: (req) => {
        const auth = req.headers.authorization;
        return auth?.startsWith('Bearer ') ? `s:${sha256Hex(auth.slice(7)).slice(0, 32)}` : `i:${ipKeyGenerator(req.ip ?? '')}`;
      },
      skip: (req) => inbound(req.path) || req.path === `${API_PREFIX}/v1/events`,
      handler: limited('Too many requests, please try again later'),
    }),
  );
  app.use(
    `${API_PREFIX}/auth`,
    rateLimit({
      windowMs: 15 * 60_000,
      limit: testing ? Number.MAX_SAFE_INTEGER : 50,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      keyGenerator: (req) => ipKeyGenerator(req.ip ?? ''),
      skip: (req) => req.method !== 'POST',
      handler: limited('Too many sign-in attempts, please try again later'),
    }),
  );

  // Billing writes open Stripe sessions and change subscriptions: a tighter
  // bucket per session (or address) than the general one.
  app.use(
    `${API_PREFIX}/billing`,
    rateLimit({
      windowMs: 10 * 60_000,
      limit: testing ? Number.MAX_SAFE_INTEGER : 30,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      keyGenerator: (req) => {
        const auth = req.headers.authorization;
        return auth?.startsWith('Bearer ') ? `b:${sha256Hex(auth.slice(7)).slice(0, 32)}` : `bi:${ipKeyGenerator(req.ip ?? '')}`;
      },
      skip: (req) => req.method !== 'POST',
      handler: limited('Too many billing requests, please try again in a few minutes'),
    }),
  );

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.use(cookieParser());

    const corsOrigins = (config.get<string>('CORS_ORIGINS') ?? '')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);

    app.enableCors({
        origin: corsOrigins,
        credentials: true,
        methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: [
            'Content-Type',
            'Authorization',
            'X-Api-Key',
            'X-Request-Id',
        ],
    });

  await app.listen(port);
  console.log(`Server running on http://localhost:${port}`);
}

bootstrap();
