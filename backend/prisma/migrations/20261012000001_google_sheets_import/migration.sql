-- Google Sheets lead import: row tracking, sync scheduling and row identity.
--
-- Built on what already exists. A connected spreadsheet tab is a lead_sources
-- row (provider 'GOOGLE_SHEETS', connection_method 'SYNC', external_form_id
-- '<spreadsheetId>:<sheetId>'); the Google grant behind it is a
-- provider_credentials row; its column mapping lives in lead_source_fields and
-- lead_source_field_mappings; sync run history goes to audit_logs. None of
-- those can hold one record per spreadsheet ROW, so that is the only new table.
--
-- Additive only: one new table, nullable or defaulted columns on lead_sources,
-- and indexes. Nothing existing is rewritten, renamed or dropped.

-- ---------------------------------------------------------------------------
-- lead_sources: sync scheduling, lease, and row identity
-- ---------------------------------------------------------------------------
ALTER TABLE lead_sources
  -- When the next sync is due. NULL = not scheduled (paused or unconfigured).
  ADD COLUMN sync_next_at         TIMESTAMPTZ(6),
  -- Lease. A worker claims a due source with FOR UPDATE SKIP LOCKED and sets
  -- both; it must still hold the lease to record the result. A lease older
  -- than the stuck threshold may be taken over.
  ADD COLUMN sync_locked_at       TIMESTAMPTZ(6),
  ADD COLUMN sync_locked_by       VARCHAR(100),
  -- Drive file version at the last COMPLETE read, for skipping an unchanged
  -- sheet — only once that probe is proven reliable.
  ADD COLUMN sync_remote_version  VARCHAR(64),
  -- Consecutive failed runs; drives backoff. Reset on success.
  ADD COLUMN sync_failures        INTEGER NOT NULL DEFAULT 0,
  -- Row identity: the field_key of the owner's stable unique-ID column...
  ADD COLUMN sync_row_key_field   VARCHAR(255),
  -- ...or, when the sheet has none, the owner's acknowledgement that the
  -- fallback identity (a hash of phone, email and name) turns an edit to any
  -- of those into a new pending lead. Sync must refuse to run with neither.
  ADD COLUMN sync_fallback_ack_at TIMESTAMPTZ(6),
  ADD COLUMN sync_fallback_ack_by UUID;

ALTER TABLE lead_sources
  ADD CONSTRAINT lead_sources_sync_failures_check CHECK (sync_failures >= 0);

-- One live source per spreadsheet tab per organization. Partial, like
-- lead_sources_api_form_unique: archived sources keep their history without
-- blocking a reconnect, and non-SYNC sources are untouched.
CREATE UNIQUE INDEX lead_sources_sync_file_unique
  ON lead_sources (organization_id, provider, external_form_id)
  WHERE connection_method = 'SYNC' AND external_form_id IS NOT NULL AND archived_at IS NULL;

-- The scheduler's "what is due?" scan, across tenants by design.
CREATE INDEX idx_lead_sources_sync_due
  ON lead_sources (sync_next_at)
  WHERE connection_method = 'SYNC' AND is_active AND archived_at IS NULL;

-- ---------------------------------------------------------------------------
-- sheet_import_rows: one record per spreadsheet row we have seen
-- ---------------------------------------------------------------------------
-- Keyed by a stable identity (row_key), never by row_number, which shifts
-- whenever someone sorts, inserts or deletes rows. Holds the review state of
-- an imported lead (the lead itself stays at status 'new', paused, until it is
-- approved) and what the sheet did to the row afterwards.
--
-- Rows the sheet supplies but we refuse (no contact details, duplicate key
-- within the sheet) are NOT stored here; they are reported in the run summary.
CREATE TABLE sheet_import_rows (
  id                      UUID PRIMARY KEY,
  organization_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- NO ACTION, not CASCADE: sources are archived, never deleted, and losing
  -- these rows would make the next sync re-import every row as a new lead.
  lead_source_id          UUID NOT NULL REFERENCES lead_sources(id) ON DELETE NO ACTION,
  -- sha256 hex of the identity (unique-ID value, or the fallback hash).
  row_key                 VARCHAR(64) NOT NULL,
  -- SET NULL: deleting a lead must not erase the memory that its row was
  -- imported, or the next sync would bring it straight back.
  lead_id                 UUID REFERENCES leads(id) ON DELETE SET NULL,
  -- sha256 hex of the row's mapped values, to tell an edited row from a re-read.
  content_hash            VARCHAR(64) NOT NULL,
  -- Where the row was last seen. Display only.
  row_number              INTEGER NOT NULL,
  review_state            VARCHAR(20) NOT NULL DEFAULT 'pending',
  reviewed_by             UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at             TIMESTAMPTZ(6),
  -- Set when the sheet changes a row that was already approved or rejected.
  -- The lead is NOT overwritten; changed_values holds the new mapped values
  -- until the owner resolves the flag.
  changed_after_review_at TIMESTAMPTZ(6),
  changed_values          JSONB,
  -- Set only after a COMPLETE read no longer finds the row. Leads are never
  -- deleted because a row disappeared.
  missing_since           TIMESTAMPTZ(6),
  created_at              TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT sheet_import_rows_review_state_check
    CHECK (review_state IN ('pending', 'approved', 'rejected')),
  -- A decision always says when it was made; a pending row has none.
  CONSTRAINT sheet_import_rows_reviewed_check
    CHECK ((review_state = 'pending') = (reviewed_at IS NULL)),
  -- A change flag without the values that raised it could never be resolved.
  CONSTRAINT sheet_import_rows_changed_check
    CHECK ((changed_after_review_at IS NULL) = (changed_values IS NULL)),
  CONSTRAINT sheet_import_rows_row_number_check
    CHECK (row_number >= 1)
);

-- Duplicate-import protection: one record per row identity per source. The
-- backstop under every sync, however a retry or overlap interleaves.
CREATE UNIQUE INDEX sheet_import_rows_source_row_unique
  ON sheet_import_rows (lead_source_id, row_key);

-- The review queue, newest first, keyset-paginated on (created_at, id).
CREATE INDEX idx_sheet_import_rows_pending
  ON sheet_import_rows (organization_id, created_at DESC, id)
  WHERE review_state = 'pending';

-- From a lead to its row (approve/reject by lead id, the lead detail), and for
-- the ON DELETE SET NULL from leads.
CREATE INDEX idx_sheet_import_rows_lead ON sheet_import_rows (lead_id);

-- Same as every other public table: the API connects as a role that bypasses
-- RLS, and with no policies nothing else (PostgREST's anon key) can read it.
ALTER TABLE sheet_import_rows ENABLE ROW LEVEL SECURITY;
