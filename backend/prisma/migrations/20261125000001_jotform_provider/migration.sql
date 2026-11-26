-- Jotform as a form provider: integrations.provider = 'jotform' (the owner's
-- API key) and lead_sources.provider = 'JOTFORM' (each connected form).
--
-- Enum values only, and nothing that uses them: Postgres refuses a value added
-- by ALTER TYPE inside the transaction that added it (see the Google Forms
-- migration). A Jotform source reuses the columns Tally and Typeform already
-- have, so no new column is needed.
--
-- Additive: no existing row, default or constraint changes.
ALTER TYPE "integration_provider" ADD VALUE IF NOT EXISTS 'jotform';
ALTER TYPE "lead_source_provider" ADD VALUE IF NOT EXISTS 'JOTFORM';
