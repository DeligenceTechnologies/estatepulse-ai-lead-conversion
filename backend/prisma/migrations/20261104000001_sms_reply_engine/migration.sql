-- Who writes the AI's text replies. 'telnyx': the assistant linked to the messaging profile answers
-- every text itself (as before). 'estatepulse': this server decides per text whether the AI answers,
-- builds its prompt and runs its tools, and sends the reply. Every organization starts on 'telnyx'.
ALTER TABLE "org_settings" ADD COLUMN "sms_reply_engine" VARCHAR(20) NOT NULL DEFAULT 'telnyx';
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_sms_reply_engine_check" CHECK ("sms_reply_engine" IN ('telnyx', 'estatepulse'));
