import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { z } from 'zod';
import { AuthModule } from './auth/auth.module';
import { HealthController } from './health.controller';
import { EventsModule } from './modules/events/events.module';
import { PortalIngestModule } from './ingest/portal-ingest.module';
import { AgentsModule } from './modules/agents/agents.module';
import { IngestModule } from './modules/ingest/ingest.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { LeadSourcesModule } from './modules/lead-sources/lead-sources.module';
import { LeadsModule } from './modules/leads/leads.module';
import { ProcessingModule } from './modules/processing/processing.module';
import { ProvidersModule } from './modules/providers/providers.module';
import { PrismaModule } from './prisma/prisma.module';
import { TelnyxModule } from './telnyx/telnyx.module';

/**
 * Fail fast on misconfiguration at boot rather than at the first request.
 * A missing ENCRYPTION_KEYS discovered when a real lead arrives is a lost lead,
 * and a missing JWT_SECRET discovered at the first login is an outage.
 */
const envSchema = z.object({
  // --- database ---
  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url(),

  // --- sessions ---
  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 characters')
    .refine((v) => !v.includes('CHANGE_ME'), 'JWT_SECRET is still the placeholder from .env.example'),
  JWT_ISSUER: z.string().min(1).default('estatepulse'),

  // --- http ---
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),
  // Comma-separated exact origins. Empty in dev, where the Vite proxy makes the
  // API same-origin and CORS never comes into play.
  CORS_ORIGINS: z.string().default(''),

  // Public bases for the URLs we hand to third parties. Both must be reachable
  // from the internet in production; a localhost value is accepted by providers
  // and then never called.
  PUBLIC_API_BASE_URL: z.string().url(),
  PUBLIC_API_URL: z.string().url().default('http://localhost:4000'),

  // --- encryption ---
  // Form-provider credentials and webhook signing secrets (AES-256-GCM, AAD-bound).
  ENCRYPTION_KEYS: z.string().min(1),
  ENCRYPTION_ACTIVE_KEY_ID: z.string().min(1),
  // Telnyx credentials, a separate older scheme. See telnyx/secret-cipher.service.ts.
  ENCRYPTION_KEY: z.string().optional(),

  // --- ingestion worker ---
  WORKER_ENABLED: z.string().default('true'),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().default(1000),
  WORKER_BATCH_SIZE: z.coerce.number().default(10),
  WORKER_STUCK_AFTER_MS: z.coerce.number().default(300_000),
  INGEST_MAX_BODY_BYTES: z.coerce.number().default(1_048_576),

  // --- AI calling ---
  // Opt-in by design: the exact string "1", so it never starts calling real
  // people by accident against a shared development database.
  STRATEGY_ENGINE: z.string().optional(),
  ENGINE_POLL_MS: z.coerce.number().default(15_000),

  // Overridable so scripts/fake-tally.mjs can stand in for the real API —
  // including the 401/429/5xx paths a real account will not produce on demand.
  TALLY_API_BASE_URL: z.string().url().default('https://api.tally.so'),
  PROVIDER_HTTP_TIMEOUT_MS: z.coerce.number().default(10_000),
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
          throw new Error(`Invalid environment configuration:\n${issues}\n\nSee backend/.env.example`);
        }
        return { ...raw, ...parsed.data };
      },
    }),
    PrismaModule,

<<<<<<< HEAD
    // Portal: auth, agent management, AI calling, the simple lead webhook.
=======
    // Global: the live event stream every screen listens on. Registered before
    // its publishers so the bus exists whichever of them boots first.
    EventsModule,

    // Portal: auth, AI calling, the simple lead webhook.
>>>>>>> origin/sunny-webkook
    AuthModule,
    AgentsModule,
    TelnyxModule,
    PortalIngestModule,

    // Ingestion: form-provider webhooks, mapping, the processing worker.
    IngestModule,
    LeadSourcesModule,
    LeadsModule,
    ProcessingModule,
    ProvidersModule,
    IntegrationsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
