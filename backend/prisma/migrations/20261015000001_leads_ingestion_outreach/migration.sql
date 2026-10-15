-- Leads, lead sources and ingestion, integrations, outreach (calls, messages,
-- sequences) and the links from calendar meetings to leads and hosts.

-- CreateEnum
CREATE TYPE "lead_status" AS ENUM ('new', 'contacting', 'follow_up', 'interested', 'appointment_requested', 'appointment_booked', 'not_interested', 'closed', 'invalid');

-- CreateEnum
CREATE TYPE "follow_up_reason" AS ENUM ('no_answer', 'not_ready', 'callback_requested', 'needs_time', 'other');

-- CreateEnum
CREATE TYPE "lead_temperature" AS ENUM ('hot', 'warm', 'cold');

-- CreateEnum
CREATE TYPE "consent_status" AS ENUM ('granted', 'revoked', 'pending');

-- CreateEnum
CREATE TYPE "assignment_type" AS ENUM ('manual', 'ai');

-- CreateEnum
CREATE TYPE "actor_type" AS ENUM ('user', 'ai', 'system', 'webhook');

-- CreateEnum
CREATE TYPE "message_direction" AS ENUM ('inbound', 'outbound');

-- CreateEnum
CREATE TYPE "message_sender" AS ENUM ('ai', 'lead', 'user');

-- CreateEnum
CREATE TYPE "delivery_status" AS ENUM ('pending', 'sent', 'delivered', 'failed');

-- CreateEnum
CREATE TYPE "call_status" AS ENUM ('queued', 'ringing', 'in_progress', 'completed', 'no_answer', 'failed');

-- CreateEnum
CREATE TYPE "integration_provider" AS ENUM ('telnyx', 'tally', 'google');

-- CreateEnum
CREATE TYPE "integration_status" AS ENUM ('active', 'inactive', 'invalid', 'revoked');

-- CreateEnum
CREATE TYPE "lead_source_provider" AS ENUM ('WEBHOOK', 'TALLY', 'GOOGLE_SHEETS', 'FILE_UPLOAD');

-- CreateEnum
CREATE TYPE "lead_source_connection_method" AS ENUM ('MANUAL', 'API', 'SYNC', 'UPLOAD');

-- CreateEnum
CREATE TYPE "lead_source_ingest_status" AS ENUM ('AWAITING_FIRST_EVENT', 'NEEDS_MAPPING', 'ACTIVE', 'PAUSED', 'IMPORTING', 'COMPLETED', 'REMOVED');

-- CreateEnum
CREATE TYPE "lead_source_mapping_status" AS ENUM ('UNCONFIGURED', 'NEEDS_REVIEW', 'CONFIGURED');

-- CreateEnum
CREATE TYPE "remote_webhook_state" AS ENUM ('PENDING', 'INSTALLED', 'DRIFTED', 'UNINSTALLED', 'ORPHANED', 'ERROR');

-- CreateEnum
CREATE TYPE "lead_source_field_status" AS ENUM ('NEW', 'ACTIVE', 'MISSING');

-- CreateEnum
CREATE TYPE "mapping_origin" AS ENUM ('HEURISTIC', 'USER', 'IMPORTED', 'PREBUILT');

-- CreateEnum
CREATE TYPE "ingest_queue_state" AS ENUM ('PENDING', 'PROCESSING', 'DONE', 'FAILED', 'DEAD_LETTER');

-- CreateEnum
CREATE TYPE "ingest_outcome" AS ENUM ('PROCESSED', 'PROCESSED_WITH_WARNINGS', 'DUPLICATE', 'NEEDS_MAPPING', 'NEEDS_IDENTITY', 'QUARANTINED_SIGNATURE', 'INVALID_PAYLOAD', 'ERROR');

-- CreateEnum
CREATE TYPE "signature_state" AS ENUM ('VALID', 'INVALID', 'MISSING', 'NOT_CONFIGURED');

-- CreateEnum
CREATE TYPE "import_review_state" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "sequence_status" AS ENUM ('active', 'inactive', 'archived');

-- CreateEnum
CREATE TYPE "sequence_trigger" AS ENUM ('qualified_hot', 'qualified_warm', 'qualified_cold', 'follow_up_no_answer', 'follow_up_not_ready', 'follow_up_callback_requested', 'follow_up_needs_time', 'follow_up_other');

-- CreateEnum
CREATE TYPE "enrollment_status" AS ENUM ('active', 'paused', 'completed', 'stopped');

-- CreateEnum
CREATE TYPE "enrolled_by" AS ENUM ('auto', 'manual', 'bulk');

-- AlterEnum
ALTER TYPE "calendar_meeting_status" ADD VALUE 'rescheduled';

-- AlterTable
ALTER TABLE "calendar_connections" ADD COLUMN     "scope" VARCHAR(1000);

-- AlterTable
ALTER TABLE "calendar_meetings" ADD COLUMN     "booked_via" VARCHAR(30),
ADD COLUMN     "host_user_id" UUID,
ADD COLUMN     "lead_id" UUID;

-- AlterTable
ALTER TABLE "org_settings" ADD COLUMN     "call_recording_announce" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "call_recording_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "default_region" VARCHAR(2) NOT NULL DEFAULT 'US',
ADD COLUMN     "in_call_booking" JSONB,
ADD COLUMN     "lead_hot_threshold" INTEGER NOT NULL DEFAULT 75,
ADD COLUMN     "lead_warm_threshold" INTEGER NOT NULL DEFAULT 45,
ADD COLUMN     "outreach_strategy" JSONB;

-- CreateTable
CREATE TABLE "sequences" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "status" "sequence_status" NOT NULL DEFAULT 'active',
    "steps" JSONB NOT NULL DEFAULT '[]',
    "triggers" "sequence_trigger"[] DEFAULT ARRAY[]::"sequence_trigger"[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sequence_enrollments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "sequence_id" UUID NOT NULL,
    "current_step" INTEGER NOT NULL DEFAULT 1,
    "status" "enrollment_status" NOT NULL DEFAULT 'active',
    "next_action_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "locked_by" VARCHAR(100),
    "locked_at" TIMESTAMPTZ(6),
    "enrolled_by" "enrolled_by" NOT NULL DEFAULT 'auto',
    "enrolled_by_user_id" UUID,
    "enrolled_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "stopped_at" TIMESTAMPTZ(6),
    "stopped_reason" VARCHAR(100),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sequence_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integrations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "provider" "integration_provider" NOT NULL,
    "status" "integration_status" NOT NULL DEFAULT 'active',
    "label" VARCHAR(255),
    "credentials" TEXT NOT NULL,
    "credential_hash" VARCHAR(64),
    "credential_preview" VARCHAR(64),
    "external_account_id" VARCHAR(255),
    "account_email" VARCHAR(255),
    "account_name" VARCHAR(255),
    "phone_number" VARCHAR(50),
    "config" JSONB NOT NULL DEFAULT '{}',
    "last_verified_at" TIMESTAMPTZ(6),
    "last_error_at" TIMESTAMPTZ(6),
    "last_error_code" VARCHAR(50),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_sources" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "provider" "lead_source_provider" NOT NULL DEFAULT 'WEBHOOK',
    "connection_method" "lead_source_connection_method" NOT NULL DEFAULT 'MANUAL',
    "integration_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "archived_at" TIMESTAMPTZ(6),
    "default_consent_status" "consent_status" NOT NULL DEFAULT 'pending',
    "ingest_status" "lead_source_ingest_status",
    "mapping_status" "lead_source_mapping_status",
    "mapping_version" INTEGER NOT NULL DEFAULT 0,
    "schema_fingerprint" VARCHAR(64),
    "prebuilt_at" TIMESTAMPTZ(6),
    "external_form_id" VARCHAR(255),
    "external_form_name" VARCHAR(255),
    "ingest_token_hash" VARCHAR(64),
    "ingest_token_prefix" VARCHAR(32),
    "ingest_token_enc" TEXT,
    "require_signature" BOOLEAN NOT NULL DEFAULT false,
    "signing_secret_enc" TEXT,
    "signing_secret_last4" VARCHAR(8),
    "signing_secret_set_at" TIMESTAMPTZ(6),
    "previous_secret_enc" TEXT,
    "previous_secret_valid_until" TIMESTAMPTZ(6),
    "external_webhook_id" VARCHAR(255),
    "remote_state" "remote_webhook_state",
    "remote_synced_at" TIMESTAMPTZ(6),
    "remote_error_code" VARCHAR(50),
    "remote_error_message" TEXT,
    "sync_next_at" TIMESTAMPTZ(6),
    "sync_locked_at" TIMESTAMPTZ(6),
    "sync_locked_by" VARCHAR(100),
    "sync_remote_version" VARCHAR(64),
    "sync_failures" INTEGER NOT NULL DEFAULT 0,
    "sync_row_key_field" VARCHAR(255),
    "sync_fallback_ack_at" TIMESTAMPTZ(6),
    "sync_fallback_ack_by" UUID,
    "last_event_at" TIMESTAMPTZ(6),
    "last_success_at" TIMESTAMPTZ(6),
    "last_failure_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "lead_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_source_fields" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "lead_source_id" UUID NOT NULL,
    "field_key" VARCHAR(255) NOT NULL,
    "label" TEXT NOT NULL,
    "field_type" VARCHAR(50) NOT NULL,
    "options" JSONB,
    "sample_values" JSONB NOT NULL DEFAULT '[]',
    "status" "lead_source_field_status" NOT NULL DEFAULT 'NEW',
    "missing_streak" INTEGER NOT NULL DEFAULT 0,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_source_fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_source_field_mappings" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "lead_source_id" UUID NOT NULL,
    "source_field_key" VARCHAR(255) NOT NULL,
    "target_field" VARCHAR(100) NOT NULL,
    "transform" JSONB NOT NULL DEFAULT '{"kind": "passthrough"}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "confidence" DOUBLE PRECISION,
    "origin" "mapping_origin" NOT NULL DEFAULT 'USER',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "lead_source_field_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingest_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "lead_source_id" UUID NOT NULL,
    "lead_id" UUID,
    "provider" "lead_source_provider" NOT NULL,
    "event_type" VARCHAR(100),
    "dedupe_key" VARCHAR(128) NOT NULL,
    "provider_event_id" VARCHAR(255),
    "provider_submission_id" VARCHAR(255),
    "provider_respondent_id" VARCHAR(255),
    "provider_form_id" VARCHAR(255),
    "provider_created_at" TIMESTAMPTZ(6),
    "raw_body" TEXT,
    "payload" JSONB NOT NULL,
    "payload_hash" VARCHAR(64) NOT NULL,
    "headers" JSONB,
    "content_length" INTEGER,
    "signature_state" "signature_state" NOT NULL,
    "used_previous_secret" BOOLEAN NOT NULL DEFAULT false,
    "queue_state" "ingest_queue_state" NOT NULL,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_at" TIMESTAMPTZ(6),
    "locked_by" VARCHAR(100),
    "outcome" "ingest_outcome",
    "outcome_reason" VARCHAR(100),
    "error_message" TEXT,
    "processing_ms" INTEGER,
    "mapping_trace" JSONB,
    "normalized_answers" JSONB,
    "mapped_values" JSONB,
    "unmapped_keys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),

    CONSTRAINT "ingest_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sheet_import_rows" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "lead_source_id" UUID NOT NULL,
    "row_key" VARCHAR(64) NOT NULL,
    "lead_id" UUID,
    "content_hash" VARCHAR(64) NOT NULL,
    "row_number" INTEGER NOT NULL,
    "review_state" "import_review_state" NOT NULL DEFAULT 'pending',
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "changed_after_review_at" TIMESTAMPTZ(6),
    "changed_values" JSONB,
    "missing_since" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sheet_import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "lead_source_id" UUID,
    "first_name" VARCHAR(100),
    "last_name" VARCHAR(100),
    "email" VARCHAR(255),
    "phone" VARCHAR(50),
    "normalized_email" VARCHAR(255),
    "normalized_phone" VARCHAR(50),
    "email_valid" BOOLEAN NOT NULL DEFAULT false,
    "phone_valid" BOOLEAN NOT NULL DEFAULT false,
    "external_lead_id" VARCHAR(255),
    "status" "lead_status" NOT NULL DEFAULT 'new',
    "follow_up_reason" "follow_up_reason",
    "temperature" "lead_temperature",
    "score" DECIMAL(5,2),
    "ai_summary" TEXT,
    "lost_reason" VARCHAR(255),
    "buying_intent" VARCHAR(100),
    "timeline" VARCHAR(100),
    "min_budget" DECIMAL(12,2),
    "max_budget" DECIMAL(12,2),
    "financing_status" VARCHAR(100),
    "location" VARCHAR(255),
    "bedrooms" INTEGER,
    "motivation" TEXT,
    "custom_fields" JSONB NOT NULL DEFAULT '{}',
    "consent_status" "consent_status" NOT NULL DEFAULT 'pending',
    "consent_source" VARCHAR(50),
    "consent_at" TIMESTAMPTZ(6),
    "dnc_status" BOOLEAN NOT NULL DEFAULT false,
    "automation_paused" BOOLEAN NOT NULL DEFAULT false,
    "needs_review" BOOLEAN NOT NULL DEFAULT false,
    "review_reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "assigned_to_id" UUID,
    "assigned_at" TIMESTAMPTZ(6),
    "assignment_type" "assignment_type",
    "first_contact_at" TIMESTAMPTZ(6),
    "first_response_at" TIMESTAMPTZ(6),
    "last_contact_at" TIMESTAMPTZ(6),
    "submission_count" INTEGER NOT NULL DEFAULT 1,
    "last_submission_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "direction" "message_direction" NOT NULL,
    "channel" VARCHAR(20) NOT NULL DEFAULT 'sms',
    "sender_type" "message_sender" NOT NULL,
    "sender_user_id" UUID,
    "body" TEXT NOT NULL,
    "provider_message_id" VARCHAR(255),
    "delivery_status" "delivery_status" NOT NULL DEFAULT 'pending',
    "sent_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "failed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calls" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "provider" VARCHAR(30) NOT NULL DEFAULT 'telnyx',
    "provider_call_id" VARCHAR(255),
    "direction" VARCHAR(10) NOT NULL DEFAULT 'outbound',
    "status" "call_status" NOT NULL DEFAULT 'queued',
    "started_at" TIMESTAMPTZ(6),
    "ended_at" TIMESTAMPTZ(6),
    "duration_seconds" INTEGER,
    "recording_url" TEXT,
    "transcript" TEXT,
    "ai_summary" TEXT,
    "extracted_intel" JSONB,
    "handoff_requested" BOOLEAN NOT NULL DEFAULT false,
    "dnc_detected" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "actor_type" "actor_type" NOT NULL,
    "actor_id" UUID,
    "action" VARCHAR(100) NOT NULL,
    "entity_type" VARCHAR(50) NOT NULL,
    "entity_id" UUID,
    "payload" JSONB,
    "duration_ms" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sequences_organization_id_status_idx" ON "sequences"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sequences_organization_id_code_key" ON "sequences"("organization_id", "code");

-- CreateIndex
CREATE INDEX "sequence_enrollments_organization_id_lead_id_idx" ON "sequence_enrollments"("organization_id", "lead_id");

-- CreateIndex
CREATE INDEX "sequence_enrollments_sequence_id_idx" ON "sequence_enrollments"("sequence_id");

-- CreateIndex
CREATE INDEX "sequence_enrollments_status_next_action_at_idx" ON "sequence_enrollments"("status", "next_action_at");

-- CreateIndex
CREATE INDEX "integrations_organization_id_provider_status_idx" ON "integrations"("organization_id", "provider", "status");

-- CreateIndex
CREATE INDEX "integrations_provider_phone_number_idx" ON "integrations"("provider", "phone_number");

-- CreateIndex
CREATE UNIQUE INDEX "lead_sources_ingest_token_hash_key" ON "lead_sources"("ingest_token_hash");

-- CreateIndex
CREATE INDEX "lead_sources_organization_id_idx" ON "lead_sources"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "lead_sources_organization_id_code_key" ON "lead_sources"("organization_id", "code");

-- CreateIndex
CREATE INDEX "lead_source_fields_organization_id_idx" ON "lead_source_fields"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "lead_source_fields_lead_source_id_field_key_key" ON "lead_source_fields"("lead_source_id", "field_key");

-- CreateIndex
CREATE INDEX "lead_source_field_mappings_lead_source_id_is_active_idx" ON "lead_source_field_mappings"("lead_source_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "lead_source_field_mappings_lead_source_id_source_field_key__key" ON "lead_source_field_mappings"("lead_source_id", "source_field_key", "target_field");

-- CreateIndex
CREATE INDEX "ingest_events_lead_source_id_received_at_idx" ON "ingest_events"("lead_source_id", "received_at" DESC);

-- CreateIndex
CREATE INDEX "ingest_events_organization_id_received_at_idx" ON "ingest_events"("organization_id", "received_at" DESC);

-- CreateIndex
CREATE INDEX "ingest_events_lead_id_idx" ON "ingest_events"("lead_id");

-- CreateIndex
CREATE UNIQUE INDEX "ingest_events_lead_source_id_dedupe_key_key" ON "ingest_events"("lead_source_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "sheet_import_rows_lead_id_idx" ON "sheet_import_rows"("lead_id");

-- CreateIndex
CREATE UNIQUE INDEX "sheet_import_rows_lead_source_id_row_key_key" ON "sheet_import_rows"("lead_source_id", "row_key");

-- CreateIndex
CREATE INDEX "leads_organization_id_created_at_idx" ON "leads"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "leads_organization_id_status_idx" ON "leads"("organization_id", "status");

-- CreateIndex
CREATE INDEX "leads_organization_id_temperature_idx" ON "leads"("organization_id", "temperature");

-- CreateIndex
CREATE INDEX "leads_organization_id_normalized_phone_idx" ON "leads"("organization_id", "normalized_phone");

-- CreateIndex
CREATE INDEX "leads_organization_id_normalized_email_idx" ON "leads"("organization_id", "normalized_email");

-- CreateIndex
CREATE INDEX "leads_organization_id_assigned_to_id_idx" ON "leads"("organization_id", "assigned_to_id");

-- CreateIndex
CREATE INDEX "leads_lead_source_id_idx" ON "leads"("lead_source_id");

-- CreateIndex
CREATE INDEX "messages_organization_id_lead_id_created_at_idx" ON "messages"("organization_id", "lead_id", "created_at");

-- CreateIndex
CREATE INDEX "messages_organization_id_created_at_idx" ON "messages"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "messages_provider_message_id_idx" ON "messages"("provider_message_id");

-- CreateIndex
CREATE INDEX "calls_organization_id_created_at_idx" ON "calls"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "calls_lead_id_created_at_idx" ON "calls"("lead_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "calls_provider_call_id_idx" ON "calls"("provider_call_id");

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_created_at_idx" ON "audit_logs"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "calendar_meetings_lead_id_idx" ON "calendar_meetings"("lead_id");

-- CreateIndex
CREATE INDEX "calendar_meetings_host_user_id_starts_at_idx" ON "calendar_meetings"("host_user_id", "starts_at");

-- AddForeignKey
ALTER TABLE "calendar_meetings" ADD CONSTRAINT "calendar_meetings_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_meetings" ADD CONSTRAINT "calendar_meetings_host_user_id_fkey" FOREIGN KEY ("host_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequences" ADD CONSTRAINT "sequences_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_sequence_id_fkey" FOREIGN KEY ("sequence_id") REFERENCES "sequences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_enrolled_by_user_id_fkey" FOREIGN KEY ("enrolled_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_sources" ADD CONSTRAINT "lead_sources_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_sources" ADD CONSTRAINT "lead_sources_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_source_fields" ADD CONSTRAINT "lead_source_fields_lead_source_id_fkey" FOREIGN KEY ("lead_source_id") REFERENCES "lead_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_source_field_mappings" ADD CONSTRAINT "lead_source_field_mappings_lead_source_id_fkey" FOREIGN KEY ("lead_source_id") REFERENCES "lead_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingest_events" ADD CONSTRAINT "ingest_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingest_events" ADD CONSTRAINT "ingest_events_lead_source_id_fkey" FOREIGN KEY ("lead_source_id") REFERENCES "lead_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingest_events" ADD CONSTRAINT "ingest_events_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sheet_import_rows" ADD CONSTRAINT "sheet_import_rows_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sheet_import_rows" ADD CONSTRAINT "sheet_import_rows_lead_source_id_fkey" FOREIGN KEY ("lead_source_id") REFERENCES "lead_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sheet_import_rows" ADD CONSTRAINT "sheet_import_rows_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sheet_import_rows" ADD CONSTRAINT "sheet_import_rows_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_lead_source_id_fkey" FOREIGN KEY ("lead_source_id") REFERENCES "lead_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_user_id_fkey" FOREIGN KEY ("sender_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Partial indexes Prisma cannot express.
CREATE UNIQUE INDEX "sequence_enrollments_one_live_per_lead"
  ON "sequence_enrollments" ("lead_id")
  WHERE "status" IN ('active', 'paused');

CREATE INDEX "sequence_enrollments_due"
  ON "sequence_enrollments" ("next_action_at")
  WHERE "status" = 'active' AND "locked_by" IS NULL;

CREATE UNIQUE INDEX "lead_sources_api_form_unique"
  ON "lead_sources" ("organization_id", "provider", "external_form_id")
  WHERE "connection_method" = 'API' AND "external_form_id" IS NOT NULL AND "archived_at" IS NULL;

CREATE UNIQUE INDEX "lead_sources_sync_file_unique"
  ON "lead_sources" ("organization_id", "provider", "external_form_id")
  WHERE "connection_method" = 'SYNC' AND "external_form_id" IS NOT NULL AND "archived_at" IS NULL;

CREATE INDEX "lead_sources_sync_due"
  ON "lead_sources" ("sync_next_at")
  WHERE "connection_method" = 'SYNC' AND "is_active" AND "archived_at" IS NULL;

CREATE INDEX "ingest_events_queue"
  ON "ingest_events" ("available_at", "id")
  WHERE "queue_state" = 'PENDING';

CREATE INDEX "sheet_import_rows_pending"
  ON "sheet_import_rows" ("organization_id", "created_at" DESC, "id")
  WHERE "review_state" = 'pending';

CREATE UNIQUE INDEX "integrations_one_active_telnyx"
  ON "integrations" ("organization_id")
  WHERE "provider" = 'telnyx' AND "status" = 'active';

CREATE UNIQUE INDEX "integrations_one_live_google"
  ON "integrations" ("organization_id")
  WHERE "provider" = 'google' AND "revoked_at" IS NULL;

ALTER TABLE "org_settings"
  ADD CONSTRAINT "org_settings_lead_thresholds_check"
  CHECK ("lead_warm_threshold" >= 1 AND "lead_hot_threshold" <= 100 AND "lead_warm_threshold" < "lead_hot_threshold");
