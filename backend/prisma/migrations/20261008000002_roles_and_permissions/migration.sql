-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(500),
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "roles_organization_id_name_key" ON "roles"("organization_id", "name");

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every organization gets the system Owner role, and an Agent role
-- with no permissions if it has agents. Existing users keep their old meaning.
INSERT INTO "roles" ("id", "organization_id", "name", "description", "is_system", "updated_at")
SELECT gen_random_uuid(), o."id", 'Owner', 'Full access to everything in the organization.', true, CURRENT_TIMESTAMP
FROM "organizations" o;

INSERT INTO "roles" ("id", "organization_id", "name", "is_system", "updated_at")
SELECT gen_random_uuid(), u."organization_id", 'Agent', false, CURRENT_TIMESTAMP
FROM "users" u
WHERE u."role" = 'agent'
GROUP BY u."organization_id";

ALTER TABLE "users" ADD COLUMN "role_id" UUID;

UPDATE "users" u
SET "role_id" = r."id"
FROM "roles" r
WHERE r."organization_id" = u."organization_id"
  AND r."name" = CASE u."role" WHEN 'owner' THEN 'Owner' ELSE 'Agent' END;

ALTER TABLE "users" ALTER COLUMN "role_id" SET NOT NULL;
ALTER TABLE "users" DROP COLUMN "role";

-- DropEnum
DROP TYPE "user_role";

-- CreateIndex
CREATE INDEX "users_role_id_idx" ON "users"("role_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
