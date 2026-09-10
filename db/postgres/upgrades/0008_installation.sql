-- Slice B — 설치 소유권 claim과 최초 Owner 원자 생성 (docs-public/DOCKER-SETUP-WIZARD-PRD.md 8.1).
-- 설치당 정확히 한 행. count(members)가 아니라 이 행의 state가 설치 잠금의 권위다.
CREATE TABLE IF NOT EXISTS installation (
  singleton                boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  installation_id          uuid NOT NULL DEFAULT gen_random_uuid(),
  state                    text NOT NULL DEFAULT 'unclaimed'
                           CHECK (state IN ('unclaimed', 'claimed', 'secured', 'recovery_required')),
  setup_token_hash         text,                -- sha256(raw). raw는 저장하지 않는다
  setup_token_version      integer NOT NULL DEFAULT 0,
  claim_session_hash       text,                -- sha256(bootstrap cookie) — lease를 실제 cookie holder에 결박
  claim_expires_at         timestamptz,
  claimed_at               timestamptz,
  secured_at               timestamptz,
  tenant_id                uuid,
  owner_id                 uuid,
  app_id                   uuid,
  setup_idempotency_key_hash text,              -- commit 뒤 응답 유실 시 exact replay
  setup_request_hash       text,
  setup_result             jsonb,               -- 키 원문은 넣지 않는다 (Owner가 인증된 회전 경로로 복구)
  record_version           bigint NOT NULL DEFAULT 1,
  installed_version        text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (state <> 'claimed' OR (claim_session_hash IS NOT NULL AND claim_expires_at IS NOT NULL)),
  CHECK (state <> 'secured' OR (tenant_id IS NOT NULL AND owner_id IS NOT NULL AND app_id IS NOT NULL AND setup_token_hash IS NULL))
);
