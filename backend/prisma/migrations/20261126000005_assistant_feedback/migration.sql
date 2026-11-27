-- Thumbs up or down on an assistant answer, with an optional reason and comment on a thumbs down.
-- CreateEnum
CREATE TYPE "assistant_rating" AS ENUM ('up', 'down');

-- CreateTable
CREATE TABLE "assistant_feedback" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "rating" "assistant_rating" NOT NULL,
    "reason" VARCHAR(20),
    "comment" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "assistant_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "assistant_feedback_message_id_key" ON "assistant_feedback"("message_id");

-- CreateIndex
CREATE INDEX "assistant_feedback_organization_id_rating_created_at_idx" ON "assistant_feedback"("organization_id", "rating", "created_at");

-- AddForeignKey
ALTER TABLE "assistant_feedback" ADD CONSTRAINT "assistant_feedback_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_feedback" ADD CONSTRAINT "assistant_feedback_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "assistant_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_feedback" ADD CONSTRAINT "assistant_feedback_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "assistant_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
