-- Replace "is_active" with an 'inactive' connection status: one column says
-- whether a connection is in use and whether it works.
--   active   = in use, working
--   error    = in use, the provider rejects it (reconnect needed)
--   inactive = saved, not in use

-- The enum is rebuilt rather than extended: ALTER TYPE ... ADD VALUE cannot
-- be used in the same transaction that adds it.
CREATE TYPE "calendar_connection_status_new" AS ENUM ('active', 'inactive', 'error');

ALTER TABLE "calendar_connections" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "calendar_connections"
    ALTER COLUMN "status" TYPE "calendar_connection_status_new"
    USING (CASE WHEN "is_active" THEN "status"::text ELSE 'inactive' END)::"calendar_connection_status_new";
ALTER TABLE "calendar_connections" ALTER COLUMN "status" SET DEFAULT 'active';

DROP TYPE "calendar_connection_status";
ALTER TYPE "calendar_connection_status_new" RENAME TO "calendar_connection_status";

-- Should an organization somehow have two connections in use, keep the most
-- recently connected one.
UPDATE "calendar_connections" AS c
SET "status" = 'inactive'
FROM (
    SELECT "id",
           ROW_NUMBER() OVER (PARTITION BY "organization_id" ORDER BY "connected_at" DESC, "id" DESC) AS "rank"
    FROM "calendar_connections"
    WHERE "status" <> 'inactive'
) AS ranked
WHERE c."id" = ranked."id" AND ranked."rank" > 1;

-- A connection that is not in use receives no webhooks: forget its
-- registration so it is registered afresh if the organization switches back.
UPDATE "calendar_connections"
SET "webhook_id" = NULL, "webhook_secret" = NULL, "webhook_attempt_at" = NULL
WHERE "status" = 'inactive';

DROP INDEX IF EXISTS "calendar_connections_is_active_status_synced_at_idx";
ALTER TABLE "calendar_connections" DROP COLUMN "is_active";
CREATE INDEX "calendar_connections_status_synced_at_idx" ON "calendar_connections"("status", "synced_at");
