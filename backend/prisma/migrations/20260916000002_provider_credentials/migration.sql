-- Connecting a form through the provider's own API, instead of the customer
-- pasting our webhook URL into it by hand.
--
-- A new table rather than reusing `integrations`: that table's
-- `credentials_secret_ref` is named and typed as a REFERENCE to an external
-- vault, and putting an AES-GCM envelope in a column called `_ref` is a lie
-- that costs someone an afternoon. It also defaults `id` to gen_random_uuid(),
-- while our AAD convention needs an app-generated id before the INSERT.
-- `integrations` stays free for the OAuth-shaped connections it was designed for.

CREATE TABLE IF NOT EXISTS provider_credentials (
  id                  UUID PRIMARY KEY,
  organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider            VARCHAR(50)  NOT NULL,
  label               VARCHAR(255),

  -- SecretBox envelope; AAD = providerCredentialAad(organization_id, id).
  credential_enc      TEXT         NOT NULL,
  -- sha256(key). NOT a lookup path — only "is this the same key we already
  -- hold?". Unsalted is right here for the same reason as api_keys: a provider
  -- key is high-entropy CSPRNG output with no dictionary to attack.
  credential_hash     VARCHAR(64)  NOT NULL,
  -- Non-secret display fragments, so support can answer "which key is this?"
  credential_prefix   VARCHAR(32)  NOT NULL,
  credential_last4    VARCHAR(8)   NOT NULL,

  external_account_id VARCHAR(255),
  account_email       VARCHAR(255),
  account_name        VARCHAR(255),

  -- ACTIVE | INVALID | REVOKED
  status              VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE',
  last_verified_at    TIMESTAMPTZ(6),
  last_error_at       TIMESTAMPTZ(6),
  last_error_code     VARCHAR(50),
  revoked_at          TIMESTAMPTZ(6),

  created_at          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Scoped to the organization ON PURPOSE. A globally unique index on the hash
-- would let one tenant discover that another tenant holds the same key.
CREATE UNIQUE INDEX IF NOT EXISTS provider_credentials_key_unique
  ON provider_credentials (organization_id, provider, credential_hash)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_provider_credentials_org
  ON provider_credentials (organization_id, provider, status);

-- --- lead_sources ----------------------------------------------------------
--
-- `source_type` deliberately stays 'webhook' for API-connected sources: they
-- ARE webhook sources, byte-identical on the ingest path. Encoding the
-- connection method there would mean touching list() and every other consumer.

ALTER TABLE lead_sources
  ADD COLUMN IF NOT EXISTS provider               VARCHAR(50)  NOT NULL DEFAULT 'TALLY',
  ADD COLUMN IF NOT EXISTS connection_method      VARCHAR(20)  NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN IF NOT EXISTS provider_credential_id UUID REFERENCES provider_credentials(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS external_webhook_id    VARCHAR(255),
  ADD COLUMN IF NOT EXISTS external_workspace_id  VARCHAR(255),
  -- PENDING | INSTALLED | DRIFTED | UNINSTALLED | ORPHANED | ERROR
  ADD COLUMN IF NOT EXISTS remote_state           VARCHAR(20),
  ADD COLUMN IF NOT EXISTS remote_synced_at       TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS remote_error_code      VARCHAR(50),
  ADD COLUMN IF NOT EXISTS remote_error_message   TEXT,
  -- Non-null => this source still carries mappings built from the form schema
  -- that no real delivery has confirmed yet. One boolean check keeps the
  -- worker's hot path free of an extra query.
  ADD COLUMN IF NOT EXISTS prebuilt_at            TIMESTAMPTZ(6);

-- The real double-click guard: a pre-check SELECT races, a unique index cannot.
-- MANUAL sources are exempt — a customer may legitimately point two
-- hand-configured sources at one form, and every existing row has a NULL
-- external_form_id anyway, so this builds against zero rows.
CREATE UNIQUE INDEX IF NOT EXISTS lead_sources_api_form_unique
  ON lead_sources (organization_id, provider, external_form_id)
  WHERE connection_method = 'API' AND external_form_id IS NOT NULL AND archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_lead_sources_remote
  ON lead_sources (organization_id, remote_state)
  WHERE connection_method = 'API';

-- Every existing row is a hand-configured Tally webhook source, so the two
-- defaults above backfill correctly by construction. On PG 11+ adding a NOT
-- NULL column with a constant default is metadata-only: no table rewrite, no
-- long lock.
