-- AlterTable: a user may have no phone number.
ALTER TABLE "users" ALTER COLUMN "phone" DROP NOT NULL;
