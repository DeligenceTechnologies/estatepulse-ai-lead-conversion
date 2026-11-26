-- Integrations are moving to Nango: drop the old Google Sheets / Forms, HubSpot,
-- Airtable, Tally, Typeform, custom webhook and file import plumbing.
-- Leads, lead sources and Telnyx accounts stay.

-- Only Telnyx accounts stay in integrations.
DELETE FROM "integrations" WHERE "provider"::text <> 'telnyx';


-- AlterEnum
BEGIN;
CREATE TYPE "integration_provider_new" AS ENUM ('telnyx');
ALTER TABLE "integrations" ALTER COLUMN "provider" TYPE "integration_provider_new" USING ("provider"::text::"integration_provider_new");
ALTER TYPE "integration_provider" RENAME TO "integration_provider_old";
ALTER TYPE "integration_provider_new" RENAME TO "integration_provider";
DROP TYPE "integration_provider_old";
COMMIT;

-- DropForeignKey
ALTER TABLE "crm_sync_runs" DROP CONSTRAINT "crm_sync_runs_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "crm_sync_runs" DROP CONSTRAINT "crm_sync_runs_lead_source_id_fkey";

-- DropForeignKey
ALTER TABLE "crm_sync_runs" DROP CONSTRAINT "crm_sync_runs_requested_by_fkey";

-- DropForeignKey
ALTER TABLE "lead_sources" DROP CONSTRAINT "lead_sources_integration_id_fkey";

-- DropForeignKey
ALTER TABLE "lead_source_fields" DROP CONSTRAINT "lead_source_fields_lead_source_id_fkey";

-- DropForeignKey
ALTER TABLE "lead_source_field_mappings" DROP CONSTRAINT "lead_source_field_mappings_lead_source_id_fkey";

-- DropForeignKey
ALTER TABLE "ingest_events" DROP CONSTRAINT "ingest_events_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "ingest_events" DROP CONSTRAINT "ingest_events_lead_source_id_fkey";

-- DropForeignKey
ALTER TABLE "ingest_events" DROP CONSTRAINT "ingest_events_lead_id_fkey";

-- DropForeignKey
ALTER TABLE "sheet_import_rows" DROP CONSTRAINT "sheet_import_rows_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "sheet_import_rows" DROP CONSTRAINT "sheet_import_rows_lead_source_id_fkey";

-- DropForeignKey
ALTER TABLE "sheet_import_rows" DROP CONSTRAINT "sheet_import_rows_lead_id_fkey";

-- DropForeignKey
ALTER TABLE "sheet_import_rows" DROP CONSTRAINT "sheet_import_rows_reviewed_by_fkey";

-- DropIndex
DROP INDEX "lead_sources_ingest_token_hash_key";

-- AlterTable
ALTER TABLE "lead_sources" DROP COLUMN "custom_config",
DROP COLUMN "default_consent_status",
DROP COLUMN "external_form_id",
DROP COLUMN "external_form_name",
DROP COLUMN "external_webhook_id",
DROP COLUMN "ingest_status",
DROP COLUMN "ingest_token_enc",
DROP COLUMN "ingest_token_hash",
DROP COLUMN "ingest_token_prefix",
DROP COLUMN "integration_id",
DROP COLUMN "last_event_at",
DROP COLUMN "last_failure_at",
DROP COLUMN "last_success_at",
DROP COLUMN "mapping_status",
DROP COLUMN "mapping_version",
DROP COLUMN "prebuilt_at",
DROP COLUMN "previous_secret_enc",
DROP COLUMN "previous_secret_valid_until",
DROP COLUMN "remote_error_code",
DROP COLUMN "remote_error_message",
DROP COLUMN "remote_state",
DROP COLUMN "remote_synced_at",
DROP COLUMN "require_signature",
DROP COLUMN "schema_fingerprint",
DROP COLUMN "signing_secret_enc",
DROP COLUMN "signing_secret_last4",
DROP COLUMN "signing_secret_set_at",
DROP COLUMN "sync_config",
DROP COLUMN "sync_failures",
DROP COLUMN "sync_fallback_ack_at",
DROP COLUMN "sync_fallback_ack_by",
DROP COLUMN "sync_locked_at",
DROP COLUMN "sync_locked_by",
DROP COLUMN "sync_next_at",
DROP COLUMN "sync_remote_version",
DROP COLUMN "sync_row_key_field";

-- AlterTable
ALTER TABLE "lead_submissions" DROP COLUMN "ingest_event_id",
DROP COLUMN "sheet_import_row_id";

-- DropTable
DROP TABLE "crm_sync_runs";

-- DropTable
DROP TABLE "lead_source_fields";

-- DropTable
DROP TABLE "lead_source_field_mappings";

-- DropTable
DROP TABLE "ingest_events";

-- DropTable
DROP TABLE "sheet_import_rows";

-- DropEnum
DROP TYPE "crm_sync_run_kind";

-- DropEnum
DROP TYPE "crm_sync_run_status";

-- DropEnum
DROP TYPE "lead_source_ingest_status";

-- DropEnum
DROP TYPE "lead_source_mapping_status";

-- DropEnum
DROP TYPE "remote_webhook_state";

-- DropEnum
DROP TYPE "lead_source_field_status";

-- DropEnum
DROP TYPE "mapping_origin";

-- DropEnum
DROP TYPE "ingest_queue_state";

-- DropEnum
DROP TYPE "ingest_outcome";

-- DropEnum
DROP TYPE "signature_state";

-- DropEnum
DROP TYPE "import_review_state";

