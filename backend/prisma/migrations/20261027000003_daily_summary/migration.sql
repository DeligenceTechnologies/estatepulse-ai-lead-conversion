-- AlterTable
ALTER TABLE "org_settings" ADD COLUMN     "daily_summary_enabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "daily_summary_runs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "summary_date" DATE NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "recipients" INTEGER NOT NULL DEFAULT 0,
    "claimed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "daily_summary_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "daily_summary_runs_organization_id_summary_date_key" ON "daily_summary_runs"("organization_id", "summary_date");

-- AddForeignKey
ALTER TABLE "daily_summary_runs" ADD CONSTRAINT "daily_summary_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
