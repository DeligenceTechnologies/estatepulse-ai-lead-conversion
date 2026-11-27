-- Ask EstatePulse settings an owner sets for the office: on or off, a monthly limit, the microphone.
ALTER TABLE "org_settings" ADD COLUMN "assistant" JSONB;
