-- BoldTrail (kvCORE) CRM sync. It reuses everything HubSpot's sync built
-- (20261016000002_crm_hubspot_sync):
--   * the API token is an integrations row (provider 'boldtrail'), sealed to
--     (organization, row id) in credentials, like a HubSpot refresh token;
--   * the connection's import is a lead_sources row (provider 'BOLDTRAIL',
--     connection_method 'SYNC', external_form_id = the BoldTrail account id);
--   * runs are crm_sync_runs rows. BoldTrail sends no webhooks, so no
--     ingest_events rows are written for it except EstatePulse's own re-reads.
--
-- The same two policies as HubSpot, as partial unique indexes:

-- One live BoldTrail connection per organization...
CREATE UNIQUE INDEX "integrations_one_live_boldtrail"
  ON "integrations" ("organization_id")
  WHERE "provider" = 'boldtrail' AND "revoked_at" IS NULL;

-- ...and a BoldTrail account is live in at most one organization.
CREATE UNIQUE INDEX "integrations_boldtrail_account_live"
  ON "integrations" ("external_account_id")
  WHERE "provider" = 'boldtrail' AND "revoked_at" IS NULL;
