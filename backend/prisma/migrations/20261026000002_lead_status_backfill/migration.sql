-- Moves existing leads onto the statuses added by the previous migration, and
-- logs each move in lead_events so the change is traceable per lead.

-- A follow-up sequence used to close out a lead that never answered as
-- "not_interested"; that lead is unresponsive. Opted-out leads stay as they are.
WITH moved AS (
  UPDATE "leads" SET "status" = 'unresponsive', "updated_at" = now()
   WHERE "status" = 'not_interested'
     AND "dnc_status" = false
     AND "lost_reason" = 'Follow-up sequence exhausted with no response'
  RETURNING "id", "organization_id"
)
INSERT INTO "lead_events" ("id", "organization_id", "lead_id", "type", "from_status", "to_status", "reason", "source", "actor_type")
SELECT gen_random_uuid(), "organization_id", "id", 'status_changed', 'not_interested', 'unresponsive',
       'Backfill: closed out by a follow-up sequence with no response', 'migration', 'system'
  FROM moved;

-- A lead that replied by SMS sat in "contacting" with automation paused; it is engaged.
WITH moved AS (
  UPDATE "leads" AS l SET "status" = 'engaged', "updated_at" = now()
   WHERE l."status" = 'contacting'
     AND l."automation_paused" = true
     AND l."dnc_status" = false
     AND EXISTS (SELECT 1 FROM "messages" AS m WHERE m."lead_id" = l."id" AND m."direction" = 'inbound')
  RETURNING l."id", l."organization_id"
)
INSERT INTO "lead_events" ("id", "organization_id", "lead_id", "type", "from_status", "to_status", "reason", "source", "actor_type")
SELECT gen_random_uuid(), "organization_id", "id", 'status_changed', 'contacting', 'engaged',
       'Backfill: replied by SMS', 'migration', 'system'
  FROM moved;
