-- Lead journey foundation: two statuses, two follow-up reasons, how a call
-- ended, and a log of every outreach decision. The data that moves to the new
-- values is in the next migration: a value added to an enum cannot be used in
-- the same transaction that adds it.

-- AlterEnum
ALTER TYPE "lead_status" ADD VALUE 'engaged' AFTER 'contacting';
ALTER TYPE "lead_status" ADD VALUE 'unresponsive' AFTER 'not_interested';

-- AlterEnum
ALTER TYPE "follow_up_reason" ADD VALUE 'appointment_canceled';
ALTER TYPE "follow_up_reason" ADD VALUE 'no_show';

-- CreateEnum
CREATE TYPE "call_disposition" AS ENUM ('no_answer', 'busy', 'rejected', 'voicemail', 'short', 'connected', 'failed', 'invalid_number');

-- AlterTable
ALTER TABLE "calls" ADD COLUMN "disposition" "call_disposition";

-- CreateTable
CREATE TABLE "lead_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "type" VARCHAR(50) NOT NULL,
    "from_status" "lead_status",
    "to_status" "lead_status",
    "reason" TEXT,
    "channel" VARCHAR(10),
    "source" VARCHAR(30) NOT NULL,
    "actor_type" "actor_type" NOT NULL,
    "actor_id" UUID,
    "call_id" UUID,
    "payload" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lead_events_lead_id_created_at_idx" ON "lead_events"("lead_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "lead_events_organization_id_type_created_at_idx" ON "lead_events"("organization_id", "type", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "lead_events" ADD CONSTRAINT "lead_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_events" ADD CONSTRAINT "lead_events_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_events" ADD CONSTRAINT "lead_events_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "calls"("id") ON DELETE SET NULL ON UPDATE CASCADE;
