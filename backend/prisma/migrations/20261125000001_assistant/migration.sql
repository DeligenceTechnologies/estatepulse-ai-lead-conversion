-- CreateEnum
CREATE TYPE "assistant_role" AS ENUM ('user', 'assistant');

-- CreateEnum
CREATE TYPE "assistant_risk_tier" AS ENUM ('read', 'write');

-- CreateEnum
CREATE TYPE "assistant_action_status" AS ENUM ('proposed', 'executing', 'executed', 'rejected', 'expired', 'failed');

-- CreateTable
CREATE TABLE "assistant_threads" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "title" VARCHAR(200),
    "message_count" INTEGER NOT NULL DEFAULT 0,
    "last_message_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assistant_messages" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "role" "assistant_role" NOT NULL,
    "content" JSONB NOT NULL,
    "text" TEXT,
    "model" VARCHAR(64),
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_read_tokens" INTEGER NOT NULL DEFAULT 0,
    "stop_reason" VARCHAR(32),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assistant_actions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "tool_use_id" VARCHAR(64) NOT NULL,
    "tool_name" VARCHAR(64) NOT NULL,
    "tier" "assistant_risk_tier" NOT NULL,
    "input" JSONB NOT NULL,
    "preview" JSONB,
    "status" "assistant_action_status" NOT NULL,
    "entity_type" VARCHAR(40),
    "entity_id" UUID,
    "entity_version" TIMESTAMPTZ(6),
    "result" JSONB,
    "error" TEXT,
    "expires_at" TIMESTAMPTZ(6),
    "decided_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assistant_usage" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "period" VARCHAR(7) NOT NULL,
    "input_tokens" BIGINT NOT NULL DEFAULT 0,
    "output_tokens" BIGINT NOT NULL DEFAULT 0,
    "cost_micros" BIGINT NOT NULL DEFAULT 0,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "assistant_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assistant_threads_organization_id_user_id_last_message_at_idx" ON "assistant_threads"("organization_id", "user_id", "last_message_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "assistant_messages_thread_id_position_key" ON "assistant_messages"("thread_id", "position");

-- CreateIndex
CREATE INDEX "assistant_actions_thread_id_status_idx" ON "assistant_actions"("thread_id", "status");

-- CreateIndex
CREATE INDEX "assistant_actions_organization_id_entity_type_entity_id_idx" ON "assistant_actions"("organization_id", "entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "assistant_actions_message_id_tool_use_id_key" ON "assistant_actions"("message_id", "tool_use_id");

-- CreateIndex
CREATE UNIQUE INDEX "assistant_usage_organization_id_period_key" ON "assistant_usage"("organization_id", "period");

-- AddForeignKey
ALTER TABLE "assistant_threads" ADD CONSTRAINT "assistant_threads_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_threads" ADD CONSTRAINT "assistant_threads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_messages" ADD CONSTRAINT "assistant_messages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_messages" ADD CONSTRAINT "assistant_messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "assistant_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_actions" ADD CONSTRAINT "assistant_actions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_actions" ADD CONSTRAINT "assistant_actions_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "assistant_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_actions" ADD CONSTRAINT "assistant_actions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "assistant_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_usage" ADD CONSTRAINT "assistant_usage_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

