-- CRM sync (HubSpot first): durable import runs, single-use OAuth states, and
-- the constraints a CRM connection needs.
--
-- Built on what already exists, like the Google Sheets import before it:
--   * the HubSpot OAuth grant is a provider_credentials row (provider
--     'HUBSPOT'): refresh token encrypted to its row, account id, status;
--   * the connection's import is a lead_sources row (provider 'HUBSPOT',
--     connection_method 'SYNC', external_form_id = the HubSpot account id),
--     whose existing lease, schedule and error columns drive the sync;
--   * each imported contact is a sheet_import_rows row (row_key = a hash of
--     provider, object type and record id), so the unique
--     (lead_source_id, row_key) index is the "one record, one lead" guarantee
--     and the existing Import Review queue holds imported leads for approval;
--   * webhook deliveries are webhook_events rows (provider 'HUBSPOT');
--   * history and decisions go to audit_logs.
--
-- What none of those can hold is a long-running import with a resumable
-- cursor and progress (crm_sync_runs) and an OAuth state that stays single-use
-- across API instances (oauth_states). Those are the only new tables.
--
-- Additive only: two new tables, one nullable column, and indexes. Nothing
-- existing is rewritten, renamed or dropped.
--
-- Rollback (if ever needed, before any CRM data matters):
--   DROP TABLE crm_sync_runs; DROP TABLE oauth_states;
--   DROP INDEX provider_credentials_crm_org_live, provider_credentials_crm_account_live,
--              idx_lead_sources_crm_account, idx_webhook_events_source_pending;
--   ALTER TABLE sheet_import_rows DROP COLUMN last_seen_at;
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261015000001_crm_hubspot_sync';

-- ---------------------------------------------------------------------------
-- crm_sync_runs: one full read of a connected CRM, resumable
-- ---------------------------------------------------------------------------
CREATE TABLE crm_sync_runs (
  id              UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- NO ACTION: sources are archived, never deleted, and a run's history must
  -- not vanish with one.
  lead_source_id  UUID NOT NULL REFERENCES lead_sources(id) ON DELETE NO ACTION,
  provider        VARCHAR(50) NOT NULL,
  -- initial: the first import after connecting. full: a later complete re-read
  -- (the owner's "Sync now", or the catch-up after a reconnect).
  kind            VARCHAR(20) NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'queued',
  -- NULL = queued by the system (a reconnect), not by a person.
  requested_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  -- The provider's paging cursor after the last page written. NULL = from the
  -- start. Persisted with each page, so a restart resumes rather than repeats.
  cursor          VARCHAR(255),
  pages           INTEGER NOT NULL DEFAULT 0,
  fetched         INTEGER NOT NULL DEFAULT 0,
  created         INTEGER NOT NULL DEFAULT 0,
  updated         INTEGER NOT NULL DEFAULT 0,
  unchanged       INTEGER NOT NULL DEFAULT 0,
  -- Matched to a lead that already existed (by email), instead of creating one.
  linked          INTEGER NOT NULL DEFAULT 0,
  -- A CRM change held for the owner because the lead was edited here too.
  conflicts       INTEGER NOT NULL DEFAULT 0,
  -- New leads flagged "possible duplicate" (same phone or email as another lead).
  duplicates      INTEGER NOT NULL DEFAULT 0,
  -- Records refused (no dialable phone and no valid email).
  skipped         INTEGER NOT NULL DEFAULT 0,
  -- Records the database refused individually; the rest of their page landed.
  failed          INTEGER NOT NULL DEFAULT 0,
  -- Tracked records no longer in the CRM after the complete read.
  missing         INTEGER NOT NULL DEFAULT 0,
  -- Consecutive transient failures; drives backoff. Reset by a page that lands.
  attempts        INTEGER NOT NULL DEFAULT 0,
  -- Not claimable before this: backoff after a rate limit or an outage.
  available_at    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Stable code and an owner-readable message. Never record values or tokens.
  error_code      VARCHAR(50),
  error_message   VARCHAR(500),
  created_at      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at      TIMESTAMPTZ(6),
  heartbeat_at    TIMESTAMPTZ(6),
  finished_at     TIMESTAMPTZ(6),
  updated_at      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT crm_sync_runs_kind_check CHECK (kind IN ('initial', 'full')),
  CONSTRAINT crm_sync_runs_status_check CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  -- A finished run says when; an unfinished one does not.
  CONSTRAINT crm_sync_runs_finished_check
    CHECK ((status IN ('succeeded', 'failed', 'cancelled')) = (finished_at IS NOT NULL)),
  CONSTRAINT crm_sync_runs_counts_check CHECK (
    pages >= 0 AND fetched >= 0 AND created >= 0 AND updated >= 0 AND unchanged >= 0 AND linked >= 0
    AND conflicts >= 0 AND duplicates >= 0 AND skipped >= 0 AND failed >= 0 AND missing >= 0 AND attempts >= 0
  )
);

-- One active run per connection. The backstop under "Sync now" clicked twice,
-- two tabs, or a reconnect racing a click: the second insert conflicts and the
-- caller is handed the run already in progress.
CREATE UNIQUE INDEX crm_sync_runs_one_active
  ON crm_sync_runs (lead_source_id)
  WHERE status IN ('queued', 'running');

-- History for one connection, newest first.
CREATE INDEX idx_crm_sync_runs_source
  ON crm_sync_runs (organization_id, lead_source_id, created_at DESC);

ALTER TABLE crm_sync_runs ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- oauth_states: an authorization in flight, single-use across instances
-- ---------------------------------------------------------------------------
-- The state value itself is never stored, only its sha256: a leaked backup
-- cannot complete anyone's authorization. Completion consumes the row with one
-- conditional UPDATE, so two instances (or a double submit) cannot both
-- succeed, and it must come from the same user, organization and session that
-- started it.
CREATE TABLE oauth_states (
  id              VARCHAR(64) PRIMARY KEY,
  provider        VARCHAR(50) NOT NULL,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id      UUID NOT NULL,
  expires_at      TIMESTAMPTZ(6) NOT NULL,
  consumed_at     TIMESTAMPTZ(6),
  created_at      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Housekeeping: expired states are swept by expiry.
CREATE INDEX idx_oauth_states_expires ON oauth_states (expires_at);

ALTER TABLE oauth_states ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- sheet_import_rows: when a CRM record was last seen
-- ---------------------------------------------------------------------------
-- A full CRM read is many pages over minutes, so it cannot hold every record
-- id in memory the way a sheet read does. Each page stamps the records it saw;
-- once the read completes, a tracked record stamped before the run started is
-- no longer in the CRM and is marked missing (never deleted). NULL for sheet
-- and file rows, which never read it.
ALTER TABLE sheet_import_rows ADD COLUMN last_seen_at TIMESTAMPTZ(6);

-- ---------------------------------------------------------------------------
-- provider_credentials: connection policy for CRM accounts
-- ---------------------------------------------------------------------------
-- One live HubSpot connection per organization...
CREATE UNIQUE INDEX provider_credentials_crm_org_live
  ON provider_credentials (organization_id, provider)
  WHERE provider = 'HUBSPOT' AND revoked_at IS NULL;

-- ...and a HubSpot account is live in at most one organization. A brokerage's
-- CRM belongs to one EstatePulse account: two organizations importing the same
-- contacts would both work them, and a webhook would have two owners. A
-- disconnect frees the account (revoked_at is set), so moving it is possible,
-- but never silent. Dropping this index is the whole change if sharing is ever
-- wanted — the webhook path already fans out to every live connection.
CREATE UNIQUE INDEX provider_credentials_crm_account_live
  ON provider_credentials (provider, external_account_id)
  WHERE provider = 'HUBSPOT' AND revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Lookups on the webhook and worker paths
-- ---------------------------------------------------------------------------
-- Webhook: which connection does this CRM account belong to? Across tenants
-- by design — the account id in a signature-verified delivery is how the
-- organization is found.
CREATE INDEX idx_lead_sources_crm_account
  ON lead_sources (provider, external_form_id)
  WHERE connection_method = 'SYNC' AND archived_at IS NULL;

-- Worker: a connection's pending deliveries.
CREATE INDEX idx_webhook_events_source_pending
  ON webhook_events (lead_source_id, available_at)
  WHERE queue_state = 'PENDING';
