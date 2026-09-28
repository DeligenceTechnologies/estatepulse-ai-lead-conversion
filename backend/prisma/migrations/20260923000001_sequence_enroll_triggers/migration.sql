-- Enrolment conditions: what has to happen to a lead for it to be added to a
-- sequence automatically.
--
-- Until now the only condition was `auto_enroll_temperature`, and it fired from
-- exactly one place — EngineService.qualified(). That covers the path where the
-- AI reached the lead, held a conversation and reported a temperature, and it
-- covers nothing else. A lead who never picked up ran every strategy step, was
-- parked in 'nurture' by exitStrategy(), and then sat there: no sequence, no
-- follow-up, no further contact. The leads most in need of a drip were the ones
-- getting none.
--
-- So a sequence now claims a SET of conditions, and temperature is three of
-- them rather than a separate mechanism.

-- One claimed condition. A row exists only while its sequence is active — see
-- the delete in FollowupService when status moves off 'active' — which is what
-- lets the unique index below mean "among active sequences" without the partial
-- predicate needing to reach into another table.
CREATE TABLE IF NOT EXISTS sequence_enroll_triggers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  sequence_id     UUID        NOT NULL REFERENCES followup_sequences(id) ON DELETE CASCADE,
  trigger         VARCHAR(30) NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The whole vocabulary, in one place. A value not listed here is a typo, and a
-- typo that reaches the column is a condition that silently never fires — the
-- worst kind of failure for this feature, because the sequence looks configured.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sequence_enroll_triggers_trigger_check'
  ) THEN
    ALTER TABLE sequence_enroll_triggers
      ADD CONSTRAINT sequence_enroll_triggers_trigger_check
      CHECK (trigger IN (
        -- The AI reported a temperature. These three replace
        -- auto_enroll_temperature one for one.
        'qualified_hot',
        'qualified_warm',
        'qualified_cold',
        -- Every call attempt errored before it rang — a dead number, usually.
        'call_failed',
        -- Calls were placed and rang out. Nobody ever picked up.
        'no_answer',
        -- A call was answered, but the conversation never produced a
        -- qualification.
        'answered_not_qualified',
        -- Never responded to anything, by any channel.
        'no_reply',
        -- The strategy ran to the end without converting. The catch-all, and
        -- true whenever any of the four above are.
        'strategy_completed'
      ));
  END IF;
END $$;

-- At most one sequence per office may claim a given condition, the same rule
-- followup_sequences_one_per_temperature enforced for temperature and for the
-- same reason: two sequences claiming 'no_answer' makes "where does an
-- unanswered lead go" a race decided by row order.
CREATE UNIQUE INDEX IF NOT EXISTS sequence_enroll_triggers_one_per_trigger
  ON sequence_enroll_triggers (organization_id, trigger);

CREATE INDEX IF NOT EXISTS idx_sequence_enroll_triggers_sequence
  ON sequence_enroll_triggers (sequence_id);

-- Carry the existing configuration across. An office that had a warm sequence
-- must still have one after this migration, without touching anything.
INSERT INTO sequence_enroll_triggers (organization_id, sequence_id, trigger)
SELECT organization_id, id, 'qualified_' || auto_enroll_temperature
  FROM followup_sequences
 WHERE auto_enroll_temperature IS NOT NULL
   AND status = 'active'
ON CONFLICT DO NOTHING;

-- auto_enroll_temperature is deliberately NOT dropped here.
--
-- Dropping a column in the same migration that starts reading its replacement
-- leaves no way back if the new table turns out to be wrong, and the old column
-- is now written by nothing. It is dead weight, not a second source of truth:
-- the partial unique index that gave it teeth is removed below, so nothing
-- enforces it any more and nothing reads it.
DROP INDEX IF EXISTS followup_sequences_one_per_temperature;
