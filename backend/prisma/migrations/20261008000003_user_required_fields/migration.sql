-- AlterTable
ALTER TABLE "organizations" DROP COLUMN "timezone";

-- Existing users created before these fields were required get an empty
-- value so the NOT NULL constraint can be added; fix them from the UI.
UPDATE "users" SET "first_name" = '' WHERE "first_name" IS NULL;
UPDATE "users" SET "last_name" = '' WHERE "last_name" IS NULL;
UPDATE "users" SET "phone" = '' WHERE "phone" IS NULL;

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "first_name" SET NOT NULL,
ALTER COLUMN "last_name" SET NOT NULL,
ALTER COLUMN "phone" SET NOT NULL;
