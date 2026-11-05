-- A Telnyx number belongs to one organization. Two organizations holding the same
-- active number makes inbound routing a coin toss: a lead's reply, STOP included,
-- can land in the wrong account and be dropped there.

-- Any such pair already on file: the newest claim keeps the number, the rest are
-- switched off. Nothing is deleted — the credentials stay for a later reconnect.
UPDATE "integrations" i
SET "status" = 'inactive'
WHERE i."provider" = 'telnyx'
  AND i."status" = 'active'
  AND i."phone_number" IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM "integrations" j
    WHERE j."provider" = 'telnyx'
      AND j."status" = 'active'
      AND j."phone_number" = i."phone_number"
      AND (j."updated_at", j."id") > (i."updated_at", i."id")
  );

CREATE UNIQUE INDEX "integrations_telnyx_number_active"
  ON "integrations" ("phone_number")
  WHERE "provider" = 'telnyx' AND "status" = 'active' AND "phone_number" IS NOT NULL;
