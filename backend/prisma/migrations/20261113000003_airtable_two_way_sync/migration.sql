-- Airtable, phase 3: writing back, and keeping the two sides apart.
--
-- No new tables. A synced Airtable table is already a lead_sources row and each
-- synced record is already a sheet_import_rows row; both gain the few columns
-- the outbound half needs.

-- Which way records flow for this source, and what happens when both sides
-- changed: { "direction": "import|export|two_way", "conflictPolicy": "review|airtable_wins|estatepulse_wins" }.
-- NULL on every source that is not Airtable.
ALTER TABLE "lead_sources" ADD COLUMN IF NOT EXISTS "sync_config" JSONB;

-- The outbound half of a two-way source.
--
-- "pushed_hash" is the fingerprint of the lead values last WRITTEN to the
-- provider. When a change comes back from Airtable, comparing what arrived
-- against this is what tells our own echo apart from a person's edit — which is
-- what stops a write/notify/write loop. The rest is the retry state for one
-- record's push, so a single failing record backs off on its own instead of
-- holding up the table.
ALTER TABLE "sheet_import_rows" ADD COLUMN IF NOT EXISTS "pushed_hash" VARCHAR(64);
ALTER TABLE "sheet_import_rows" ADD COLUMN IF NOT EXISTS "pushed_at" TIMESTAMPTZ(6);
ALTER TABLE "sheet_import_rows" ADD COLUMN IF NOT EXISTS "push_attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "sheet_import_rows" ADD COLUMN IF NOT EXISTS "push_available_at" TIMESTAMPTZ(6);
ALTER TABLE "sheet_import_rows" ADD COLUMN IF NOT EXISTS "push_error_code" VARCHAR(50);
ALTER TABLE "sheet_import_rows" ADD COLUMN IF NOT EXISTS "push_error" VARCHAR(500);

-- Wrapped because PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS, and every
-- other statement in this file is idempotent. A migration that fails partway
-- must be safe to run again.
DO $$ BEGIN
  ALTER TABLE "sheet_import_rows"
    ADD CONSTRAINT "sheet_import_rows_push_attempts_check" CHECK ("push_attempts" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The worker's queue: rows of one source whose push is due. Partial, so it
-- stays small — a row is only in it while it is waiting to be written.
CREATE INDEX IF NOT EXISTS "sheet_import_rows_push_due"
  ON "sheet_import_rows" ("lead_source_id", "push_available_at")
  WHERE "push_available_at" IS NOT NULL;

-- Finding the source a webhook belongs to, by the Airtable webhook id it names.
CREATE INDEX IF NOT EXISTS "lead_sources_airtable_webhook"
  ON "lead_sources" ("external_webhook_id")
  WHERE "provider" = 'AIRTABLE' AND "archived_at" IS NULL;

-- One live source per Airtable base+table PER ORGANIZATION.
--
-- Scoped to the organization rather than the deployment: two organizations may
-- legitimately sync the same table — an agency and the client whose base it is
-- routinely share one. A deployment-wide index would let whichever connected
-- first lock every other organization out of that table for good, and would
-- tell the second one that somebody else holds it.
--
-- If two organizations do sync one table two-way, their writes can overwrite
-- each other. That is a choice for the owners of the base, not ours to block.
CREATE UNIQUE INDEX IF NOT EXISTS "lead_sources_airtable_table_live"
  ON "lead_sources" ("organization_id", "external_form_id")
  WHERE "provider" = 'AIRTABLE' AND "archived_at" IS NULL;
