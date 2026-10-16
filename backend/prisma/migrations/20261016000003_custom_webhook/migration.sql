-- Custom webhook sources (lead_sources.provider = 'CUSTOM'): any app posts a
-- lead as JSON and the owner maps the first payload's fields on screen.
-- Additive: no existing row, default or constraint changes.
ALTER TYPE "lead_source_provider" ADD VALUE IF NOT EXISTS 'CUSTOM';

-- How an inbound delivery proves itself (auth mode, header, algorithm,
-- encoding, basic-auth username) and which header carries the sender's
-- delivery id. The secret stays in signing_secret_enc. NULL on other sources.
ALTER TABLE "lead_sources" ADD COLUMN IF NOT EXISTS "custom_config" JSONB;

-- Campaign attribution a custom webhook may carry; only an owner maps these.
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "utm_source" VARCHAR(255);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "utm_medium" VARCHAR(255);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "utm_campaign" VARCHAR(255);
