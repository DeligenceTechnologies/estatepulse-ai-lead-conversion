-- assistant.use: who may use Ask EstatePulse. Until now every signed-in user could, so every
-- existing role keeps it. The Owner system role holds every permission without a list.
UPDATE "roles"
SET "permissions" = array_append("permissions", 'assistant.use'), "updated_at" = now()
WHERE "is_system" = false AND NOT ('assistant.use' = ANY("permissions"));
