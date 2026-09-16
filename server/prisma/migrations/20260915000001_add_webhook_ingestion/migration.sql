-- AlterTable
ALTER TABLE "lead_sources" ADD COLUMN     "archived_at" TIMESTAMPTZ(6),
ADD COLUMN     "auto_create_leads" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "default_consent_status" VARCHAR(20) NOT NULL DEFAULT 'pending',
ADD COLUMN     "default_lead_type" VARCHAR(20) NOT NULL DEFAULT 'buyer',
ADD COLUMN     "external_form_id" VARCHAR(255),
ADD COLUMN     "external_form_name" VARCHAR(255),
ADD COLUMN     "ingest_status" VARCHAR(30),
ADD COLUMN     "ingest_token_enc" TEXT,
ADD COLUMN     "ingest_token_hash" VARCHAR(64),
ADD COLUMN     "ingest_token_prefix" VARCHAR(32),
ADD COLUMN     "last_event_at" TIMESTAMPTZ(6),
ADD COLUMN     "last_failure_at" TIMESTAMPTZ(6),
ADD COLUMN     "last_success_at" TIMESTAMPTZ(6),
ADD COLUMN     "mapping_status" VARCHAR(30),
ADD COLUMN     "mapping_version" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "previous_secret_enc" TEXT,
ADD COLUMN     "previous_secret_valid_until" TIMESTAMPTZ(6),
ADD COLUMN     "require_signature" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "schema_fingerprint" VARCHAR(64),
ADD COLUMN     "signing_secret_enc" TEXT,
ADD COLUMN     "signing_secret_last4" VARCHAR(8),
ADD COLUMN     "signing_secret_set_at" TIMESTAMPTZ(6),
ADD COLUMN     "token_rotated_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "webhook_events" ADD COLUMN     "available_at" TIMESTAMPTZ(6),
ADD COLUMN     "content_length" INTEGER,
ADD COLUMN     "dedupe_key" VARCHAR(128),
ADD COLUMN     "error_fingerprint" VARCHAR(64),
ADD COLUMN     "headers" JSONB,
ADD COLUMN     "is_test" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lead_id" UUID,
ADD COLUMN     "lead_source_id" UUID,
ADD COLUMN     "locked_at" TIMESTAMPTZ(6),
ADD COLUMN     "locked_by" VARCHAR(100),
ADD COLUMN     "mapping_trace" JSONB,
ADD COLUMN     "mapping_version_used" INTEGER,
ADD COLUMN     "max_attempts" INTEGER NOT NULL DEFAULT 6,
ADD COLUMN     "outcome" VARCHAR(30),
ADD COLUMN     "outcome_reason" VARCHAR(100),
ADD COLUMN     "payload_hash" VARCHAR(64),
ADD COLUMN     "processing_ms" INTEGER,
ADD COLUMN     "provider_created_at" TIMESTAMPTZ(6),
ADD COLUMN     "provider_form_id" VARCHAR(255),
ADD COLUMN     "provider_submission_id" VARCHAR(255),
ADD COLUMN     "queue_state" VARCHAR(20),
ADD COLUMN     "raw_body" TEXT,
ADD COLUMN     "raw_body_purged_at" TIMESTAMPTZ(6),
ADD COLUMN     "replay_of_id" UUID,
ADD COLUMN     "signature_state" VARCHAR(20),
ADD COLUMN     "used_previous_secret" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "warnings" JSONB;

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "key_hash" VARCHAR(64) NOT NULL,
    "key_prefix" VARCHAR(32) NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "last_used_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_source_fields" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "lead_source_id" UUID NOT NULL,
    "field_key" VARCHAR(255) NOT NULL,
    "label" TEXT NOT NULL,
    "label_history" JSONB NOT NULL DEFAULT '[]',
    "field_type" VARCHAR(50) NOT NULL,
    "options" JSONB,
    "sample_values" JSONB NOT NULL DEFAULT '[]',
    "status" VARCHAR(20) NOT NULL DEFAULT 'NEW',
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "missing_streak" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "lead_source_fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_source_field_mappings" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "lead_source_id" UUID NOT NULL,
    "source_field_key" VARCHAR(255) NOT NULL,
    "target_field" VARCHAR(100) NOT NULL,
    "transform" JSONB NOT NULL DEFAULT '{"kind":"passthrough"}',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "confidence" DOUBLE PRECISION,
    "origin" VARCHAR(20) NOT NULL DEFAULT 'USER',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_source_field_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_submissions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "lead_id" UUID,
    "lead_source_id" UUID NOT NULL,
    "webhook_event_id" UUID NOT NULL,
    "provider_submission_id" VARCHAR(255),
    "provider_respondent_id" VARCHAR(255),
    "submitted_at" TIMESTAMPTZ(6) NOT NULL,
    "normalized_answers" JSONB NOT NULL,
    "mapped_values" JSONB NOT NULL DEFAULT '{}',
    "unmapped_keys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "applied_changes" JSONB NOT NULL DEFAULT '[]',
    "skipped_changes" JSONB NOT NULL DEFAULT '[]',
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "mapping_version" INTEGER NOT NULL DEFAULT 0,
    "mapping_confidence" DOUBLE PRECISION,
    "is_first_for_lead" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domain_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "aggregate_type" VARCHAR(50) NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "event_type" VARCHAR(100) NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,

    CONSTRAINT "domain_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "idx_api_keys_organization" ON "api_keys"("organization_id");

-- CreateIndex
CREATE INDEX "idx_lead_source_fields_status" ON "lead_source_fields"("lead_source_id", "status");

-- CreateIndex
CREATE INDEX "idx_lead_source_fields_org" ON "lead_source_fields"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "lead_source_fields_key_unique" ON "lead_source_fields"("lead_source_id", "field_key");

-- CreateIndex
CREATE INDEX "idx_field_mappings_active" ON "lead_source_field_mappings"("lead_source_id", "is_active");

-- CreateIndex
CREATE INDEX "idx_field_mappings_target" ON "lead_source_field_mappings"("lead_source_id", "target_field");

-- CreateIndex
CREATE UNIQUE INDEX "lead_source_field_mappings_unique" ON "lead_source_field_mappings"("lead_source_id", "source_field_key", "target_field");

-- CreateIndex
CREATE UNIQUE INDEX "lead_submissions_webhook_event_id_key" ON "lead_submissions"("webhook_event_id");

-- CreateIndex
CREATE INDEX "idx_lead_submissions_lead" ON "lead_submissions"("lead_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_lead_submissions_source" ON "lead_submissions"("lead_source_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_lead_submissions_org" ON "lead_submissions"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_domain_events_aggregate" ON "domain_events"("aggregate_type", "aggregate_id", "occurred_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "lead_sources_ingest_token_hash_key" ON "lead_sources"("ingest_token_hash");

-- CreateIndex
CREATE INDEX "idx_webhook_events_source_received" ON "webhook_events"("lead_source_id", "received_at" DESC);

-- CreateIndex
CREATE INDEX "idx_webhook_events_error_group" ON "webhook_events"("error_fingerprint", "received_at" DESC);

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_lead_source_id_fkey" FOREIGN KEY ("lead_source_id") REFERENCES "lead_sources"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lead_source_fields" ADD CONSTRAINT "lead_source_fields_lead_source_id_fkey" FOREIGN KEY ("lead_source_id") REFERENCES "lead_sources"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lead_source_field_mappings" ADD CONSTRAINT "lead_source_field_mappings_lead_source_id_fkey" FOREIGN KEY ("lead_source_id") REFERENCES "lead_sources"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lead_submissions" ADD CONSTRAINT "lead_submissions_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lead_submissions" ADD CONSTRAINT "lead_submissions_lead_source_id_fkey" FOREIGN KEY ("lead_source_id") REFERENCES "lead_sources"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lead_submissions" ADD CONSTRAINT "lead_submissions_webhook_event_id_fkey" FOREIGN KEY ("webhook_event_id") REFERENCES "webhook_events"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;


-- ===========================================================================
-- Hand-written additions. Prisma cannot express a WHERE clause on an index, so
-- every partial index below must live here rather than in schema.prisma.
--
-- CREATE INDEX CONCURRENTLY is deliberately NOT used: it cannot run inside a
-- transaction and Prisma wraps each migration in one. These tables are empty
-- today, so a plain CREATE INDEX takes no meaningful lock. Any future index on
-- a populated table must be applied out-of-band with `prisma db execute`.
-- ===========================================================================

-- Transport idempotency, scoped per lead source.
--
-- This is what turns Tally's retry ladder (5m/30m/1h/6h/1d, then an email to the
-- form owner) into a silent no-op. It is also the ONLY replay defense we have:
-- Tally signs the request body with no timestamp in the signed material, so a
-- captured request replays successfully forever. Treat this as a security
-- control, not a correctness nicety.
--
-- Scoped to lead_source_id rather than global because provider event-id
-- uniqueness is only guaranteed within a provider account.
CREATE UNIQUE INDEX IF NOT EXISTS webhook_events_source_dedupe_uniq
  ON webhook_events (lead_source_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND lead_source_id IS NOT NULL;

-- The worker's claim query: SELECT ... WHERE queue_state='PENDING'
--   AND available_at <= now() ORDER BY available_at, id FOR UPDATE SKIP LOCKED.
-- The partial predicate keeps this index at a few hundred live entries even once
-- webhook_events holds millions of processed rows, so polling once a second is
-- effectively free. A full index on (queue_state, available_at) would be ~99.99%
-- dead tuples.
CREATE INDEX IF NOT EXISTS webhook_events_queue_idx
  ON webhook_events (available_at, id)
  WHERE queue_state = 'PENDING';

-- The reaper: finds rows orphaned by a worker that was killed mid-job, so a
-- SIGKILL costs a few minutes of delay rather than a lost lead.
CREATE INDEX IF NOT EXISTS webhook_events_stuck_idx
  ON webhook_events (locked_at)
  WHERE queue_state = 'PROCESSING';

-- Outbox dispatcher. Stays near-empty in steady state.
CREATE INDEX IF NOT EXISTS domain_events_unpublished_idx
  ON domain_events (available_at, id)
  WHERE published_at IS NULL;

-- Lead dedupe. Phone is the SOLE primary identity: it is the channel we dial,
-- it is the TCPA-relevant identifier, and households share email addresses far
-- more often than mobile numbers.
--
-- Email is intentionally left non-unique (idx_leads_email already exists as a
-- plain index). Two unique indexes cannot resolve a submission carrying
-- (phoneA, emailB) where phoneA belongs to lead 1 and emailB to lead 2 — the
-- insert simply fails on whichever trips first, leaving a delivery that can
-- never be processed. Instead we attach to the phone match and flag the row for
-- human review: auto-merging two pre-existing leads is destructive and
-- irreversible.
--
-- This index is the unbypassable backstop against duplicate CREATION. It does
-- NOT protect concurrent merges into an existing lead (those take the UPDATE
-- path and never consult it) — that is what pg_advisory_xact_lock in the worker
-- is for. Both mechanisms are required.
CREATE UNIQUE INDEX IF NOT EXISTS leads_org_phone_uniq
  ON leads (organization_id, normalized_phone)
  WHERE normalized_phone IS NOT NULL;

-- Match the existing schema's posture: RLS enabled on every table. No policies
-- are defined anywhere in this database, so this denies all access to Supabase's
-- anon/authenticated roles while the owner role our API connects as passes
-- through. The real tenant isolation for this service is the application-level
-- guard in src/prisma/prisma.service.ts.
ALTER TABLE api_keys                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_source_fields         ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_source_field_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_submissions           ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain_events              ENABLE ROW LEVEL SECURITY;
