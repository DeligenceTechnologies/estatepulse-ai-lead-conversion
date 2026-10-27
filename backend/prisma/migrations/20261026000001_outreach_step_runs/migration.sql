-- Conditional outreach: a record of every strategy / sequence step run (additive),
-- and when a call was answered, so a short call or voicemail is told from a conversation.

-- AlterTable
ALTER TABLE "calls" ADD COLUMN "answered_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "outreach_step_runs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "source" VARCHAR(20) NOT NULL,
    "enrollment_id" UUID,
    "run_key" VARCHAR(120) NOT NULL,
    "step_number" INTEGER NOT NULL,
    "channel" VARCHAR(10) NOT NULL,
    "outcome" VARCHAR(20) NOT NULL,
    "reason" VARCHAR(40),
    "call_key" VARCHAR(200),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outreach_step_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "outreach_step_runs_lead_id_run_key_key" ON "outreach_step_runs"("lead_id", "run_key");

-- CreateIndex
CREATE INDEX "outreach_step_runs_organization_id_created_at_idx" ON "outreach_step_runs"("organization_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "outreach_step_runs" ADD CONSTRAINT "outreach_step_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_step_runs" ADD CONSTRAINT "outreach_step_runs_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
