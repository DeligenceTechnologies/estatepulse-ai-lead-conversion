-- Phones that asked not to be contacted, per organization. Do-not-contact belongs to the number, not one
-- lead record: a person who filled in two forms is two leads with one phone, and an opt-out from either
-- must reach both. START by text deletes the row.
CREATE TABLE "contact_suppressions" (
    "organization_id" UUID NOT NULL,
    "normalized_phone" VARCHAR(50) NOT NULL,
    "source" VARCHAR(30) NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_suppressions_pkey" PRIMARY KEY ("organization_id","normalized_phone")
);

-- AddForeignKey
ALTER TABLE "contact_suppressions" ADD CONSTRAINT "contact_suppressions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Every phone already on a do-not-contact lead.
INSERT INTO "contact_suppressions" ("organization_id", "normalized_phone", "source", "reason", "created_at")
SELECT "organization_id", "normalized_phone", 'backfill', 'A lead with this phone was do-not-contact', min("updated_at")
  FROM "leads"
 WHERE "dnc_status" = true AND "normalized_phone" IS NOT NULL
 GROUP BY "organization_id", "normalized_phone";

-- And every other lead with such a phone becomes do-not-contact too, logged per lead. Their sequences
-- stop on the runner's next look, which skips a do-not-contact lead.
WITH optedOut AS (
  UPDATE "leads" AS l
     SET "dnc_status" = true, "automation_paused" = true, "consent_status" = 'revoked', "updated_at" = now()
    FROM "contact_suppressions" AS s
   WHERE s."organization_id" = l."organization_id"
     AND s."normalized_phone" = l."normalized_phone"
     AND l."dnc_status" = false
  RETURNING l."id", l."organization_id"
)
INSERT INTO "lead_events" ("id", "organization_id", "lead_id", "type", "reason", "source", "actor_type")
SELECT gen_random_uuid(), "organization_id", "id", 'opted_out',
       'Backfill: another lead with this phone had asked not to be contacted', 'migration', 'system'
  FROM optedOut;
