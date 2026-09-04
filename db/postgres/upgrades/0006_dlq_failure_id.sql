-- Add before deploying the new DLQ writers. Existing rows acquire a cycle ID
-- on their next new failure; no data rewrite or new index is required.
ALTER TABLE IF EXISTS send_dlq ADD COLUMN IF NOT EXISTS failure_id uuid;
