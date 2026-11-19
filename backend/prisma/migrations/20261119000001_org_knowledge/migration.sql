-- The business facts the AI answers a lead's questions from: areas served, commission, lender
-- partners, common objections. A list of { title, body } pairs, interpolated into the assistant's
-- instructions as a managed section, so the same facts serve calls and text chats alike.
--
-- NULL means the organization has entered none, and the AI answers nothing from them. The caps on
-- how many entries and how long each one may be live in src/telnyx/knowledge.ts, not in a CHECK
-- constraint: Prisma cannot express a CHECK, so one added here would drift out of the repo.
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "knowledge" JSONB;
