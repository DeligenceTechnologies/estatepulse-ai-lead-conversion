-- CreateEnum
CREATE TYPE "outreach_batch_mode" AS ENUM ('now', 'scheduled');

-- CreateEnum
CREATE TYPE "outreach_batch_status" AS ENUM ('pending', 'running', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "outreach_item_state" AS ENUM ('queued', 'released', 'skipped', 'cancelled');

-- AlterTable
ALTER TABLE "org_settings" ADD COLUMN     "max_concurrent_ai_calls" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "reserved_call_slots" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "outreach_batches" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "mode" "outreach_batch_mode" NOT NULL,
    "status" "outreach_batch_status" NOT NULL DEFAULT 'pending',
    "start_at" TIMESTAMPTZ(6) NOT NULL,
    "timezone" VARCHAR(100) NOT NULL,
    "total" INTEGER NOT NULL DEFAULT 0,
    "held_at_approval" INTEGER NOT NULL DEFAULT 0,
    "created_by" UUID,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "outreach_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outreach_batch_leads" (
    "batch_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "state" "outreach_item_state" NOT NULL DEFAULT 'queued',
    "skip_reason" VARCHAR(30),
    "released_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "outreach_batch_leads_pkey" PRIMARY KEY ("batch_id","lead_id")
);

-- CreateIndex
CREATE INDEX "outreach_batches_status_start_at_idx" ON "outreach_batches"("status", "start_at");

-- CreateIndex
CREATE INDEX "outreach_batches_organization_id_created_at_idx" ON "outreach_batches"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "outreach_batch_leads_batch_id_state_idx" ON "outreach_batch_leads"("batch_id", "state");

-- CreateIndex
CREATE INDEX "outreach_batch_leads_organization_id_state_released_at_idx" ON "outreach_batch_leads"("organization_id", "state", "released_at");

-- CreateIndex
CREATE INDEX "outreach_batch_leads_lead_id_idx" ON "outreach_batch_leads"("lead_id");

-- AddForeignKey
ALTER TABLE "outreach_batches" ADD CONSTRAINT "outreach_batches_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_batch_leads" ADD CONSTRAINT "outreach_batch_leads_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "outreach_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_batch_leads" ADD CONSTRAINT "outreach_batch_leads_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

