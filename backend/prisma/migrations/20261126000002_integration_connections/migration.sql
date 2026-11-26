-- Integration Marketplace (Nango): one row per connected third-party account.
-- Additive only: three new tables and three enums; nothing existing is changed or dropped.
-- Several accounts of the same provider per organization are allowed: there is
-- deliberately no unique index on (organization_id, provider).

-- CreateEnum
CREATE TYPE "integration_connection_status" AS ENUM ('connected', 'reauth_required', 'error', 'disconnected');

-- CreateEnum
CREATE TYPE "integration_sync_status" AS ENUM ('queued', 'running', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "integration_sync_trigger" AS ENUM ('manual', 'connected', 'webhook', 'schedule');

-- CreateTable
CREATE TABLE "integration_connections" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "provider" VARCHAR(100) NOT NULL,
    "provider_config_key" VARCHAR(255) NOT NULL,
    "nango_connection_id" VARCHAR(255) NOT NULL,
    "status" "integration_connection_status" NOT NULL DEFAULT 'connected',
    "account_name" VARCHAR(255),
    "account_email" VARCHAR(255),
    "external_account_id" VARCHAR(255),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "lead_source_id" UUID,
    "connected_by_id" UUID,
    "last_synced_at" TIMESTAMPTZ(6),
    "last_error_code" VARCHAR(64),
    "last_error_message" VARCHAR(500),
    "last_error_at" TIMESTAMPTZ(6),
    "disconnected_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "integration_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_sync_runs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "trigger" "integration_sync_trigger" NOT NULL,
    "status" "integration_sync_status" NOT NULL DEFAULT 'queued',
    "requested_by_id" UUID,
    "job_id" VARCHAR(255),
    "stats" JSONB NOT NULL DEFAULT '{}',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error_message" VARCHAR(500),
    "queued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "integration_sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_records" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "object_type" VARCHAR(100) NOT NULL,
    "external_id" VARCHAR(255) NOT NULL,
    "lead_id" UUID,
    "content_hash" VARCHAR(64) NOT NULL,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "integration_connections_nango_connection_id_key" ON "integration_connections"("nango_connection_id");

-- CreateIndex
CREATE INDEX "integration_connections_organization_id_provider_status_idx" ON "integration_connections"("organization_id", "provider", "status");

-- CreateIndex
CREATE INDEX "integration_connections_organization_id_created_at_idx" ON "integration_connections"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "integration_sync_runs_connection_id_queued_at_idx" ON "integration_sync_runs"("connection_id", "queued_at" DESC);

-- CreateIndex
CREATE INDEX "integration_sync_runs_organization_id_status_idx" ON "integration_sync_runs"("organization_id", "status");

-- CreateIndex
CREATE INDEX "integration_records_organization_id_lead_id_idx" ON "integration_records"("organization_id", "lead_id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_records_connection_id_object_type_external_id_key" ON "integration_records"("connection_id", "object_type", "external_id");

-- AddForeignKey
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_lead_source_id_fkey" FOREIGN KEY ("lead_source_id") REFERENCES "lead_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_sync_runs" ADD CONSTRAINT "integration_sync_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_sync_runs" ADD CONSTRAINT "integration_sync_runs_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_records" ADD CONSTRAINT "integration_records_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_records" ADD CONSTRAINT "integration_records_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- At most one sync queued or running per connection: a double click, a retry and a
-- webhook racing each other all land on the run already in progress.
CREATE UNIQUE INDEX "integration_sync_runs_one_active"
  ON "integration_sync_runs" ("connection_id")
  WHERE "status" IN ('queued', 'running');
