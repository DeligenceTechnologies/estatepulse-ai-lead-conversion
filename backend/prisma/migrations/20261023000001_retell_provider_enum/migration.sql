-- Retell AI as a second calling provider (behind RETELL_ENABLED).
--
-- Additive only: the enum value is added here, on its own, because Postgres
-- does not allow a value added in a transaction to be used in that same
-- transaction; the index that names 'retell' follows in the next migration.

-- AlterEnum
ALTER TYPE "integration_provider" ADD VALUE IF NOT EXISTS 'retell';
