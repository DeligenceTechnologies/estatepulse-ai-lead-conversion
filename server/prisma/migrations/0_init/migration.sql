-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "agent_availability" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "agent_id" UUID NOT NULL,
    "day_of_week" SMALLINT NOT NULL,
    "start_time" TIME(6) NOT NULL,
    "end_time" TIME(6) NOT NULL,
    "is_available" BOOLEAN NOT NULL DEFAULT true,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "agent_availability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_profiles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "display_name" VARCHAR(255) NOT NULL,
    "title" VARCHAR(100),
    "status" VARCHAR(30) NOT NULL DEFAULT 'available',
    "phone" VARCHAR(50),
    "email" VARCHAR(255),
    "timezone" VARCHAR(100) NOT NULL DEFAULT 'America/Chicago',
    "max_active_leads" INTEGER NOT NULL DEFAULT 25,
    "routing_enabled" BOOLEAN NOT NULL DEFAULT true,
    "round_robin_position" INTEGER,
    "calendly_url" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_territories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "agent_id" UUID NOT NULL,
    "territory_name" VARCHAR(255) NOT NULL,
    "territory_type" VARCHAR(50) NOT NULL DEFAULT 'submarket',
    "priority" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "agent_territories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "calendar_connection_id" UUID,
    "provider" VARCHAR(30) NOT NULL,
    "external_event_id" VARCHAR(255),
    "status" VARCHAR(20) NOT NULL DEFAULT 'scheduled',
    "start_at" TIMESTAMPTZ(6) NOT NULL,
    "end_at" TIMESTAMPTZ(6) NOT NULL,
    "meeting_url" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID,
    "actor_type" VARCHAR(20) NOT NULL,
    "actor_id" UUID,
    "action" VARCHAR(100) NOT NULL,
    "entity_type" VARCHAR(50) NOT NULL,
    "entity_id" UUID,
    "payload" JSONB,
    "response_time_ms" INTEGER,
    "correlation_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_connections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "provider" VARCHAR(30) NOT NULL,
    "external_account_id" VARCHAR(255),
    "credentials_secret_ref" TEXT,
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "last_synced_at" TIMESTAMPTZ(6),
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calendar_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "channel" VARCHAR(20) NOT NULL DEFAULT 'sms',
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "followup_sequences" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "description" TEXT,
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "followup_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integrations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "provider" VARCHAR(50) NOT NULL,
    "integration_type" VARCHAR(30) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "external_account_id" VARCHAR(255),
    "credentials_secret_ref" TEXT,
    "last_sync_at" TIMESTAMPTZ(6),
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_assignments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "lead_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "assignment_type" VARCHAR(30) NOT NULL,
    "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unassigned_at" TIMESTAMPTZ(6),
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "lead_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_sources" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "source_type" VARCHAR(50) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "lead_source_id" UUID,
    "first_name" VARCHAR(100),
    "last_name" VARCHAR(100),
    "email" VARCHAR(255),
    "phone" VARCHAR(50),
    "normalized_email" VARCHAR(255),
    "normalized_phone" VARCHAR(50),
    "status" VARCHAR(30) NOT NULL DEFAULT 'new',
    "score" DECIMAL(5,2),
    "temperature" VARCHAR(10),
    "buying_intent" VARCHAR(100),
    "timeline" VARCHAR(100),
    "min_budget" DECIMAL(12,2),
    "max_budget" DECIMAL(12,2),
    "financing_status" VARCHAR(100),
    "all_cash" BOOLEAN,
    "location" VARCHAR(255),
    "bedrooms" INTEGER,
    "motivation" TEXT,
    "qualification_confidence" DECIMAL(5,2),
    "extracted_intel" JSONB,
    "ai_summary" TEXT,
    "consent_status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "dnc_status" BOOLEAN NOT NULL DEFAULT false,
    "automation_paused" BOOLEAN NOT NULL DEFAULT false,
    "takeover_user_id" UUID,
    "takeover_at" TIMESTAMPTZ(6),
    "lost_reason" VARCHAR(255),
    "first_contact_at" TIMESTAMPTZ(6),
    "first_response_at" TIMESTAMPTZ(6),
    "last_contact_at" TIMESTAMPTZ(6),
    "external_lead_id" VARCHAR(255),
    "utm_source" VARCHAR(255),
    "utm_medium" VARCHAR(255),
    "utm_campaign" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "conversation_id" UUID NOT NULL,
    "sender_type" VARCHAR(20) NOT NULL,
    "sender_user_id" UUID,
    "direction" VARCHAR(10) NOT NULL,
    "channel" VARCHAR(20) NOT NULL DEFAULT 'sms',
    "body" TEXT NOT NULL,
    "provider_message_id" VARCHAR(255),
    "delivery_status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "sent_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "failed_at" TIMESTAMPTZ(6),
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_members" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" VARCHAR(30) NOT NULL DEFAULT 'agent',
    "status" VARCHAR(30) NOT NULL DEFAULT 'active',
    "joined_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(255) NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "email" VARCHAR(255),
    "phone" VARCHAR(50),
    "timezone" VARCHAR(100) NOT NULL DEFAULT 'America/Chicago',
    "status" VARCHAR(30) NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "routing_policy" VARCHAR(30) NOT NULL DEFAULT 'geographic_round_robin',

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sequence_enrollments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "lead_id" UUID NOT NULL,
    "sequence_id" UUID NOT NULL,
    "current_step" INTEGER NOT NULL DEFAULT 1,
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "next_action_at" TIMESTAMPTZ(6),
    "enrolled_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "stopped_at" TIMESTAMPTZ(6),
    "stopped_reason" VARCHAR(100),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sequence_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sequence_steps" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sequence_id" UUID NOT NULL,
    "step_order" INTEGER NOT NULL,
    "action_type" VARCHAR(20) NOT NULL,
    "delay_minutes" INTEGER NOT NULL DEFAULT 0,
    "message_template" TEXT,
    "voice_prompt" TEXT,
    "max_attempts" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "sequence_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" VARCHAR(255) NOT NULL,
    "first_name" VARCHAR(100),
    "last_name" VARCHAR(100),
    "phone" VARCHAR(50),
    "avatar_url" TEXT,
    "status" VARCHAR(30) NOT NULL DEFAULT 'active',
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "password_hash" TEXT,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voice_calls" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "conversation_id" UUID,
    "provider" VARCHAR(30) NOT NULL DEFAULT 'retell',
    "provider_call_id" VARCHAR(255),
    "direction" VARCHAR(10) NOT NULL DEFAULT 'outbound',
    "status" VARCHAR(30) NOT NULL DEFAULT 'queued',
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
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voice_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID,
    "provider" VARCHAR(50) NOT NULL,
    "event_type" VARCHAR(100) NOT NULL,
    "external_event_id" VARCHAR(255),
    "payload" JSONB NOT NULL,
    "signature_verified" BOOLEAN NOT NULL DEFAULT false,
    "processing_status" VARCHAR(20) NOT NULL DEFAULT 'received',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "error_message" TEXT,
    "correlation_id" UUID,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_subscriptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "endpoint_url" TEXT NOT NULL,
    "secret_ref" TEXT,
    "subscribed_events" JSONB NOT NULL DEFAULT '[]',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_agent_availability_org" ON "agent_availability"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_availability_agent_id_day_of_week_key" ON "agent_availability"("agent_id", "day_of_week");

-- CreateIndex
CREATE INDEX "idx_agent_profiles_organization" ON "agent_profiles"("organization_id");

-- CreateIndex
CREATE INDEX "idx_agent_profiles_routing" ON "agent_profiles"("organization_id", "routing_enabled");

-- CreateIndex
CREATE INDEX "idx_agent_profiles_status" ON "agent_profiles"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "agent_profiles_organization_id_user_id_key" ON "agent_profiles"("organization_id", "user_id");

-- CreateIndex
CREATE INDEX "idx_agent_territories_agent" ON "agent_territories"("agent_id");

-- CreateIndex
CREATE INDEX "idx_agent_territories_name" ON "agent_territories"("territory_name");

-- CreateIndex
CREATE INDEX "idx_agent_territories_org" ON "agent_territories"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_territories_agent_id_territory_name_key" ON "agent_territories"("agent_id", "territory_name");

-- CreateIndex
CREATE INDEX "idx_appointments_agent" ON "appointments"("agent_id");

-- CreateIndex
CREATE INDEX "idx_appointments_external_event" ON "appointments"("external_event_id");

-- CreateIndex
CREATE INDEX "idx_appointments_lead" ON "appointments"("lead_id");

-- CreateIndex
CREATE INDEX "idx_appointments_organization" ON "appointments"("organization_id");

-- CreateIndex
CREATE INDEX "idx_appointments_start" ON "appointments"("agent_id", "start_at");

-- CreateIndex
CREATE INDEX "idx_appointments_status" ON "appointments"("organization_id", "status");

-- CreateIndex
CREATE INDEX "idx_audit_logs_action" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "idx_audit_logs_correlation" ON "audit_logs"("correlation_id");

-- CreateIndex
CREATE INDEX "idx_audit_logs_created" ON "audit_logs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_audit_logs_entity" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "idx_audit_logs_organization" ON "audit_logs"("organization_id");

-- CreateIndex
CREATE INDEX "idx_calendar_connections_agent" ON "calendar_connections"("agent_id");

-- CreateIndex
CREATE INDEX "idx_calendar_connections_organization" ON "calendar_connections"("organization_id");

-- CreateIndex
CREATE INDEX "idx_calendar_connections_status" ON "calendar_connections"("organization_id", "status");

-- CreateIndex
CREATE INDEX "idx_conversations_lead" ON "conversations"("lead_id");

-- CreateIndex
CREATE INDEX "idx_conversations_organization" ON "conversations"("organization_id");

-- CreateIndex
CREATE INDEX "idx_conversations_status" ON "conversations"("organization_id", "status");

-- CreateIndex
CREATE INDEX "idx_followup_sequences_organization" ON "followup_sequences"("organization_id");

-- CreateIndex
CREATE INDEX "idx_followup_sequences_status" ON "followup_sequences"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "followup_sequences_code_unique" ON "followup_sequences"("organization_id", "code");

-- CreateIndex
CREATE INDEX "idx_integrations_organization" ON "integrations"("organization_id");

-- CreateIndex
CREATE INDEX "idx_integrations_provider" ON "integrations"("organization_id", "provider");

-- CreateIndex
CREATE INDEX "idx_integrations_status" ON "integrations"("organization_id", "status");

-- CreateIndex
CREATE INDEX "idx_lead_assignments_agent" ON "lead_assignments"("agent_id");

-- CreateIndex
CREATE INDEX "idx_lead_assignments_current" ON "lead_assignments"("lead_id", "is_current");

-- CreateIndex
CREATE INDEX "idx_lead_assignments_lead" ON "lead_assignments"("lead_id");

-- CreateIndex
CREATE INDEX "idx_lead_assignments_org" ON "lead_assignments"("organization_id");

-- CreateIndex
CREATE INDEX "idx_lead_sources_organization" ON "lead_sources"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "lead_sources_code_unique" ON "lead_sources"("organization_id", "code");

-- CreateIndex
CREATE INDEX "idx_leads_created_at" ON "leads"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_leads_email" ON "leads"("organization_id", "normalized_email");

-- CreateIndex
CREATE INDEX "idx_leads_organization" ON "leads"("organization_id");

-- CreateIndex
CREATE INDEX "idx_leads_phone" ON "leads"("organization_id", "normalized_phone");

-- CreateIndex
CREATE INDEX "idx_leads_source" ON "leads"("lead_source_id");

-- CreateIndex
CREATE INDEX "idx_leads_status" ON "leads"("organization_id", "status");

-- CreateIndex
CREATE INDEX "idx_leads_temperature" ON "leads"("organization_id", "temperature");

-- CreateIndex
CREATE INDEX "idx_messages_conversation" ON "messages"("conversation_id");

-- CreateIndex
CREATE INDEX "idx_messages_created_at" ON "messages"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_messages_org" ON "messages"("organization_id");

-- CreateIndex
CREATE INDEX "idx_messages_provider_id" ON "messages"("provider_message_id");

-- CreateIndex
CREATE INDEX "idx_org_members_organization" ON "organization_members"("organization_id");

-- CreateIndex
CREATE INDEX "idx_org_members_role" ON "organization_members"("organization_id", "role");

-- CreateIndex
CREATE INDEX "idx_org_members_user" ON "organization_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_members_organization_id_user_id_key" ON "organization_members"("organization_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE INDEX "idx_sequence_enrollments_active_leads" ON "sequence_enrollments"("lead_id", "status");

-- CreateIndex
CREATE INDEX "idx_sequence_enrollments_lead" ON "sequence_enrollments"("lead_id");

-- CreateIndex
CREATE INDEX "idx_sequence_enrollments_next_action" ON "sequence_enrollments"("status", "next_action_at");

-- CreateIndex
CREATE INDEX "idx_sequence_enrollments_sequence" ON "sequence_enrollments"("sequence_id");

-- CreateIndex
CREATE INDEX "idx_sequence_steps_org" ON "sequence_steps"("organization_id");

-- CreateIndex
CREATE INDEX "idx_sequence_steps_sequence" ON "sequence_steps"("sequence_id", "step_order");

-- CreateIndex
CREATE UNIQUE INDEX "sequence_steps_order_unique" ON "sequence_steps"("sequence_id", "step_order");

-- CreateIndex
CREATE INDEX "idx_voice_calls_created_at" ON "voice_calls"("lead_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_voice_calls_lead" ON "voice_calls"("lead_id");

-- CreateIndex
CREATE INDEX "idx_voice_calls_organization" ON "voice_calls"("organization_id");

-- CreateIndex
CREATE INDEX "idx_voice_calls_provider_id" ON "voice_calls"("provider_call_id");

-- CreateIndex
CREATE INDEX "idx_webhook_events_organization" ON "webhook_events"("organization_id");

-- CreateIndex
CREATE INDEX "idx_webhook_events_received" ON "webhook_events"("received_at" DESC);

-- CreateIndex
CREATE INDEX "idx_webhook_events_status" ON "webhook_events"("processing_status");

-- CreateIndex
CREATE INDEX "idx_webhook_subscriptions_active" ON "webhook_subscriptions"("organization_id", "is_active");

-- CreateIndex
CREATE INDEX "idx_webhook_subscriptions_organization" ON "webhook_subscriptions"("organization_id");

-- AddForeignKey
ALTER TABLE "agent_availability" ADD CONSTRAINT "agent_availability_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agent_profiles"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "agent_availability" ADD CONSTRAINT "agent_availability_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "agent_territories" ADD CONSTRAINT "agent_territories_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agent_profiles"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "agent_territories" ADD CONSTRAINT "agent_territories_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agent_profiles"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_calendar_connection_id_fkey" FOREIGN KEY ("calendar_connection_id") REFERENCES "calendar_connections"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agent_profiles"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "followup_sequences" ADD CONSTRAINT "followup_sequences_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lead_assignments" ADD CONSTRAINT "lead_assignments_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agent_profiles"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lead_assignments" ADD CONSTRAINT "lead_assignments_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lead_assignments" ADD CONSTRAINT "lead_assignments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lead_sources" ADD CONSTRAINT "lead_sources_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_lead_source_id_fkey" FOREIGN KEY ("lead_source_id") REFERENCES "lead_sources"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_takeover_user_id_fkey" FOREIGN KEY ("takeover_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_user_id_fkey" FOREIGN KEY ("sender_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_sequence_id_fkey" FOREIGN KEY ("sequence_id") REFERENCES "followup_sequences"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "sequence_steps" ADD CONSTRAINT "sequence_steps_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "sequence_steps" ADD CONSTRAINT "sequence_steps_sequence_id_fkey" FOREIGN KEY ("sequence_id") REFERENCES "followup_sequences"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "voice_calls" ADD CONSTRAINT "voice_calls_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "voice_calls" ADD CONSTRAINT "voice_calls_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "voice_calls" ADD CONSTRAINT "voice_calls_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

