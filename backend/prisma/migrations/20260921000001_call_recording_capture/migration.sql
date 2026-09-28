-- Call history capture: recording + transcript.
--
-- Until now `voice_calls.recording_url`, `transcript`, `ai_summary` and
-- `extracted_intel` existed but nothing ever wrote them, so a call history view
-- would have been a list of durations. The webhook handlers that fill them land
-- with this migration; these two columns are the consent gate in front of them.

-- Recording consent is state-specific: some jurisdictions need every party to
-- consent, others only one. Both defaults are deliberately the combination that
-- is lawful in BOTH: we record, and the assistant announces that we are
-- recording at the start of the call. An office in a one-party state can turn
-- the announcement off; an office that does not want recordings at all turns
-- the whole thing off and keeps call history without audio.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS call_recording_enabled BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS call_recording_announce BOOLEAN NOT NULL DEFAULT true;

-- Org-wide call history, newest first. The existing indexes are
-- (lead_id, created_at DESC) and (organization_id) alone: the first is the wrong
-- leading column for "every call in this office", and the second leaves the sort
-- to be done in memory over the whole tenant.
CREATE INDEX IF NOT EXISTS idx_voice_calls_org_created_at
  ON voice_calls (organization_id, created_at DESC);
