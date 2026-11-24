-- BoldTrail (kvCORE) CRM, phase 1: the provider values the connection needs.
--
-- Enum additions live in their own migration and are used by none of the
-- statements here. PostgreSQL will not let a value added by ALTER TYPE be used
-- in the same transaction, and Prisma runs each migration in one, so the
-- indexes that reference these values are added by the next migration.

ALTER TYPE "integration_provider" ADD VALUE IF NOT EXISTS 'boldtrail';
ALTER TYPE "lead_source_provider" ADD VALUE IF NOT EXISTS 'BOLDTRAIL';
