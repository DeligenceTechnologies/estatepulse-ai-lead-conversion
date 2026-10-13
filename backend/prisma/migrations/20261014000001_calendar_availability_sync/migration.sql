-- CreateEnum
CREATE TYPE "calendar_block_kind" AS ENUM ('free', 'booking', 'calendar', 'hold');

-- CreateEnum
CREATE TYPE "calendar_member_sync_status" AS ENUM ('ok', 'limited', 'unavailable');

-- AlterTable
ALTER TABLE "calendar_connections" ADD COLUMN     "sync_error" VARCHAR(500),
ADD COLUMN     "sync_lease_until" TIMESTAMPTZ(6),
ADD COLUMN     "synced_at" TIMESTAMPTZ(6),
ADD COLUMN     "webhook_attempt_at" TIMESTAMPTZ(6),
ADD COLUMN     "webhook_id" VARCHAR(500),
ADD COLUMN     "webhook_secret" TEXT;

-- CreateTable
CREATE TABLE "calendar_members" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "external_id" VARCHAR(255) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "role" VARCHAR(20) NOT NULL,
    "timezone" VARCHAR(100),
    "username" VARCHAR(255),
    "scheduling_url" VARCHAR(500),
    "schedule" JSONB,
    "schedule_synced_at" TIMESTAMPTZ(6),
    "sync_status" "calendar_member_sync_status" NOT NULL DEFAULT 'ok',
    "sync_message" VARCHAR(500),
    "synced_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "calendar_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_time_blocks" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "kind" "calendar_block_kind" NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "blocked_starts_at" TIMESTAMPTZ(6) NOT NULL,
    "blocked_ends_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calendar_time_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "calendar_members_organization_id_idx" ON "calendar_members"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_members_connection_id_external_id_key" ON "calendar_members"("connection_id", "external_id");

-- CreateIndex
CREATE INDEX "calendar_time_blocks_connection_id_starts_at_ends_at_idx" ON "calendar_time_blocks"("connection_id", "starts_at", "ends_at");

-- CreateIndex
CREATE INDEX "calendar_time_blocks_member_id_ends_at_idx" ON "calendar_time_blocks"("member_id", "ends_at");

-- CreateIndex
CREATE INDEX "calendar_time_blocks_ends_at_idx" ON "calendar_time_blocks"("ends_at");

-- CreateIndex
CREATE INDEX "calendar_time_blocks_organization_id_idx" ON "calendar_time_blocks"("organization_id");

-- CreateIndex
CREATE INDEX "calendar_connections_is_active_status_synced_at_idx" ON "calendar_connections"("is_active", "status", "synced_at");

-- AddForeignKey
ALTER TABLE "calendar_members" ADD CONSTRAINT "calendar_members_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "calendar_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_time_blocks" ADD CONSTRAINT "calendar_time_blocks_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "calendar_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_time_blocks" ADD CONSTRAINT "calendar_time_blocks_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "calendar_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

