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

/** Every route the app's own frontend calls lives under this, in development and production alike. */
const API_PREFIX = '/api';

/**
 * Routes that stay at the root, outside API_PREFIX: outside services were handed
 * these URLs (lead webhooks, Telnyx, calendar webhooks, booking tools, the
 * Calendly OAuth redirect), so moving them would break every connection already
 * installed. Health stays put for uptime checks.
 */
const ROOT_ROUTES = [
  'health',
  'v1/health',
  'ingest/v1/tally/:token',
  'ingest/v1/typeform/:token',
  'ingest/v1/webhook/:token',
  'ingest/v1/custom/:token',
  'ingest/v1/crm/hubspot/webhook',
  'webhooks/leads/:token',
  'webhooks/telnyx/voice',
  'webhooks/telnyx/messaging',
  'calendar-webhooks/:connectionId',
  'tools/telnyx/booking/availability',
  'tools/telnyx/booking/book',
  'org-settings/calendar/calendly/callback',
];

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  app.setGlobalPrefix(API_PREFIX, { exclude: ROOT_ROUTES });

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
