-- Second half of 20261006000001_lead_status_v2. NOT a migration: run it by hand
-- (or move it into prisma/migrations) only once every process writing to this
-- database runs code that no longer writes 'booked' or 'lost'.
--
-- Mapping, identical to normalizeLeadStatus in src/common/domain.ts:
--   booked               -> appointment_booked
--   lost + dnc_status    -> dnc
--   lost                 -> not_interested

BEGIN;

UPDATE leads SET status = 'appointment_booked' WHERE status = 'booked';
UPDATE leads SET status = 'dnc'            WHERE status = 'lost' AND dnc_status = true;
UPDATE leads SET status = 'not_interested' WHERE status = 'lost';

ALTER TABLE leads DROP CONSTRAINT leads_status_check;
ALTER TABLE leads ADD CONSTRAINT leads_status_check CHECK (
  (status)::text = ANY ((ARRAY[
    'new', 'contacting', 'contacted', 'engaged', 'qualified',
    'appointment_requested', 'appointment_booked', 'follow_up', 'nurture',
    'not_interested', 'dnc', 'invalid', 'closed'
  ]::character varying[])::text[])
);

COMMIT;
