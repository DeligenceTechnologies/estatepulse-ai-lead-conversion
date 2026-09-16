import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // CRITICAL: exposes req.rawBody, the exact bytes as received.
    //
    // Tally's signature is base64(HMAC-SHA256(secret, rawBody)). Verifying
    // against JSON.stringify(req.body) instead produces different bytes — key
    // order, whitespace and unicode escaping all differ — and EVERY signature
    // fails. This one flag is the difference between working and mysteriously
    // broken. See crypto.spec.ts for the test that pins this behaviour.
    rawBody: true,
  });

  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  // Cap request size. Tally payloads are single-digit KB; anything near this
  // limit is abuse or a misconfiguration.
  const maxBytes = Number(config.get('INGEST_MAX_BODY_BYTES') ?? 1_048_576);
  app.useBodyParser('json', { limit: maxBytes });

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  const origins = (config.get<string>('CORS_ORIGINS') ?? 'http://localhost:3000')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.enableCors({
    origin: origins,
    credentials: true,
    allowedHeaders: ['Content-Type', 'X-Api-Key', 'X-Request-Id'],
  });

  const port = Number(config.get('PORT') ?? 3001);
  await app.listen(port, '0.0.0.0');

  logger.log(`API listening on :${port}`);
  logger.log(`Ingest base: ${config.get('PUBLIC_API_BASE_URL')}/ingest/v1/tally/:token`);
  logger.log(`Worker: ${config.get('WORKER_ENABLED') === 'false' ? 'disabled' : 'enabled'}`);
}

void bootstrap();
