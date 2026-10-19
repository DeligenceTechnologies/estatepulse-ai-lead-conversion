import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { AppError } from './common/errors/app-error';
import { sha256Hex } from './common/utils/crypto';

/** Provider deliveries (lead webhooks, Telnyx, calendars, booking tools) get their own generous per-IP bucket. */
const INBOUND_PREFIXES = ['/ingest/', '/webhooks/', '/tools/', '/calendar/webhooks/'];

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

  const config = app.get(ConfigService);
  const port = config.get<number>('PORT', 4000);
  const testing = config.get<string>('NODE_ENV') === 'test';

  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet());
  app.useBodyParser('json', { limit: config.get<number>('INGEST_MAX_BODY_BYTES') ?? 1_048_576 });
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
      skip: (req) => inbound(req.path) || req.path === '/v1/events',
      handler: limited('Too many requests, please try again later'),
    }),
  );
  app.use(
    '/auth',
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

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.use(cookieParser());

  const corsOrigin = config.get<string>('CORS_ORIGIN');
  app.enableCors(
    corsOrigin
      ? { origin: corsOrigin.split(',').map((origin) => origin.trim()), credentials: true }
      : undefined,
  );

  await app.listen(port);
  console.log(`Server running on http://localhost:${port}`);
}

bootstrap();
