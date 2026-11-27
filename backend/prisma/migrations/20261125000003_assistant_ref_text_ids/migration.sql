-- A slot ref stands for a start time, not a uuid, so entity ids become text.
ALTER TABLE "assistant_refs" ALTER COLUMN "entity_id" SET DATA TYPE VARCHAR(100) USING "entity_id"::text;
