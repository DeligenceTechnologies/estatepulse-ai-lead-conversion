-- Duplicate lead intelligence: one lead per person.
--   * leads.merged_into_id / merged_at: a merged lead is kept (for undo and history) but hidden everywhere.
--   * lead_submissions: every time a person arrived from any source, including submissions attached to an
--     existing lead; the is_original row is the source the lead first came from.
--   * lead_merges: the merge log, with what is needed to undo a merge.
--   * duplicate_candidates: pairs that look like the same person, waiting to be merged or dismissed.
-- Written to be re-runnable (IF NOT EXISTS / guarded), like the earlier catch-up migrations.

DO $$ BEGIN
  CREATE TYPE "duplicate_candidate_status" AS ENUM ('open', 'merged', 'dismissed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "merged_at" TIMESTAMPTZ(6);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "merged_into_id" UUID;

CREATE TABLE IF NOT EXISTS "lead_submissions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "lead_source_id" UUID,
    "channel" VARCHAR(20) NOT NULL,
    "ingest_event_id" UUID,
    "sheet_import_row_id" UUID,
    "matched_by" VARCHAR(10),
    "is_original" BOOLEAN NOT NULL DEFAULT false,
    "values" JSONB NOT NULL DEFAULT '{}',
    "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "lead_submissions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "lead_merges" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "survivor_id" UUID NOT NULL,
    "merged_id" UUID NOT NULL,
    "actor_type" "actor_type" NOT NULL,
    "actor_id" UUID,
    "reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "survivor_before" JSONB NOT NULL,
    "moved_rows" JSONB NOT NULL,
    "removed_rows" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undone_at" TIMESTAMPTZ(6),
    "undone_by_id" UUID,
    CONSTRAINT "lead_merges_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "duplicate_candidates" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "lead_a_id" UUID NOT NULL,
    "lead_b_id" UUID NOT NULL,
    "score" INTEGER NOT NULL,
    "reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "duplicate_candidate_status" NOT NULL DEFAULT 'open',
    "resolved_by_id" UUID,
    "resolved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "duplicate_candidates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "lead_submissions_lead_id_submitted_at_idx" ON "lead_submissions"("lead_id", "submitted_at");
CREATE INDEX IF NOT EXISTS "lead_submissions_organization_id_lead_source_id_idx" ON "lead_submissions"("organization_id", "lead_source_id");
CREATE INDEX IF NOT EXISTS "lead_merges_survivor_id_created_at_idx" ON "lead_merges"("survivor_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "lead_merges_merged_id_idx" ON "lead_merges"("merged_id");
CREATE INDEX IF NOT EXISTS "duplicate_candidates_organization_id_status_score_idx" ON "duplicate_candidates"("organization_id", "status", "score" DESC);
CREATE INDEX IF NOT EXISTS "duplicate_candidates_lead_b_id_idx" ON "duplicate_candidates"("lead_b_id");
CREATE UNIQUE INDEX IF NOT EXISTS "duplicate_candidates_lead_a_id_lead_b_id_key" ON "duplicate_candidates"("lead_a_id", "lead_b_id");
CREATE INDEX IF NOT EXISTS "leads_organization_id_merged_into_id_idx" ON "leads"("organization_id", "merged_into_id");

DO $$ BEGIN
  ALTER TABLE "leads" ADD CONSTRAINT "leads_merged_into_id_fkey" FOREIGN KEY ("merged_into_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "lead_submissions" ADD CONSTRAINT "lead_submissions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "lead_submissions" ADD CONSTRAINT "lead_submissions_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "lead_submissions" ADD CONSTRAINT "lead_submissions_lead_source_id_fkey" FOREIGN KEY ("lead_source_id") REFERENCES "lead_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "lead_merges" ADD CONSTRAINT "lead_merges_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "duplicate_candidates" ADD CONSTRAINT "duplicate_candidates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "duplicate_candidates" ADD CONSTRAINT "duplicate_candidates_lead_a_id_fkey" FOREIGN KEY ("lead_a_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "duplicate_candidates" ADD CONSTRAINT "duplicate_candidates_lead_b_id_fkey" FOREIGN KEY ("lead_b_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Backfill: every existing lead gets its original submission, so "where did this person first come from"
-- survives a later merge. Re-runnable: skips leads that already have an original row.
INSERT INTO "lead_submissions" ("id", "organization_id", "lead_id", "lead_source_id", "channel", "is_original", "submitted_at", "created_at")
SELECT gen_random_uuid(), l."organization_id", l."id", l."lead_source_id", 'backfill', true,
       l."created_at", now()
FROM "leads" l
WHERE NOT EXISTS (SELECT 1 FROM "lead_submissions" s WHERE s."lead_id" = l."id" AND s."is_original");
