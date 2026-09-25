-- Correct two indexes from 20260921000002, which assumed the runner would claim
-- a row by moving its status to 'processing'.
--
-- It cannot. `sequence_enrollments_status_check` — a CHECK constraint that
-- predates this work and is not represented in schema.prisma — restricts status
-- to active|paused|completed|stopped, so that write fails outright. The runner
-- now claims by taking `locked_by` and leaves the status alone, which is also
-- the better separation: status is a domain state the Follow-ups screen shows,
-- the lock is a queue detail nobody outside the runner should see.
--
-- The previous migration is left untouched on purpose: it is already applied,
-- and editing an applied migration changes its checksum.

-- One live enrolment per lead. 'processing' never occurs, so naming it here was
-- misleading; active and paused are the real non-terminal states.
DROP INDEX IF EXISTS sequence_enrollments_one_active_per_lead;

CREATE UNIQUE INDEX IF NOT EXISTS sequence_enrollments_one_active_per_lead
  ON sequence_enrollments (lead_id)
  WHERE status IN ('active', 'paused');

-- The stuck-lock sweep looks for rows holding a lock, not for a status.
DROP INDEX IF EXISTS idx_sequence_enrollments_locked;

CREATE INDEX IF NOT EXISTS idx_sequence_enrollments_locked
  ON sequence_enrollments (locked_at)
  WHERE locked_by IS NOT NULL;

-- The claim query filters on `locked_by IS NULL` as well as the due time, so
-- the partial index it uses should carry the same predicate.
DROP INDEX IF EXISTS idx_sequence_enrollments_due;

CREATE INDEX IF NOT EXISTS idx_sequence_enrollments_due
  ON sequence_enrollments (next_action_at)
  WHERE status = 'active' AND locked_by IS NULL;
