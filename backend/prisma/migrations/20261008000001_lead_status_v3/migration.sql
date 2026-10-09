-- Lead status v3: nine statuses, and a reason for follow_up.
--
--   new, contacting, follow_up, interested, appointment_requested,
--   appointment_booked, not_interested, closed, invalid
--
-- Retired: contacted, engaged (-> contacting), qualified (-> interested),
-- nurture (-> follow_up), dnc (-> not_interested; dnc_status still carries the
-- opt-out).
--
-- Additive on purpose, as v2 was. The retired values stay legal and no row is
-- rewritten, because a process still running older code may write them. The
-- application reads every status through normalizeLeadStatus
-- (src/common/domain.ts). prisma/followups/lead_status_v2_cleanup.sql rewrites
-- the rows and narrows the constraint once nothing runs the old code.

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_status_check;

ALTER TABLE leads ADD CONSTRAINT leads_status_check CHECK (
  (status)::text = ANY ((ARRAY[
    'new',
    'contacting',
    'follow_up',
    'interested',
    'appointment_requested',
    'appointment_booked',
    'not_interested',
    'closed',
    'invalid',
    -- retired, see header
    'contacted',
    'engaged',
    'qualified',
    'nurture',
    'dnc',
    'booked',
    'lost'
  ]::character varying[])::text[])
);

-- Meaningful only while status = 'follow_up'. Not tied to status by a
-- constraint: every path that leaves follow_up would have to clear it, so the
-- application ignores it for any other status instead.
ALTER TABLE leads ADD COLUMN follow_up_reason VARCHAR(30);

ALTER TABLE leads ADD CONSTRAINT leads_follow_up_reason_check CHECK (
  follow_up_reason IS NULL OR follow_up_reason IN (
    'no_answer', 'not_ready', 'callback_requested', 'needs_time', 'other'
  )
);
