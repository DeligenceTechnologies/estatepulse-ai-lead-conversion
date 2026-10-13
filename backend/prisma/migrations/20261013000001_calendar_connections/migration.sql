-- CreateEnum
CREATE TYPE "calendar_provider" AS ENUM ('calendly', 'cal');

-- CreateEnum
CREATE TYPE "calendar_connection_status" AS ENUM ('active', 'error');

-- CreateEnum
CREATE TYPE "calendar_workspace_type" AS ENUM ('organization', 'team', 'personal');

-- CreateTable: one row per organization and provider; is_active marks the one in use.
CREATE TABLE "calendar_connections" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "provider" "calendar_provider" NOT NULL,
    "status" "calendar_connection_status" NOT NULL DEFAULT 'active',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "account_id" VARCHAR(255) NOT NULL,
    "account_email" VARCHAR(255),
    "account_name" VARCHAR(255),
    "workspace_type" "calendar_workspace_type" NOT NULL,
    "workspace_id" VARCHAR(255) NOT NULL,
    "workspace_name" VARCHAR(255),
    "workspace_slug" VARCHAR(255),
    "workspace_role" VARCHAR(50),
    "credentials" TEXT NOT NULL,
    "token_expires_at" TIMESTAMPTZ(6),
    "last_error" VARCHAR(500),
    "connected_by_id" UUID,
    "connected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "calendar_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "calendar_connections_organization_id_provider_key" ON "calendar_connections"("organization_id", "provider");

-- AddForeignKey
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_connected_by_id_fkey" FOREIGN KEY ("connected_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
