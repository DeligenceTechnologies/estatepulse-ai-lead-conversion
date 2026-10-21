-- Outreach batches now pace on max_concurrent_calls (the call worker's limit);
-- the separate limit 20261021000001 added was never released and holds no real data.
ALTER TABLE "org_settings" DROP COLUMN IF EXISTS "max_concurrent_ai_calls";
