-- The agent texting a lead in place of the AI ("Take over" in their Conversations). Until they hand it
-- back, the AI does not answer the lead and no automated step reaches them. Cleared when the lead is
-- reassigned; a deleted user's takeover goes with them.
ALTER TABLE "leads" ADD COLUMN "taken_over_at" TIMESTAMPTZ(6),
ADD COLUMN "taken_over_by_id" UUID;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_taken_over_by_id_fkey" FOREIGN KEY ("taken_over_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
