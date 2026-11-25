-- Nango holds every connected account's credential (OAuth grants and API
-- keys alike); our tables keep the account, its setup and the Nango
-- connection id, never a token. One integrations row per connected account,
-- calendars included: calendar_connections now points at its integration.
--
-- Written for a fresh database. Credentials stored before this cannot be
-- carried into Nango, so the columns holding them are dropped and calendar
-- connections (which had no integrations row) are removed: every account is
-- connected again through Nango Connect.

-- Calendly and Cal.com become integrations like every other provider.
ALTER TYPE "integration_provider" ADD VALUE IF NOT EXISTS 'calendly';
ALTER TYPE "integration_provider" ADD VALUE IF NOT EXISTS 'cal';

-- integrations: the Nango connection replaces the sealed credential.
ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "nango_connection_id" VARCHAR(255);
CREATE UNIQUE INDEX IF NOT EXISTS "integrations_nango_connection_id_key" ON "integrations" ("nango_connection_id");
ALTER TABLE "integrations" DROP COLUMN IF EXISTS "credentials";
ALTER TABLE "integrations" DROP COLUMN IF EXISTS "credential_hash";

-- calendar_connections: linked to the integration whose credential it reads with.
DELETE FROM "calendar_connections";
ALTER TABLE "calendar_connections" DROP COLUMN IF EXISTS "credentials";
ALTER TABLE "calendar_connections" DROP COLUMN IF EXISTS "token_expires_at";
ALTER TABLE "calendar_connections" DROP COLUMN IF EXISTS "nango_connection_id";
ALTER TABLE "calendar_connections" ADD COLUMN "integration_id" UUID NOT NULL;
CREATE UNIQUE INDEX "calendar_connections_integration_id_key" ON "calendar_connections" ("integration_id");
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_integration_id_fkey"
  FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Nango webhook deliveries, recorded once each.
DO $$ BEGIN
  CREATE TYPE "nango_webhook_event_status" AS ENUM ('received', 'processed', 'ignored', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "nango_webhook_events" (
  "id" UUID NOT NULL,
  "dedupe_key" VARCHAR(64) NOT NULL,
  "type" VARCHAR(30) NOT NULL,
  "operation" VARCHAR(30),
  "provider_config_key" VARCHAR(255),
  "connection_id" VARCHAR(255),
  "success" BOOLEAN,
  "status" "nango_webhook_event_status" NOT NULL DEFAULT 'received',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "error" VARCHAR(500),
  "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" TIMESTAMPTZ(6),
  CONSTRAINT "nango_webhook_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "nango_webhook_events_dedupe_key_key" ON "nango_webhook_events" ("dedupe_key");
CREATE INDEX IF NOT EXISTS "nango_webhook_events_connection_id_idx" ON "nango_webhook_events" ("connection_id");
CREATE INDEX IF NOT EXISTS "nango_webhook_events_status_received_at_idx" ON "nango_webhook_events" ("status", "received_at");
