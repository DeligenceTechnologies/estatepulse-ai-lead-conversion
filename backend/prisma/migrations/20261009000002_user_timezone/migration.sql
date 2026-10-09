-- AlterTable: existing users get the default.
ALTER TABLE "users" ADD COLUMN "timezone" VARCHAR(100) NOT NULL DEFAULT 'Asia/Kolkata';
