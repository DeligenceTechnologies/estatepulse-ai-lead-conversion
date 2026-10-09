-- Sequence enroll triggers: the five "strategy ran out" conditions are replaced
-- by the five follow-up reasons (lead_status_v3). A sequence claiming
-- 'follow_up_<reason>' enrols a lead the moment it is parked in follow_up for
-- that reason.
--
-- No rows held a retired value when this was written. They stay legal anyway,
-- as the lead statuses did, so a process still running older code cannot fail a
-- save; nothing in the current code fires them.

ALTER TABLE sequence_enroll_triggers DROP CONSTRAINT IF EXISTS sequence_enroll_triggers_trigger_check;

ALTER TABLE sequence_enroll_triggers ADD CONSTRAINT sequence_enroll_triggers_trigger_check CHECK (trigger IN (
  'qualified_hot',
  'qualified_warm',
  'qualified_cold',
  'follow_up_no_answer',
  'follow_up_not_ready',
  'follow_up_callback_requested',
  'follow_up_needs_time',
  'follow_up_other',
  -- retired, see header
  'call_failed',
  'no_answer',
  'answered_not_qualified',
  'no_reply',
  'strategy_completed'
));
