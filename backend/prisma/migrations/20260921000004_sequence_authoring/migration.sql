-- Author your own sequences, and decide per sequence which temperature (if any)
-- enrols into it automatically.
--
-- Until now the temperature -> sequence mapping was a constant in the code
-- (SEQUENCE_FOR_TEMPERATURE). That was fine while there were exactly two
-- sequences and nobody could create a third; the moment an office can author
-- its own, "which one do warm leads go into" is a question only the office can
-- answer, so it becomes a column.

ALTER TABLE followup_sequences
  ADD COLUMN IF NOT EXISTS auto_enroll_temperature VARCHAR(10);

-- Same three values as leads.temperature. NULL means manual-only, which is the
-- default for anything an office creates: a new sequence must never start
-- silently swallowing leads because it happened to be saved.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'followup_sequences_auto_enroll_check'
  ) THEN
    ALTER TABLE followup_sequences
      ADD CONSTRAINT followup_sequences_auto_enroll_check
      CHECK (auto_enroll_temperature IS NULL
             OR auto_enroll_temperature IN ('hot', 'warm', 'cold'));
  END IF;
END $$;

-- At most one sequence per office may claim a given temperature. Without this,
-- two sequences both set to 'warm' make "where does a warm lead go" a race
-- decided by row order — the same class of bug as the non-unique
-- idx_lead_assignments_current.
--
-- Scoped to active sequences: an archived one must not block its replacement
-- from taking over the temperature it used to own.
CREATE UNIQUE INDEX IF NOT EXISTS followup_sequences_one_per_temperature
  ON followup_sequences (organization_id, auto_enroll_temperature)
  WHERE auto_enroll_temperature IS NOT NULL AND status = 'active';

-- Preserve the behaviour the code had hardcoded, so applying this migration
-- changes nothing for an office already running the two seeded sequences.
UPDATE followup_sequences SET auto_enroll_temperature = 'warm'
 WHERE code = 'WARM_NURTURE' AND auto_enroll_temperature IS NULL;

UPDATE followup_sequences SET auto_enroll_temperature = 'cold'
 WHERE code = 'COLD_REACTIVATION' AND auto_enroll_temperature IS NULL;

-- How a lead got into a sequence. The runner does not care, but "did somebody
-- add this person or did the system" is the first question asked when a lead
-- complains about a text, and reconstructing it from timestamps is guesswork.
ALTER TABLE sequence_enrollments
  ADD COLUMN IF NOT EXISTS enrolled_by VARCHAR(20) NOT NULL DEFAULT 'auto';

ALTER TABLE sequence_enrollments
  ADD COLUMN IF NOT EXISTS enrolled_by_user_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sequence_enrollments_enrolled_by_fkey'
  ) THEN
    ALTER TABLE sequence_enrollments
      ADD CONSTRAINT sequence_enrollments_enrolled_by_fkey
      FOREIGN KEY (enrolled_by_user_id) REFERENCES users(id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sequence_enrollments_enrolled_by_check'
  ) THEN
    ALTER TABLE sequence_enrollments
      ADD CONSTRAINT sequence_enrollments_enrolled_by_check
      CHECK (enrolled_by IN ('auto', 'manual', 'bulk'));
  END IF;
END $$;
