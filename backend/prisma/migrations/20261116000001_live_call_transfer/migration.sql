-- Live call transfer: an agent takes a hot lead's AI call mid-conversation.
-- Agents opt in, list the areas they cover, and a round robin decides who is rung first;
-- every transfer and every agent rung is kept for reporting.

-- CreateEnum
CREATE TYPE "call_transfer_status" AS ENUM ('dialing', 'connected', 'no_agent', 'abandoned', 'failed');

-- CreateEnum
CREATE TYPE "transfer_attempt_status" AS ENUM ('dialing', 'answered', 'accepted', 'declined', 'no_answer', 'busy', 'voicemail', 'failed', 'cancelled');

-- AlterTable
ALTER TABLE "org_settings" ADD COLUMN     "live_transfer" JSONB;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "accepts_live_transfers" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "last_transfer_offered_at" TIMESTAMPTZ(6),
ADD COLUMN     "service_areas" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "call_transfers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "call_id" UUID NOT NULL,
    "lead_call_control_id" VARCHAR(255) NOT NULL,
    "status" "call_transfer_status" NOT NULL DEFAULT 'dialing',
    "reason" VARCHAR(40) NOT NULL,
    "facts" JSONB NOT NULL DEFAULT '{}',
    "connected_user_id" UUID,
    "fallback" VARCHAR(20),
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "connected_at" TIMESTAMPTZ(6),
    "ended_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "call_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfer_attempts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "transfer_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "phone" VARCHAR(50) NOT NULL,
    "agent_call_control_id" VARCHAR(255),
    "status" "transfer_attempt_status" NOT NULL DEFAULT 'dialing',
    "hangup_cause" VARCHAR(60),
    "dialed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answered_at" TIMESTAMPTZ(6),
    "ended_at" TIMESTAMPTZ(6),

    CONSTRAINT "transfer_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "call_transfers_organization_id_created_at_idx" ON "call_transfers"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "call_transfers_lead_id_idx" ON "call_transfers"("lead_id");

-- CreateIndex
CREATE INDEX "call_transfers_lead_call_control_id_idx" ON "call_transfers"("lead_call_control_id");

-- CreateIndex
CREATE INDEX "transfer_attempts_agent_call_control_id_idx" ON "transfer_attempts"("agent_call_control_id");

-- CreateIndex
CREATE INDEX "transfer_attempts_user_id_status_idx" ON "transfer_attempts"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "transfer_attempts_transfer_id_position_key" ON "transfer_attempts"("transfer_id", "position");

-- AddForeignKey
ALTER TABLE "call_transfers" ADD CONSTRAINT "call_transfers_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_attempts" ADD CONSTRAINT "transfer_attempts_transfer_id_fkey" FOREIGN KEY ("transfer_id") REFERENCES "call_transfers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_attempts" ADD CONSTRAINT "transfer_attempts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

