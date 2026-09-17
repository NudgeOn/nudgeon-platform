-- Durable test-push requests. The same request key owns one run and one set of outbox jobs.
CREATE TABLE IF NOT EXISTS test_push_runs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  request_key uuid NOT NULL,
  request_hash text NOT NULL,
  messages jsonb NOT NULL CHECK (jsonb_typeof(messages) = 'array'),
  outbox_ids bigint[] NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, app_id, request_key)
);
CREATE INDEX IF NOT EXISTS test_push_runs_recent_idx
  ON test_push_runs (tenant_id, app_id, accepted_at DESC);
