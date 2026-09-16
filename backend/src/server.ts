// Must be first: env.ts validates process.env at import time, and the Express
// half is imported below. @nestjs/config would only populate it during Nest's
// bootstrap, which is far too late.
import 'dotenv/config';
import 'reflect-metadata';

import { Logger, RequestMethod, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter, NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import { AppModule } from './app.module';
import { createBaseApp, mountErrorHandler, mountPortalRoutes } from './app';
import { prisma } from './db';
import { env } from './env';
import { startLeadWatcher } from './telnyx/leadWatcher';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  // One Express instance shared by both halves. See the comment in app.ts —
  // the ordering below is required, not stylistic.
  const server = createBaseApp();

  // Cap request size. Tally payloads are single-digit KB; anything near this
  // limit is abuse or a misconfiguration.
  const maxBytes = Number(process.env['INGEST_MAX_BODY_BYTES'] ?? 1_048_576);

  /*
   * One body parser for both halves, and the reason it is ours rather than
   * Nest's: `verify` is the only hook that sees the bytes before they are
   * parsed.
   *
   * Tally's signature is base64(HMAC-SHA256(secret, rawBody)). Verifying
   * against JSON.stringify(req.body) instead produces different bytes — key
   * order, whitespace and unicode escaping all differ — and EVERY signature
   * fails. Capturing the buffer here is the difference between working and
   * mysteriously broken. See common/crypto.spec.ts for the test that pins it.
   */
  server.use(
    express.json({
      limit: maxBytes,
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );

  // Before Nest: its init() installs a catch-all 404 that would otherwise
  // answer every one of these paths.
  mountPortalRoutes(server);
  mountErrorHandler(server);

  const app = await NestFactory.create<NestExpressApplication>(
    AppModule,
    new ExpressAdapter(server),
    // The parser above already ran and already captured rawBody; letting Nest
    // install a second one would re-read an exhausted stream.
    { bodyParser: false },
  );

  const config = app.get(ConfigService);

  /*
   * Everything the browser calls lives under /api, which is what the Vite dev
   * proxy and the production proxy forward. The ingestion webhook is excluded:
   * its URL is already installed on forms at the provider (Tally et al.), and
   * moving it would silently break every connected form until each was
   * reinstalled.
   */
  app.setGlobalPrefix('api', {
    exclude: [{ path: 'ingest/v1/tally/:token', method: RequestMethod.POST }],
  });

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  await app.init();
  await app.listen(env.PORT, '0.0.0.0');

  logger.log(`API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
  logger.log(`Portal:    /api/auth, /api/telnyx, /api/leads, /api/ingest/sources`);
  logger.log(`Ingestion: /api/v1/lead-sources, /api/v1/integrations, /api/v1/leads`);
  logger.log(`Webhook:   ${config.get('PUBLIC_API_BASE_URL')}/ingest/v1/tally/:token`);
  logger.log(`Worker: ${config.get('WORKER_ENABLED') === 'false' ? 'disabled' : 'enabled'}`);

  startLeadWatcher();

  const shutdown = (signal: string): void => {
    logger.log(`${signal} received, shutting down`);
    void app
      .close()
      .then(() => prisma.$disconnect())
      .then(() => process.exit(0));
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

void bootstrap();
