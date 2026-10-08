import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';

import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const config = app.get(ConfigService);
  const port = config.get<number>('PORT', 4000);

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
