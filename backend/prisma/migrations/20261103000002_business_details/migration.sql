-- Who the organization is in its texts: legal name, mailing address, email and website. Canada's
-- anti-spam law (CASL) wants the sender identified in every commercial text; the address goes in
-- the HELP answer. Unset is all empty.
ALTER TABLE "org_settings" ADD COLUMN "business_details" JSONB;
