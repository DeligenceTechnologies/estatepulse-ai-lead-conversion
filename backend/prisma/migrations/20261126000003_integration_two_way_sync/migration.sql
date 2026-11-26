-- Two-way integration sync (additive only: new nullable/defaulted columns and one index).
-- Existing connections keep write-back OFF until an owner turns it on; nothing is rewritten.
-- AlterTable
ALTER TABLE "integration_connections" ADD COLUMN     "write_back_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "write_back_error" VARCHAR(500),
ADD COLUMN     "write_back_error_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "integration_records" ADD COLUMN     "local_checked_at" TIMESTAMPTZ(6),
ADD COLUMN     "push_error" VARCHAR(500),
ADD COLUMN     "push_error_at" TIMESTAMPTZ(6),
ADD COLUMN     "pushed_at" TIMESTAMPTZ(6),
ADD COLUMN     "sync_state" JSONB;

-- CreateIndex
CREATE INDEX "integration_records_connection_id_push_error_at_idx" ON "integration_records"("connection_id", "push_error_at");

