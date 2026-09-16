-- Additive columns on `leads` required by webhook ingestion.
-- All nullable or defaulted: existing rows and any other writer are unaffected.

-- Every answer the lead gave that no mapping covers. THE guarantee that nothing
-- a prospect told us is lost, even before mapping is configured. Kept separate
-- from extracted_intel, which is reserved for AI/voice extraction.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb;

-- {first_name: {submission_id, source_id, confidence, at}} — lets a
-- user-confirmed mapping later overwrite a value that came from a
-- low-confidence heuristic guess, instead of treating both as equally trusted.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS field_provenance JSONB NOT NULL DEFAULT '{}'::jsonb;

-- TCPA consent evidence. consent_status alone is not defensible in a dispute:
-- you must be able to show WHAT wording the lead agreed to and WHEN.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS consent_source VARCHAR(50);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS consent_text TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS consent_at TIMESTAMPTZ(6);

-- False when the submitted phone could not be parsed to E.164. Such a lead is
-- still a lead — it just must never be auto-dialed.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS phone_valid BOOLEAN NOT NULL DEFAULT false;

-- Repeat-submission tracking.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS submission_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_submission_at TIMESTAMPTZ(6);

-- Identity or consent conflicts that a human must resolve. Auto-merging two
-- pre-existing leads is destructive and irreversible, so we flag instead.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS review_reasons TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE INDEX IF NOT EXISTS idx_leads_needs_review
  ON leads (organization_id, updated_at DESC)
  WHERE needs_review = true;
