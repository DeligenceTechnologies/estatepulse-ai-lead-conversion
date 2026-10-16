-- CRM sync, HubSpot first (ported from development: d0fcdb6, fad92b4).
--
-- Built on what already exists, like the Google Sheets import:
--   * the HubSpot OAuth grant is an integrations row (provider 'hubspot'),
--     its refresh token sealed to the row;
--   * the connection's import is a lead_sources row (provider 'HUBSPOT',
--     connection_method 'SYNC', external_form_id = the HubSpot account id);
--   * each imported contact is a sheet_import_rows row, so the existing Import
--     Review queue holds imported leads for approval;
--   * webhook deliveries are ingest_events rows (provider 'HUBSPOT');
--   * history goes to audit_logs.
--
-- Additive only: one new table, two nullable columns, and indexes. Nothing
-- existing is rewritten, renamed or dropped.

-- CreateEnum
CREATE TYPE "crm_sync_run_kind" AS ENUM ('initial', 'full');

-- CreateEnum
CREATE TYPE "crm_sync_run_status" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');

-- AlterTable
ALTER TABLE "sheet_import_rows" ADD COLUMN     "last_seen_at" TIMESTAMPTZ(6),
ADD COLUMN     "synced_values" JSONB;

-- CreateTable
CREATE TABLE "crm_sync_runs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "lead_source_id" UUID NOT NULL,
    "provider" "lead_source_provider" NOT NULL,
    "kind" "crm_sync_run_kind" NOT NULL,
    "status" "crm_sync_run_status" NOT NULL DEFAULT 'queued',
    "requested_by" UUID,
    "cursor" VARCHAR(255),
    "pages" INTEGER NOT NULL DEFAULT 0,
    "fetched" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "unchanged" INTEGER NOT NULL DEFAULT 0,
    "linked" INTEGER NOT NULL DEFAULT 0,
    "conflicts" INTEGER NOT NULL DEFAULT 0,
    "duplicates" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "missing" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "error_code" VARCHAR(50),
    "error_message" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "heartbeat_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "crm_sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "crm_sync_runs_organization_id_lead_source_id_created_at_idx" ON "crm_sync_runs"("organization_id", "lead_source_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "crm_sync_runs" ADD CONSTRAINT "crm_sync_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_sync_runs" ADD CONSTRAINT "crm_sync_runs_lead_source_id_fkey" FOREIGN KEY ("lead_source_id") REFERENCES "lead_sources"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_sync_runs" ADD CONSTRAINT "crm_sync_runs_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Constraints and partial indexes Prisma cannot express.

-- A finished run says when; an unfinished one does not. Counters never go negative.
ALTER TABLE "crm_sync_runs"
  ADD CONSTRAINT "crm_sync_runs_finished_check"
  CHECK (("status" IN ('succeeded', 'failed', 'cancelled')) = ("finished_at" IS NOT NULL));

ALTER TABLE "crm_sync_runs"
  ADD CONSTRAINT "crm_sync_runs_counts_check"
  CHECK ("pages" >= 0 AND "fetched" >= 0 AND "created" >= 0 AND "updated" >= 0 AND "unchanged" >= 0 AND "linked" >= 0
     AND "conflicts" >= 0 AND "duplicates" >= 0 AND "skipped" >= 0 AND "failed" >= 0 AND "missing" >= 0 AND "attempts" >= 0);

-- One active run per connection: "Sync now" clicked twice, two tabs, or a
-- reconnect racing a click all land on the run already in progress.
CREATE UNIQUE INDEX "crm_sync_runs_one_active"
  ON "crm_sync_runs" ("lead_source_id")
  WHERE "status" IN ('queued', 'running');

-- One live HubSpot connection per organization...
CREATE UNIQUE INDEX "integrations_one_live_hubspot"
  ON "integrations" ("organization_id")
  WHERE "provider" = 'hubspot' AND "revoked_at" IS NULL;

-- ...and a HubSpot account is live in at most one organization.
CREATE UNIQUE INDEX "integrations_hubspot_account_live"
  ON "integrations" ("external_account_id")
  WHERE "provider" = 'hubspot' AND "revoked_at" IS NULL;

-- Webhook: which connection does this CRM account belong to?
CREATE INDEX "lead_sources_crm_account"
  ON "lead_sources" ("provider", "external_form_id")
  WHERE "connection_method" = 'SYNC' AND "archived_at" IS NULL;

-- Worker: a connection's pending deliveries.
CREATE INDEX "ingest_events_source_pending"
  ON "ingest_events" ("lead_source_id", "available_at")
  WHERE "queue_state" = 'PENDING';
