-- AlterTable
ALTER TABLE "user_sessions" ADD COLUMN     "ip_address" VARCHAR(64),
ADD COLUMN     "keep_signed_in" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "refresh_token_hash" VARCHAR(64) NOT NULL,
ADD COLUMN     "user_agent" VARCHAR(512);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "last_login_at" TIMESTAMPTZ(6),
ADD COLUMN     "password_changed_at" TIMESTAMPTZ(6);
