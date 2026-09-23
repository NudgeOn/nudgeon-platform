-- Drafts are deliberately separate from segments: the segment worker never sees them.
CREATE TABLE IF NOT EXISTS segment_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name text NOT NULL,
  definition jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by uuid REFERENCES members(id) ON DELETE SET NULL,
  -- Keep the original promotion identity even if the segment is later deleted.
  promoted_segment_id uuid,
  promoted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS segment_drafts_app_idx ON segment_drafts (tenant_id, app_id, updated_at DESC);

-- First successful draft create wins. Reusing a request ID with a different body is a conflict.
CREATE TABLE IF NOT EXISTS draft_create_requests (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  actor_member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('segment', 'journey')),
  request_id uuid NOT NULL,
  fingerprint text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, app_id, actor_member_id, kind, request_id)
);
