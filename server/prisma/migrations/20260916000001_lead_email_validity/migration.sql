-- Mirror of `phone_valid`, and added for the same class of reason.
--
-- `normalized_email` is an identity column: it is how a second submission finds
-- an existing lead. Before this, ANY string mapped to the email target became an
-- identity, so every prospect who typed "n/a" / "none" / "-" into a required
-- email box resolved to the same normalized_email and merged into a single
-- lead, overwriting a real person's details with a stranger's.
--
-- The raw address is still stored either way; only identity is gated.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS email_valid BOOLEAN NOT NULL DEFAULT false;

-- Backfill: trust the addresses already in use as identities only if they are
-- shaped like addresses. Deliberately the same permissive test the application
-- applies (isValidEmail in src/modules/processing/transforms.ts) — something
-- that looks like an address, not RFC 5322.
UPDATE leads
   SET email_valid = true
 WHERE normalized_email IS NOT NULL
   AND normalized_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$';

-- Existing rows whose stored identity does NOT pass are the ones already at
-- risk of collapsing distinct people together. Clear the identity so they stop
-- matching new submissions, and flag them for a human rather than guessing
-- which of the merged records is the real one.
WITH bad AS (
  SELECT id FROM leads
   WHERE normalized_email IS NOT NULL
     AND email_valid = false
)
UPDATE leads l
   SET normalized_email = NULL,
       needs_review     = true,
       review_reasons   = array_append(
         l.review_reasons,
         'Stored email was not a valid address and was removed as a merge identity; this record may combine more than one person'
       )
  FROM bad
 WHERE l.id = bad.id;
