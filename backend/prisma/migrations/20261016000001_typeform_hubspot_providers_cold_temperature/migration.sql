-- Ported from development: Typeform as a form provider (27f1397), HubSpot as a
-- CRM provider (d0fcdb6), and every lead starts cold (8bd919d).
--
-- Additive only: enum values and a column default. The new enum values are
-- added here, on their own, because Postgres does not allow a value added in a
-- transaction to be used in that same transaction; the CRM tables and the
-- indexes that name 'hubspot' / 'HUBSPOT' follow in the next migration.
-- The UPDATE only fills leads that have no temperature yet; an AI call still
-- rewrites it later.

-- AlterEnum
ALTER TYPE "integration_provider" ADD VALUE 'typeform';
ALTER TYPE "integration_provider" ADD VALUE 'hubspot';

-- AlterEnum
ALTER TYPE "lead_source_provider" ADD VALUE 'TYPEFORM';
ALTER TYPE "lead_source_provider" ADD VALUE 'HUBSPOT';

-- AlterTable
ALTER TABLE "leads" ALTER COLUMN "temperature" SET DEFAULT 'cold';

UPDATE "leads" SET "temperature" = 'cold' WHERE "temperature" IS NULL;
