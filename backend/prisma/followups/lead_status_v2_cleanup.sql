-- Second half of 20261006000001_lead_status_v2 and 20261008000001_lead_status_v3.
-- NOT a migration: run it by hand (or move it into prisma/migrations) only once
-- every process writing to this database runs code that no longer writes a
-- retired status.
--
-- Mapping, identical to normalizeLeadStatus / normalizeFollowUpReason in
-- src/common/domain.ts:
--   booked                -> appointment_booked
--   lost, dnc             -> not_interested   (dnc_status keeps the opt-out)
--   contacted, engaged    -> contacting
--   qualified             -> interested
--   nurture               -> follow_up, reason not_ready
--   follow_up, no reason  -> reason other

BEGIN;

UPDATE leads SET status = 'appointment_booked' WHERE status = 'booked';
UPDATE leads SET status = 'not_interested'     WHERE status IN ('lost', 'dnc');
UPDATE leads SET status = 'contacting'         WHERE status IN ('contacted', 'engaged');
UPDATE leads SET status = 'interested'         WHERE status = 'qualified';
UPDATE leads SET status = 'follow_up', follow_up_reason = 'not_ready' WHERE status = 'nurture';
UPDATE leads SET follow_up_reason = 'other' WHERE status = 'follow_up' AND follow_up_reason IS NULL;

ALTER TABLE leads DROP CONSTRAINT leads_status_check;
ALTER TABLE leads ADD CONSTRAINT leads_status_check CHECK (
  (status)::text = ANY ((ARRAY[
    'new', 'contacting', 'follow_up', 'interested', 'appointment_requested',
    'appointment_booked', 'not_interested', 'closed', 'invalid'
  ]::character varying[])::text[])
);

COMMIT;
