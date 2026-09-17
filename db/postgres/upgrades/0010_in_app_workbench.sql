-- In-app workbench: immutable assets and explicitly paired test devices; no production delivery.
CREATE TABLE IF NOT EXISTS in_app_revisions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name text NOT NULL,
  source_bytes bigint NOT NULL CHECK (source_bytes > 0),
  artifact_sha256 text NOT NULL,
  manifest jsonb NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, app_id, id)
);
CREATE INDEX IF NOT EXISTS in_app_revisions_recent ON in_app_revisions(tenant_id,app_id,created_at DESC);
CREATE TABLE IF NOT EXISTS in_app_test_devices (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  pairing_hash text NOT NULL,
  credential_hash text,
  confirmation_code text NOT NULL,
  state text NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting','claimed','active','revoked')),
  label text,
  platform text CHECK (platform IN ('ios','android')),
  sdk_version text,
  created_by uuid,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '5 minutes',
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,app_id,id)
);
CREATE TABLE IF NOT EXISTS in_app_test_runs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  revision_id uuid NOT NULL,
  device_id uuid NOT NULL,
  request_key uuid NOT NULL,
  retry_of uuid,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','preparing','presented','completed','failed','cancelled','expired')),
  error_code text,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '2 minutes',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,app_id,request_key),
  UNIQUE (tenant_id,app_id,id),
  FOREIGN KEY (tenant_id,app_id,revision_id) REFERENCES in_app_revisions(tenant_id,app_id,id),
  FOREIGN KEY (tenant_id,app_id,device_id) REFERENCES in_app_test_devices(tenant_id,app_id,id),
  FOREIGN KEY (tenant_id,app_id,retry_of) REFERENCES in_app_test_runs(tenant_id,app_id,id)
);
CREATE INDEX IF NOT EXISTS in_app_test_runs_device ON in_app_test_runs(tenant_id,app_id,device_id,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS in_app_test_runs_one_active ON in_app_test_runs(tenant_id,app_id,device_id)
  WHERE state IN ('queued','preparing','presented');
CREATE TABLE IF NOT EXISTS in_app_test_events (
  tenant_id uuid NOT NULL,
  app_id uuid NOT NULL,
  run_id uuid NOT NULL,
  event_id uuid NOT NULL,
  kind text NOT NULL,
  detail text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,app_id,run_id,event_id),
  FOREIGN KEY (tenant_id,app_id,run_id) REFERENCES in_app_test_runs(tenant_id,app_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS in_app_test_events_once
 ON in_app_test_events(tenant_id,app_id,run_id,kind)
 WHERE kind IN ('presented','impression');
