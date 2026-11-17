-- Airtable, phase 2: connection constraints.
--
-- The grant itself needs no new table: it is an integrations row with
-- provider 'airtable', its refresh token sealed in "credentials" and the
-- scopes Airtable granted kept in "config". Only the uniqueness rules below
-- are new, and Prisma cannot express a partial index.

-- One live connection per Airtable account per organization. A reconnect
-- updates that row in place, so the bases and tables chosen under it — and the
-- leads already imported — carry on. Two tabs finishing the same consent
-- screen at once land on the same row instead of making a second one.
CREATE UNIQUE INDEX IF NOT EXISTS "integrations_airtable_account_live"
  ON "integrations" ("organization_id", "external_account_id")
  WHERE "provider" = 'airtable' AND "revoked_at" IS NULL;
