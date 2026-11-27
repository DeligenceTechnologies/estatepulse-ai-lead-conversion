-- Refs the assistant's answers named that their chat never issued (made up by the model), per office per month.
ALTER TABLE "assistant_usage" ADD COLUMN "made_up_refs" INTEGER NOT NULL DEFAULT 0;
