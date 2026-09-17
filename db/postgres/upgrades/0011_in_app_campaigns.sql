-- Campaigns use installation credentials independent of test pairing and user identity.
CREATE TABLE IF NOT EXISTS in_app_reviews (
 tenant_id uuid NOT NULL, app_id uuid NOT NULL, revision_id uuid NOT NULL, platform text NOT NULL CHECK(platform IN ('ios','android')),
 run_id uuid NOT NULL, passed boolean NOT NULL, reviewed_by uuid NOT NULL, reviewed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,app_id,revision_id,platform),
 FOREIGN KEY(tenant_id,app_id,revision_id) REFERENCES in_app_revisions(tenant_id,app_id,id),
 FOREIGN KEY(tenant_id,app_id,run_id) REFERENCES in_app_test_runs(tenant_id,app_id,id)
);
CREATE TABLE IF NOT EXISTS in_app_campaigns (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, app_id uuid NOT NULL, name text NOT NULL,
 revision_id uuid NOT NULL, config jsonb NOT NULL, version integer NOT NULL DEFAULT 1,
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','published','paused')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,app_id,id),
 FOREIGN KEY(tenant_id,app_id,revision_id) REFERENCES in_app_revisions(tenant_id,app_id,id)
);
CREATE TABLE IF NOT EXISTS in_app_publications (
 tenant_id uuid NOT NULL, app_id uuid NOT NULL, campaign_id uuid NOT NULL, version integer NOT NULL,
 revision_id uuid NOT NULL, config jsonb NOT NULL, published_by uuid NOT NULL, published_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,app_id,campaign_id,version),
 FOREIGN KEY(tenant_id,app_id,campaign_id) REFERENCES in_app_campaigns(tenant_id,app_id,id),
 FOREIGN KEY(tenant_id,app_id,revision_id) REFERENCES in_app_revisions(tenant_id,app_id,id)
);
CREATE TABLE IF NOT EXISTS in_app_installations (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), app_id uuid NOT NULL REFERENCES apps(id),
 credential_hash text NOT NULL, platform text NOT NULL CHECK(platform IN ('ios','android')),
 revoked boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,app_id,id)
);
CREATE TABLE IF NOT EXISTS in_app_deliveries (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, app_id uuid NOT NULL, installation_id uuid NOT NULL,
 campaign_id uuid NOT NULL, version integer NOT NULL, revision_id uuid NOT NULL,
 request_key uuid NOT NULL, session_id uuid NOT NULL, trigger jsonb NOT NULL,
 state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','authorized','presented','completed','failed','cancelled','expired')),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '30 seconds', authorized_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,app_id,id), UNIQUE(tenant_id,app_id,installation_id,request_key),
 FOREIGN KEY(tenant_id,app_id,installation_id) REFERENCES in_app_installations(tenant_id,app_id,id),
 FOREIGN KEY(tenant_id,app_id,campaign_id,version) REFERENCES in_app_publications(tenant_id,app_id,campaign_id,version),
 FOREIGN KEY(tenant_id,app_id,revision_id) REFERENCES in_app_revisions(tenant_id,app_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS in_app_deliveries_active ON in_app_deliveries(tenant_id,app_id,installation_id) WHERE state IN ('reserved','authorized','presented');
CREATE INDEX IF NOT EXISTS in_app_deliveries_frequency ON in_app_deliveries(tenant_id,app_id,installation_id,campaign_id,authorized_at);
CREATE TABLE IF NOT EXISTS in_app_delivery_events (
 tenant_id uuid NOT NULL, app_id uuid NOT NULL, delivery_id uuid NOT NULL, event_id uuid NOT NULL,
 kind text NOT NULL, detail text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,app_id,delivery_id,event_id),
 FOREIGN KEY(tenant_id,app_id,delivery_id) REFERENCES in_app_deliveries(tenant_id,app_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS in_app_delivery_events_once ON in_app_delivery_events(tenant_id,app_id,delivery_id,kind) WHERE kind IN ('presented','impression','hide_today');
CREATE TABLE IF NOT EXISTS in_app_suppressions (
 tenant_id uuid NOT NULL, app_id uuid NOT NULL, installation_id uuid NOT NULL, campaign_id uuid NOT NULL, until_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,app_id,installation_id,campaign_id),
 FOREIGN KEY(tenant_id,app_id,installation_id) REFERENCES in_app_installations(tenant_id,app_id,id),
 FOREIGN KEY(tenant_id,app_id,campaign_id) REFERENCES in_app_campaigns(tenant_id,app_id,id)
);
