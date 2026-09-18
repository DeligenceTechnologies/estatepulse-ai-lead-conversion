// Must be first: nothing below may read process.env before the file is loaded.
import 'dotenv/config';
import 'reflect-metadata';

import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { sha256Hex } from './common/crypto';
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

  // --- Rate limiting --------------------------------------------------------
  //
  // Two limiters, because the three kinds of traffic here have nothing in common.
  //
  // The single 300-per-15-minutes-per-IP limiter this replaces was wrong in
  // three separate ways, each of which we hit:
  //
  //  1. 300/15min is 20 requests a minute. The dashboard's own polling was
  //     designed above that, so the app rate-limited ITSELF after ~12 minutes.
  //  2. Keyed by IP, so a brokerage behind one office NAT shares one bucket and
  //     the tenth user to sign in is the one who gets locked out.
  //  3. It covered /ingest. Tally delivers from a small pool of shared
  //     addresses, so at any real volume we would 429 THEM — which starts their
  //     5m/30m/1h/6h/1d retry ladder and ends in an email to our customer saying
  //     our integration is broken.
  //
  // The window is also a minute rather than fifteen: tripping a limit should
  // cost seconds, not a quarter of an hour of a dead dashboard.
  const unlimited = nodeEnv === 'test';
  const limited = (message: string) => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(new AppError('RATE_LIMITED', message));

  /**
   * One bucket per SESSION where there is one, falling back to per-IP.
   *
   * Keyed on a hash of the bearer token rather than on a user id parsed out of
   * it: parsing means trusting an unverified JWT (the guard has not run yet), and
   * a forged `sub` would then choose its own bucket. The token is opaque here and
   * only ever hashed, so it never reaches a log or a store in the clear.
   *
   * Someone spraying fresh fake tokens does get a fresh bucket each time — those
   * requests all die at the guard, and the generous per-IP ceiling below is what
   * bounds that case.
   */
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: unlimited ? Number.MAX_SAFE_INTEGER : 120,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      keyGenerator: (req) => {
        const auth = req.headers.authorization;
        if (auth?.startsWith('Bearer ')) return `s:${sha256Hex(auth.slice(7)).slice(0, 32)}`;
        return `i:${ipKeyGenerator(req.ip ?? '')}`;
      },
      // Ingest has its own limiter below. The event stream is one long-lived
      // connection per tab and must never be counted as request volume.
      skip: (req) => req.path.startsWith('/ingest/') || req.path === '/api/v1/events',
      handler: limited('Too many requests, please try again later'),
    }),
  );

  /**
   * Ingest, per IP, with a lot of headroom.
   *
   * The ceiling exists only to stop someone spraying `/ingest/v1/tally/<random>`;
   * a legitimate provider never approaches it. Deliberately generous in the
   * direction of accepting a real delivery: dropping one costs a customer a
   * lead, while an extra 404 lookup costs one indexed query.
   */
  app.use(
    '/ingest',
    rateLimit({
      windowMs: 60_000,
      limit: unlimited ? Number.MAX_SAFE_INTEGER : 600,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      keyGenerator: (req) => ipKeyGenerator(req.ip ?? ''),
      handler: limited('Too many deliveries, please retry shortly'),
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
  logger.log(`Portal:    /api/auth, /api/telnyx, /api/leads, /api/strategy, /api/ingest/sources`);
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
