-- Why a call ended (the provider's hang-up cause) and who answered it (answering machine
-- detection), and the words for a skipped outreach step. Additive only.

-- AlterTable
ALTER TABLE "calls" ADD COLUMN "end_reason" VARCHAR(40),
ADD COLUMN "answered_by" VARCHAR(20);

-- AlterTable
ALTER TABLE "outreach_step_runs" ADD COLUMN "detail" VARCHAR(300);
