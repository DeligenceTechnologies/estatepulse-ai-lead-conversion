-- Deactivating a sequence must release its conditions without forgetting them.
--
-- The previous migration reserved a condition by the mere existence of a row,
-- which meant deactivating a sequence had to DELETE its rows to let another
-- sequence claim the condition. That loses the configuration: switch a sequence
-- off and back on, and every tick box is silently clear. The office would have
-- to remember what it had chosen.
--
-- So the row survives and carries whether it is currently in force. `active`
-- mirrors followup_sequences.status = 'active' and is written in the same
-- transaction that moves it — a denormalisation, and the only way a plain
-- partial unique index can express "one per condition AMONG ACTIVE SEQUENCES"
-- when the status lives in another table.

ALTER TABLE sequence_enroll_triggers
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;

-- The reservation now applies only to conditions actually in force. An inactive
-- sequence keeps its tick boxes and blocks nobody.
DROP INDEX IF EXISTS sequence_enroll_triggers_one_per_trigger;

CREATE UNIQUE INDEX IF NOT EXISTS sequence_enroll_triggers_one_per_active_trigger
  ON sequence_enroll_triggers (organization_id, trigger)
  WHERE active;

-- A sequence lists each condition at most once, in force or not. Without this a
-- sequence could hold two rows for 'no_answer' — one active, one not — and
-- which one wins on reactivation would be row order.
CREATE UNIQUE INDEX IF NOT EXISTS sequence_enroll_triggers_one_per_sequence
  ON sequence_enroll_triggers (sequence_id, trigger);

-- Rows written before this migration belong to active sequences by
-- construction, so the DEFAULT TRUE above is already right for them. Stated
-- explicitly anyway: a sequence archived between the two migrations would
-- otherwise keep reserving a condition nothing can use.
UPDATE sequence_enroll_triggers t
   SET active = FALSE
  FROM followup_sequences s
 WHERE s.id = t.sequence_id
   AND s.status <> 'active';
