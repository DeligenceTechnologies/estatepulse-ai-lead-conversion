-- Booked meetings are synced into the database, and calendar members and
-- meetings keep their timezone. Instants are timestamptz (stored as UTC);
-- working hours stay wall-clock 'HH:MM' with the timezone beside them.

-- CreateEnum
CREATE TYPE "calendar_meeting_status" AS ENUM ('scheduled', 'pending', 'canceled');

-- AlterTable
ALTER TABLE "calendar_connections" ADD COLUMN     "meetings_synced_at" TIMESTAMPTZ(6),
ADD COLUMN     "meetings_error" VARCHAR(500);

-- AlterTable
ALTER TABLE "calendar_members" ADD COLUMN     "schedule_timezone" VARCHAR(100);

-- Backfill: the schedule's timezone was kept inside the JSON until now.
UPDATE "calendar_members"
SET "schedule_timezone" = LEFT("schedule"->>'timezone', 100)
WHERE "schedule" IS NOT NULL AND "schedule"->>'timezone' IS NOT NULL;

-- CreateTable
CREATE TABLE "calendar_meetings" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "external_id" VARCHAR(500) NOT NULL,
    "event_type_id" VARCHAR(500),
    "title" VARCHAR(500) NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "timezone" VARCHAR(100),
    "status" "calendar_meeting_status" NOT NULL,
    "invitees" JSONB NOT NULL DEFAULT '[]',
    "hosts" JSONB NOT NULL DEFAULT '[]',
    "meeting_url" VARCHAR(2000),
    "location" VARCHAR(1000),
    "reschedule_url" VARCHAR(2000),
    "cancel_url" VARCHAR(2000),
    "canceled_reason" VARCHAR(1000),
    "synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "calendar_meetings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "calendar_meetings_connection_id_external_id_key" ON "calendar_meetings"("connection_id", "external_id");

-- CreateIndex
CREATE INDEX "calendar_meetings_connection_id_starts_at_idx" ON "calendar_meetings"("connection_id", "starts_at");

-- CreateIndex
CREATE INDEX "calendar_meetings_ends_at_idx" ON "calendar_meetings"("ends_at");

-- CreateIndex
CREATE INDEX "calendar_meetings_organization_id_idx" ON "calendar_meetings"("organization_id");

-- AddForeignKey
ALTER TABLE "calendar_meetings" ADD CONSTRAINT "calendar_meetings_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "calendar_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
