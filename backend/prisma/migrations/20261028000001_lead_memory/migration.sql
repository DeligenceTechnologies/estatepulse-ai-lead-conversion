-- Each org's qualification questions, and what each lead already told the AI.
-- IF NOT EXISTS: qualification_questions and qualification_answers were added by hand to some databases before.
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "qualification_questions" JSONB;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "qualification_answers" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "memory_summary" TEXT;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "memory_updated_at" TIMESTAMPTZ(6);
