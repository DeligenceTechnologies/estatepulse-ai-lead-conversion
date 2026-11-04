-- CALL01: outreach follows each lead's own clock.
-- The zone a lead source provided or an agent set; null = worked out from the phone number on every read.
ALTER TABLE "leads" ADD COLUMN "timezone" VARCHAR(100);

-- New organizations and users start in North America. Existing rows are not touched.
ALTER TABLE "org_settings" ALTER COLUMN "timezone" SET DEFAULT 'America/New_York';
ALTER TABLE "users" ALTER COLUMN "timezone" SET DEFAULT 'America/New_York';
