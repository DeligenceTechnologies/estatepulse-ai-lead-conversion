-- Every lead is cold until an AI call says otherwise.
--
-- Temperature was NULL on manual, Google Sheets and file-import leads and
-- 'cold' only on webhook leads (worker.service), so the Leads table showed
-- "Not classified" for some sources and "Cold" for others. The AI call still
-- rewrites it (lead-scoring.service); nothing auto-enrols on this default,
-- because enrolment is driven by the `qualified_*` event, not by the column.
--
-- The column stays nullable: nothing writes NULL today, and tightening it
-- would only churn the `string | null` types that read it.
ALTER TABLE leads ALTER COLUMN temperature SET DEFAULT 'cold';

UPDATE leads SET temperature = 'cold' WHERE temperature IS NULL;
