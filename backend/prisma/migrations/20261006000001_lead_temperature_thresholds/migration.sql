-- Lead temperature thresholds, per organization.
--
-- After an AI call, the backend scores the lead 0-100 from the facts Telnyx
-- extracted (see backend/src/telnyx/lead-scoring.ts). These two numbers turn
-- that score into a temperature: score >= hot is HOT, score >= warm is WARM,
-- anything lower is COLD. The defaults are the milestone's 75 / 45.
--
-- Additive only: existing rows take the defaults, nothing is rewritten.
ALTER TABLE organizations
  ADD COLUMN lead_hot_threshold  INTEGER NOT NULL DEFAULT 75,
  ADD COLUMN lead_warm_threshold INTEGER NOT NULL DEFAULT 45;

ALTER TABLE organizations
  ADD CONSTRAINT organizations_lead_thresholds_check
  CHECK (lead_warm_threshold >= 1 AND lead_warm_threshold < lead_hot_threshold AND lead_hot_threshold <= 100);
