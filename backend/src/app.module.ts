import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { z } from 'zod';
import { AuthModule } from './auth/auth.module';
import { HealthController } from './health.controller';
import { EventsModule } from './modules/events/events.module';
import { PortalIngestModule } from './ingest/portal-ingest.module';
import { AgentsModule } from './modules/agents/agents.module';
import { CalendarModule } from './modules/calendar/calendar.module';
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
/**
 * Exported so a test module can boot with the SAME defaults the server does.
 *
 * Several settings — CALENDLY_API_BASE_URL and CALENDLY_AUTH_BASE_URL among
 * them — exist only as `.default()` here and are absent from .env. A test that
 * builds a bare ConfigModule therefore gets a config where getOrThrow() throws
 * on a key the real server always has, which surfaces as a 502 that looks like
 * a product bug.
 */
export const envSchema = z.object({
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

  // --- calendar (Calendly) ---
  // Optional so the app still boots with no Calendly app registered: the
  // connect endpoint then answers "not configured" and the UI says so, which
  // is a better failure than refusing to start the whole API.
  CALENDLY_CLIENT_ID: z.string().optional(),
  CALENDLY_CLIENT_SECRET: z.string().optional(),
  // Space-separated, and only needed when the registered Calendly app is
  // approved for a NARROWER set than we ask for by default. Calendly rejects
  // the whole authorize request if `scope` names anything the app does not
  // hold, on its own error page, so there is no way to discover this from here.
  // See CalendlyClientService.scopes for what each one buys.
  CALENDLY_SCOPES: z.string().optional(),
  // The FULL redirect URI, registered character for character in the Calendly
  // console. Optional: it defaults to
  // `${PUBLIC_API_BASE_URL}/api/calendly/oauth/callback`.
  //
  // Set it when that default is not what you want to register — typically in
  // development, where PUBLIC_API_BASE_URL is a tunnel (whose hostname changes
  // on every restart) because Tally's webhook ingest needs a public HTTPS URL,
  // while a Calendly SANDBOX app is happy with http://localhost:4000.
  CALENDLY_REDIRECT_URI: z.string().url().optional(),
  // The SPA's origin — where the OAuth popup posts its result back to. This is
  // the browser app, NOT the API (that one is PUBLIC_API_BASE_URL, which is
  // where Calendly redirects). In production they are different hosts, and
  // postMessage cannot be given '*' without leaking the result to any page.
  PUBLIC_APP_URL: z.string().url().default('http://localhost:3000'),
  // Opt-in by design, the exact string "1", exactly like STRATEGY_ENGINE: this
  // loop writes appointments and moves lead statuses, and must never start
  // doing that by accident against a shared development database.
  CALENDAR_SYNC: z.string().optional(),
  CALENDAR_POLL_MS: z.coerce.number().default(300_000),
  CALENDAR_WINDOW_PAST_DAYS: z.coerce.number().default(7),
  CALENDAR_WINDOW_FUTURE_DAYS: z.coerce.number().default(90),
  // Overridable for the same reason as TALLY_API_BASE_URL: a fake server can
  // produce the 401/403/invalid_grant paths a real free-plan account will not.
  CALENDLY_API_BASE_URL: z.string().url().default('https://api.calendly.com'),
  CALENDLY_AUTH_BASE_URL: z.string().url().default('https://auth.calendly.com'),
  // Cal.com, the other scheduling provider. Nothing here is required: an office
  // pastes its own API key, so unlike Calendly there is no server-side app to
  // register and no way for this deployment to be "not configured" for it.
  CALCOM_API_BASE_URL: z.string().url().default('https://api.cal.com/v2'),
  // The public booking host, NOT derived from the API host — see .env.example.
  CALCOM_BOOKING_BASE_URL: z.string().url().default('https://cal.com'),
  // Cal.com versions endpoints by date; an unset header silently selects an
  // older response shape rather than failing.
  CALCOM_API_VERSION: z.string().default('2026-06-12'),
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

    // Global: the live event stream every screen listens on. Registered before
    // its publishers so the bus exists whichever of them boots first.
    EventsModule,

    // Portal: auth, agent management, AI calling, the simple lead webhook.
    AuthModule,
    AgentsModule,
    TelnyxModule,
    PortalIngestModule,

    // Calendar: agent-owned Calendly connections, working hours, and the
    // appointment sync. After TelnyxModule, whose EngineService it uses to stop
    // the outbound cadence once a lead has booked.
    CalendarModule,

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
