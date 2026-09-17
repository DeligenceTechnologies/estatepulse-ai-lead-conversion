// Must be first: nothing below may read process.env before the file is loaded.
import 'dotenv/config';
import 'reflect-metadata';

import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AppError } from './common/errors';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

/**
 * One NestJS application. Express appears here only as the HTTP adapter
 * (@nestjs/platform-express) and as three pieces of middleware — helmet, CORS
 * and a rate limiter — which is what every Nest app on this adapter looks like.
 * There are no hand-written routers: every route is a controller.
 *
 * Route paths are declared in full on each controller ('api/auth', 'ingest/v1')
 * rather than via setGlobalPrefix. That is deliberate: the portal webhook and
 * the provider webhook both declare `ingest/v1/tally/:token`, and a prefix
 * exclusion matches on the declared path, so it would silently unprefix both
 * and collapse them onto one route.
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // CRITICAL: exposes req.rawBody, the exact bytes as received.
    //
    // Tally's signature is base64(HMAC-SHA256(secret, rawBody)). Verifying
    // against JSON.stringify(req.body) instead produces different bytes — key
    // order, whitespace and unicode escaping all differ — and EVERY signature
    // fails. This one flag is the difference between working and mysteriously
    // broken. See common/crypto.spec.ts for the test that pins this behaviour.
    rawBody: true,
    bufferLogs: true,
  });

  const config = app.get(ConfigService);
  const nodeEnv = config.get<string>('NODE_ENV') ?? 'development';

  // Without this every request reads as the proxy's address and all the per-IP
  // limiters collapse into one shared bucket. One hop, not `true`, which would
  // trust a spoofed X-Forwarded-For outright.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());

  // Cap request size. Tally payloads are single-digit KB; anything near this
  // limit is abuse or a misconfiguration.
  const maxBytes = config.get<number>('INGEST_MAX_BODY_BYTES') ?? 1_048_576;
  app.useBodyParser('json', { limit: maxBytes });

  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: nodeEnv === 'test' ? Number.MAX_SAFE_INTEGER : 300,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      handler: (_req, _res, next) => {
        next(new AppError('RATE_LIMITED', 'Too many requests, please try again later'));
      },
    }),
  );

  // Method, path, status and duration only. Never the body: these routes carry
  // plaintext passwords.
  const httpLogger = new Logger('HTTP');
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    const started = Date.now();
    res.on('finish', () => {
      httpLogger.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - started}ms`);
    });
    next();
  });

  // Dev goes through the Vite proxy, which makes the API same-origin, so CORS
  // only ever matters in production.
  const origins = (config.get<string>('CORS_ORIGINS') ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (origins.length > 0) {
    app.enableCors({
      origin: origins,
      credentials: false,
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Api-Key', 'X-Request-Id'],
    });
  }

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  // One envelope for every failure, and the only thing standing between an
  // unexpected throw and a stack trace on the wire.
  app.useGlobalFilters(new AllExceptionsFilter());

  // Lets OnModuleDestroy actually run on SIGTERM, which is what stops the
  // engine's pending timers and the watcher's interval from firing into a
  // half-torn-down container.
  app.enableShutdownHooks();

  const port = config.get<number>('PORT') ?? 4000;
  await app.listen(port, '0.0.0.0');

  logger.log(`API listening on http://localhost:${port} (${nodeEnv})`);
  logger.log(`Portal:    /api/auth, /api/agents, /api/telnyx, /api/leads, /api/strategy, /api/ingest/sources`);
  logger.log(`Ingestion: /api/v1/lead-sources, /api/v1/integrations, /api/v1/leads`);
  logger.log(`Webhook:   ${config.get('PUBLIC_API_BASE_URL')}/ingest/v1/tally/:token`);
  logger.log(`Worker:    ${config.get('WORKER_ENABLED') === 'false' ? 'disabled' : 'enabled'}`);
}

void bootstrap().catch((err: unknown) => {
  // Nothing is listening yet, so there is no envelope to answer with — fail
  // loudly and let the supervisor restart or the deploy roll back.
  new Logger('Bootstrap').error('Failed to start', err as Error);
  process.exit(1);
});
