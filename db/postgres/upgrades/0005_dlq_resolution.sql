-- Existing installations run upgrades before schema.sql (including indexes).
-- Historical replayed rows stay unresolved until an operator verifies recovery.
ALTER TABLE IF EXISTS send_dlq ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
ALTER TABLE IF EXISTS send_dlq ADD COLUMN IF NOT EXISTS resolution_note text;
