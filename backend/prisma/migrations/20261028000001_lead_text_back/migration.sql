-- When a lead asked to be texted later ("message me in 10 minutes"). Until then nothing else
-- contacts them; it is cleared if that text is cancelled or dropped, and kept once it is sent.
ALTER TABLE "leads" ADD COLUMN "text_back_at" TIMESTAMPTZ(6);
