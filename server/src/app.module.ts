import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { z } from 'zod';
import { HealthController } from './health.controller';
import { IngestModule } from './modules/ingest/ingest.module';
import { LeadSourcesModule } from './modules/lead-sources/lead-sources.module';
import { LeadsModule } from './modules/leads/leads.module';
import { ProcessingModule } from './modules/processing/processing.module';
import { PrismaModule } from './prisma/prisma.module';

/**
 * Fail fast on misconfiguration at boot rather than at the first webhook.
 * A missing ENCRYPTION_KEYS discovered when a real lead arrives is a lost lead.
 */
const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url(),
  ENCRYPTION_KEYS: z.string().min(1),
  ENCRYPTION_ACTIVE_KEY_ID: z.string().min(1),
  PUBLIC_API_BASE_URL: z.string().url(),
  PORT: z.coerce.number().default(3001),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  WORKER_ENABLED: z.string().default('true'),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().default(1000),
  WORKER_BATCH_SIZE: z.coerce.number().default(10),
  WORKER_STUCK_AFTER_MS: z.coerce.number().default(300_000),
  INGEST_MAX_BODY_BYTES: z.coerce.number().default(1_048_576),
});

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (raw) => {
        const parsed = envSchema.safeParse(raw);
        if (!parsed.success) {
          const issues = parsed.error.issues
            .map((i) => `  ${i.path.join('.')}: ${i.message}`)
            .join('\n');
          throw new Error(`Invalid environment configuration:\n${issues}\n\nSee server/.env.example`);
        }
        return { ...raw, ...parsed.data };
      },
    }),
    PrismaModule,
    IngestModule,
    LeadSourcesModule,
    LeadsModule,
    ProcessingModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
