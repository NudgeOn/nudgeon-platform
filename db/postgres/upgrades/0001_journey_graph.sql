-- Applied before the declarative bootstrap schema for existing installations.
-- Fresh databases do not have journey_states yet; schema.sql creates all fields.
ALTER TABLE IF EXISTS journey_states ADD COLUMN IF NOT EXISTS claim_token uuid;
ALTER TABLE IF EXISTS journey_states ADD COLUMN IF NOT EXISTS entry_id text;
ALTER TABLE IF EXISTS journey_states ADD COLUMN IF NOT EXISTS entry_seq bigint;
