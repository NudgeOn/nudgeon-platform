-- Separate OAuth grants: ingestion keys never gain management permissions.
CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  redirect_uris text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mcp_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES mcp_oauth_clients(id),
  scopes text[] NOT NULL,
  customer_access_approved boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS mcp_connections_member ON mcp_connections(tenant_id,member_id,app_id);
CREATE TABLE IF NOT EXISTS mcp_oauth_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES mcp_oauth_clients(id),
  redirect_uri text NOT NULL,
  state text NOT NULL,
  challenge text NOT NULL,
  scopes text[] NOT NULL,
  resource text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes',
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id uuid REFERENCES mcp_connections(id) ON DELETE CASCADE,
  code_hash text UNIQUE,
  code_expires_at timestamptz,
  consumed_at timestamptz,
  decided_at timestamptz
);
CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
  token_hash text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('access','refresh')),
  scopes text[] NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mcp_oauth_tokens_connection ON mcp_oauth_tokens(tenant_id,connection_id);
