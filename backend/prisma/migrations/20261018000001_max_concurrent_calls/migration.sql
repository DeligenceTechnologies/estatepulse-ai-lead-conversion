ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "max_concurrent_calls" INTEGER NOT NULL DEFAULT 5;

DO $$ BEGIN
  ALTER TABLE "org_settings"
    ADD CONSTRAINT "org_settings_max_concurrent_calls_check" CHECK ("max_concurrent_calls" BETWEEN 1 AND 500);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
