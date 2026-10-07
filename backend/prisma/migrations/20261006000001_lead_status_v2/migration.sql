-- Lead status v2: the 13-status lifecycle.
--
--   new, contacting, contacted, engaged, qualified, appointment_requested,
--   appointment_booked, follow_up, nurture, not_interested, dnc, invalid, closed
--
-- Additive on purpose. The legacy values 'booked' and 'lost' stay legal, and no
-- existing row is rewritten, because this database is shared: a process still
-- running the old code writes 'booked' and 'lost', and a constraint that
-- rejected them would fail its writes. The application reads every status
-- through normalizeLeadStatus (common/domain.ts), so legacy rows already show
-- under their new name.
--
-- Once nothing runs the old code, prisma/followups/lead_status_v2_cleanup.sql
-- rewrites the legacy rows and narrows the constraint to the 13 values.

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_status_check;

ALTER TABLE leads ADD CONSTRAINT leads_status_check CHECK (
  (status)::text = ANY ((ARRAY[
    'new',
    'contacting',
    'contacted',
    'engaged',
    'qualified',
    'appointment_requested',
    'appointment_booked',
    'follow_up',
    'nurture',
    'not_interested',
    'dnc',
    'invalid',
    'closed',
    -- legacy, see header
    'booked',
    'lost'
  ]::character varying[])::text[])
);
