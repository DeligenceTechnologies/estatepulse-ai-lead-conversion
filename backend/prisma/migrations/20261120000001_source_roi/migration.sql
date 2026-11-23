-- Source ROI: what each lead source costs per appointment and per closing.
--   lead_source_spend  the owner's marketing spend, one row per source per month
--   usage_records      the cost ledger: one row per costed call or text (an estimate
--                      from minutes/segments × the rate at the time, until a provider cost replaces it)
--   lead_appointments  a lasting copy of each lead's meetings; calendar_meetings rows are
--                      pruned after 90 days and deleted with their connection, this is not
--   leads.deal_*       won / lost, the deal's value and when it closed
--   org_settings.*_rate  the organization's own rates; NULL = the built-in default

-- CreateTable
CREATE TABLE "lead_source_spend" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "lead_source_id" UUID NOT NULL,
    "month" DATE NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "lead_source_spend_pkey" PRIMARY KEY ("id"),
    -- Always the first day of the month, never a negative amount.
    CONSTRAINT "lead_source_spend_month_check" CHECK ("month" = date_trunc('month', "month"::timestamp)::date),
    CONSTRAINT "lead_source_spend_amount_check" CHECK ("amount" >= 0)
);

-- CreateTable
CREATE TABLE "usage_records" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "lead_id" UUID,
    "metric" VARCHAR(30) NOT NULL,
    "source_id" UUID NOT NULL,
    "quantity" DECIMAL(12,4) NOT NULL,
    "unit_rate" DECIMAL(12,6),
    "amount" DECIMAL(12,4),
    "is_estimated" BOOLEAN NOT NULL DEFAULT true,
    "provider" VARCHAR(30),
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_appointments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "meeting_id" UUID,
    "provider" VARCHAR(20) NOT NULL,
    "external_id" VARCHAR(500) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "booked_via" VARCHAR(30),
    "host_user_id" UUID,
    "booked_at" TIMESTAMPTZ(6) NOT NULL,
    "no_show_at" TIMESTAMPTZ(6),
    "no_show_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "lead_appointments_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "deal_outcome" VARCHAR(10),
ADD COLUMN     "deal_value" DECIMAL(12,2),
ADD COLUMN     "deal_closed_at" TIMESTAMPTZ(6),
ADD CONSTRAINT "leads_deal_outcome_check" CHECK ("deal_outcome" IN ('won', 'lost')),
ADD CONSTRAINT "leads_deal_value_check" CHECK ("deal_value" IS NULL OR "deal_value" >= 0);

-- AlterTable
ALTER TABLE "org_settings" ADD COLUMN     "call_rate_per_minute" DECIMAL(8,4),
ADD COLUMN     "sms_rate_per_segment" DECIMAL(8,4),
ADD CONSTRAINT "org_settings_cost_rates_check" CHECK (coalesce("call_rate_per_minute", 0) >= 0 AND coalesce("sms_rate_per_segment", 0) >= 0);

-- CreateIndex
CREATE UNIQUE INDEX "lead_source_spend_organization_id_lead_source_id_month_key" ON "lead_source_spend"("organization_id", "lead_source_id", "month");

-- CreateIndex
CREATE UNIQUE INDEX "usage_records_metric_source_id_key" ON "usage_records"("metric", "source_id");

-- CreateIndex
CREATE INDEX "usage_records_organization_id_metric_occurred_at_idx" ON "usage_records"("organization_id", "metric", "occurred_at");

-- CreateIndex
CREATE INDEX "usage_records_lead_id_idx" ON "usage_records"("lead_id");

-- CreateIndex
CREATE UNIQUE INDEX "lead_appointments_organization_id_provider_external_id_key" ON "lead_appointments"("organization_id", "provider", "external_id");

-- CreateIndex
CREATE INDEX "lead_appointments_lead_id_idx" ON "lead_appointments"("lead_id");

-- CreateIndex
CREATE INDEX "lead_appointments_meeting_id_idx" ON "lead_appointments"("meeting_id");

-- AddForeignKey
ALTER TABLE "lead_source_spend" ADD CONSTRAINT "lead_source_spend_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_source_spend" ADD CONSTRAINT "lead_source_spend_lead_source_id_fkey" FOREIGN KEY ("lead_source_id") REFERENCES "lead_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_appointments" ADD CONSTRAINT "lead_appointments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_appointments" ADD CONSTRAINT "lead_appointments_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: the meetings still on record. Ones already pruned, or lost when a
-- calendar was disconnected, cannot be recovered.
INSERT INTO "lead_appointments" ("id", "organization_id", "lead_id", "meeting_id", "provider", "external_id", "status",
                                 "starts_at", "ends_at", "booked_via", "host_user_id", "booked_at", "created_at", "updated_at")
SELECT gen_random_uuid(), m."organization_id", m."lead_id", m."id", c."provider"::text, m."external_id", m."status"::text,
       m."starts_at", m."ends_at", m."booked_via", m."host_user_id", m."created_at", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM "calendar_meetings" m
  JOIN "calendar_connections" c ON c."id" = m."connection_id"
 WHERE m."lead_id" IS NOT NULL
ON CONFLICT ("organization_id", "provider", "external_id") DO NOTHING;
