-- Custom webhook sources (lead_sources.provider = 'CUSTOM'): how an inbound
-- delivery proves itself (auth mode, header, algorithm, encoding, basic-auth
-- username) and which header carries the sender's delivery id. The secret itself
-- stays in signing_secret_enc, encrypted like every other secret. NULL on every
-- other source. Additive: no existing row, default or constraint changes.
ALTER TABLE lead_sources ADD COLUMN IF NOT EXISTS custom_config JSONB;
