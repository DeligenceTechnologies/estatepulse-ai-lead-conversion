-- Bulk actions: one assistant action on many leads, each lead frozen as an item when the card is built.
-- AlterTable
ALTER TABLE "assistant_actions" ADD COLUMN     "bulk_status" VARCHAR(20),
ADD COLUMN     "bulk_total" INTEGER;

-- CreateTable
CREATE TABLE "assistant_action_items" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "action_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "reason" VARCHAR(500),
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "assistant_action_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assistant_action_items_action_id_status_position_idx" ON "assistant_action_items"("action_id", "status", "position");

-- CreateIndex
CREATE UNIQUE INDEX "assistant_action_items_action_id_lead_id_key" ON "assistant_action_items"("action_id", "lead_id");

-- AddForeignKey
ALTER TABLE "assistant_action_items" ADD CONSTRAINT "assistant_action_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_action_items" ADD CONSTRAINT "assistant_action_items_action_id_fkey" FOREIGN KEY ("action_id") REFERENCES "assistant_actions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
