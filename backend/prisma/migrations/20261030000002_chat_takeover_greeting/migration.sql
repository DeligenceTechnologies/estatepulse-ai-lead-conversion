-- What is texted to a lead when an agent takes their chat over ({ enabled, message }); unset means on, with the default text.
ALTER TABLE "org_settings" ADD COLUMN "chat_takeover" JSONB;
