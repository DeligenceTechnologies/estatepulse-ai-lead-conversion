-- A text conversation a calling provider's own SMS agent runs with a lead
-- (Retell SMS chats). Additive: no existing table or row changes.
CREATE TABLE "sms_chats" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "provider" VARCHAR(30) NOT NULL DEFAULT 'retell',
    "provider_chat_id" VARCHAR(255) NOT NULL,
    "agent_id" VARCHAR(255),
    "direction" VARCHAR(10) NOT NULL DEFAULT 'outbound',
    "status" VARCHAR(20) NOT NULL DEFAULT 'ongoing',
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(6),
    "last_message_at" TIMESTAMPTZ(6),
    "last_synced_at" TIMESTAMPTZ(6),
    "next_sync_at" TIMESTAMPTZ(6),
    "sync_interval_ms" INTEGER NOT NULL DEFAULT 30000,
    "analysis" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sms_chats_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sms_chats_provider_provider_chat_id_key" ON "sms_chats"("provider", "provider_chat_id");
CREATE INDEX "sms_chats_status_next_sync_at_idx" ON "sms_chats"("status", "next_sync_at");
CREATE INDEX "sms_chats_organization_id_lead_id_created_at_idx" ON "sms_chats"("organization_id", "lead_id", "created_at" DESC);

ALTER TABLE "sms_chats" ADD CONSTRAINT "sms_chats_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sms_chats" ADD CONSTRAINT "sms_chats_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
