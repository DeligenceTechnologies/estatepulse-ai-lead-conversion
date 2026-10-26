-- An organization calls through Telnyx OR Retell, never both: at most one
-- active calling integration per organization. The active row is the only
-- record of which provider an organization uses; there is no separate setting
-- that could disagree with it.
--
-- Existing data already satisfies this: integrations_one_active_telnyx allows
-- one active Telnyx row per organization and no Retell row exists yet.
CREATE UNIQUE INDEX "integrations_one_active_calling"
  ON "integrations" ("organization_id")
  WHERE "provider" IN ('telnyx', 'retell') AND "status" = 'active';
