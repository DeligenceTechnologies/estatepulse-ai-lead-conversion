-- CreateTable: one settings row per organization.
CREATE TABLE "org_settings" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "timezone" VARCHAR(100) NOT NULL DEFAULT 'Asia/Kolkata',
    "working_hours" JSONB NOT NULL DEFAULT '[{"dayOfWeek":0,"isAvailable":false,"startTime":"09:00","endTime":"18:00"},{"dayOfWeek":1,"isAvailable":true,"startTime":"09:00","endTime":"18:00"},{"dayOfWeek":2,"isAvailable":true,"startTime":"09:00","endTime":"18:00"},{"dayOfWeek":3,"isAvailable":true,"startTime":"09:00","endTime":"18:00"},{"dayOfWeek":4,"isAvailable":true,"startTime":"09:00","endTime":"18:00"},{"dayOfWeek":5,"isAvailable":true,"startTime":"09:00","endTime":"18:00"},{"dayOfWeek":6,"isAvailable":false,"startTime":"09:00","endTime":"18:00"}]'::jsonb,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "org_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "org_settings_organization_id_key" ON "org_settings"("organization_id");

-- AddForeignKey
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every existing organization gets the defaults.
INSERT INTO "org_settings" ("id", "organization_id", "updated_at")
SELECT gen_random_uuid(), "id", CURRENT_TIMESTAMP FROM "organizations";
