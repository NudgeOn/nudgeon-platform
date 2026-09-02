-- Frozen pre-graph fixture from 28bc11329a8e84f4e1334d4e8409426faba5db75.
-- Keep the original shape so tests cannot accidentally bootstrap v2 as v1.
-- NudgeOn — PostgreSQL 선언적 스키마 (Atlas 단일 출처)
-- 원칙: PG = 현재 상태(current state)만. append-only 수집 기록은 ClickHouse (PRD-01 5.2).
-- 격리: 모든 테넌트 데이터 테이블은 tenant_id 컬럼 + 애플리케이션 레벨 강제 (PRD-06 4장).

-- ---------------------------------------------------------------------------
-- ENUM 타입
-- ---------------------------------------------------------------------------
CREATE TYPE member_role AS ENUM ('owner', 'admin', 'editor', 'viewer');
CREATE TYPE member_status AS ENUM ('active', 'invited', 'disabled');
CREATE TYPE api_key_kind AS ENUM ('sdk', 'server');
CREATE TYPE api_key_scope AS ENUM ('full', 'ingest_only');
CREATE TYPE api_key_status AS ENUM ('active', 'rotating', 'revoked');
CREATE TYPE user_status AS ENUM ('active', 'merged', 'deleted');
CREATE TYPE device_platform AS ENUM ('ios', 'android');
CREATE TYPE token_status AS ENUM ('active', 'invalid', 'expired');
CREATE TYPE os_permission AS ENUM ('granted', 'denied', 'undetermined');
CREATE TYPE attr_type AS ENUM ('string', 'number', 'boolean', 'datetime', 'string_array');
CREATE TYPE channel_kind AS ENUM ('push_fcm', 'push_apns');  -- v1.5: alimtalk, sms, email
CREATE TYPE credential_status AS ENUM ('unverified', 'verified', 'error');

-- ---------------------------------------------------------------------------
-- 테넌트 · 계정 (DEV-sub-07)
-- ---------------------------------------------------------------------------
CREATE TABLE tenants (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  -- 삭제 플로우: 요청 → 7일 유예(복구 가능) → 파기 (PRD-06 6장)
  delete_requested_at timestamptz,
  purge_after  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE members (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  email         text NOT NULL,
  password_hash text,                        -- Argon2id. OAuth 전용 계정은 NULL
  name          text NOT NULL DEFAULT '',
  role          member_role NOT NULL DEFAULT 'viewer',
  status        member_status NOT NULL DEFAULT 'invited',
  -- TOTP 2FA (PRD-06 2.1) — S4에서 활성화, 스키마는 선행 확정
  totp_secret_enc     bytea,                 -- KMS 암호화
  totp_enabled_at     timestamptz,
  totp_last_counter   bigint,                -- 코드 재사용 방지
  totp_failed_count   int NOT NULL DEFAULT 0,
  totp_locked_until   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);
CREATE UNIQUE INDEX members_email_login_idx ON members (lower(email));

-- 백업 코드: 활성화 시 10개 발급, 해시 저장, 1회 사용 (PRD-06 2.1)
CREATE TABLE member_backup_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  member_id  uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  code_hash  text NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX member_backup_codes_member_idx ON member_backup_codes (member_id);

-- DB 세션 + Redis 캐시 (ADR-8). 토큰 원문은 저장하지 않고 해시만.
CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  member_id    uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,         -- SHA-256(세션 토큰)
  ip           inet,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE INDEX sessions_member_idx ON sessions (member_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- 앱 · API 키 (PRD-06 3장)
-- ---------------------------------------------------------------------------
CREATE TABLE apps (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  name       text NOT NULL,
  timezone   text NOT NULL DEFAULT 'Asia/Seoul',   -- quiet hours 기준 시간대 (PRD-03 6.1)
  -- 발송 정책 (PRD-03 6장). quiet_hours: {enabled, start "HH:MM", end "HH:MM", policy "delay_until_open"|"skip"}
  quiet_hours    jsonb NOT NULL DEFAULT '{"enabled": false, "start": "21:00", "end": "08:00", "policy": "delay_until_open"}',
  -- frequency_cap: {enabled, max_per_24h}
  frequency_cap  jsonb NOT NULL DEFAULT '{"enabled": false, "max_per_24h": 3}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  app_id        uuid NOT NULL REFERENCES apps(id),
  kind          api_key_kind NOT NULL,
  scope         api_key_scope NOT NULL DEFAULT 'full',  -- server 키만 의미 있음. sdk는 항상 쓰기 전용
  prefix        text NOT NULL,               -- 'pk_' | 'sk_' + 앞 8자 (콘솔 표시용)
  key_hash      text NOT NULL UNIQUE,        -- SHA-256(키 원문)
  status        api_key_status NOT NULL DEFAULT 'active',
  -- SDK 키 회전: 구키는 status=rotating + grace_expires_at까지 병행 유효 (30일, PRD-06 3장)
  grace_expires_at timestamptz,
  last_used_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz
);
CREATE INDEX api_keys_app_idx ON api_keys (app_id, kind, status);

-- ---------------------------------------------------------------------------
-- 발송 크리덴셜 (PRD-04 3장, DEV-sub-04)
-- 봉투 암호화: ciphertext = AES-256-GCM(DEK, payload JSON),
--              dek_wrapped = AES-256-GCM(마스터키, DEK). 마스터키는 KMS/로컬 파일.
-- 복호화는 발송 워커 런타임에서만. 콘솔·API 응답은 항상 마스킹.
-- ---------------------------------------------------------------------------
CREATE TABLE credentials (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  app_id           uuid NOT NULL REFERENCES apps(id),
  kind             channel_kind NOT NULL,
  ciphertext       bytea NOT NULL,
  dek_wrapped      bytea NOT NULL,
  status           credential_status NOT NULL DEFAULT 'unverified',
  status_detail    text,                     -- 검증 실패 사유 (콘솔 구체 표시 — U-2)
  last_verified_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, kind)                      -- 앱당 채널 크리덴셜 1개 (교체 = upsert)
);

-- ---------------------------------------------------------------------------
-- 유저 · 디바이스 (PRD-01 5.1)
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  app_id        uuid NOT NULL REFERENCES apps(id),
  external_id   text,
  anon_id       uuid,
  status        user_status NOT NULL DEFAULT 'active',
  merged_into   uuid REFERENCES users(id),   -- tombstone → 승계 프로필
  std_attrs     jsonb NOT NULL DEFAULT '{}',
  custom_attrs  jsonb NOT NULL DEFAULT '{}',
  subscriptions jsonb NOT NULL DEFAULT '{}', -- {push: opted_in|unsubscribed, ...채널별}
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, external_id),
  UNIQUE (app_id, anon_id)
);
CREATE INDEX users_custom_attrs_idx ON users USING gin (custom_attrs);
CREATE INDEX users_app_status_idx ON users (app_id, status);

CREATE TABLE devices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  app_id         uuid NOT NULL REFERENCES apps(id),
  user_id        uuid NOT NULL REFERENCES users(id), -- 현재 귀속 유저 (재로그인 시 이관)
  platform       device_platform NOT NULL,
  push_token     text,
  token_status   token_status NOT NULL DEFAULT 'active',
  os_permission  os_permission NOT NULL DEFAULT 'undetermined',
  device_meta    jsonb NOT NULL DEFAULT '{}',   -- 모델, OS 버전, 앱 버전, locale
  last_active_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, push_token)                   -- 토큰 재등록 시 소유 이전 (PRD-04 4.4)
);
CREATE INDEX devices_user_idx ON devices (user_id);

-- ---------------------------------------------------------------------------
-- 속성 사전 · 병합 매핑 (DEV-sub-01)
-- ---------------------------------------------------------------------------
CREATE TABLE attribute_registry (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  app_id        uuid NOT NULL REFERENCES apps(id),
  key           text NOT NULL,
  type          attr_type NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  seg_ref_count int NOT NULL DEFAULT 0,          -- 참조 중 세그먼트 수 (삭제 확인용, PRD-02 6장)
  PRIMARY KEY (app_id, key)
);

-- ---------------------------------------------------------------------------
-- 세그먼트 (PRD-02) — 정의(DSL)는 jsonb, 멤버십은 저장하지 않음(발송 시 스냅샷)
-- ---------------------------------------------------------------------------
CREATE TYPE segment_status AS ENUM ('active', 'broken');
CREATE TYPE journey_status AS ENUM ('draft', 'active', 'paused', 'archived');
CREATE TYPE journey_state_status AS ENUM ('active', 'waiting', 'claimed', 'completed', 'exited', 'failed');
CREATE TYPE message_category AS ENUM ('marketing', 'transactional');

CREATE TABLE segments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  app_id       uuid NOT NULL REFERENCES apps(id),
  name         text NOT NULL,
  definition   jsonb NOT NULL,              -- DSL (PRD-02 2.1)
  status       segment_status NOT NULL DEFAULT 'active',
  status_detail text,                        -- broken 사유 (삭제된 속성 참조 등)
  last_count       int,                      -- 최근 정기 평가 카운트 (통계용)
  last_evaluated_at timestamptz,
  created_by   uuid REFERENCES members(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, name)
);
CREATE INDEX segments_app_idx ON segments (app_id, status);

-- ---------------------------------------------------------------------------
-- 오케스트레이션 (PRD-03) — 단발 캠페인 = 1노드 저니로 통합 모델링
-- ---------------------------------------------------------------------------
CREATE TABLE journeys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  app_id       uuid NOT NULL REFERENCES apps(id),
  name         text NOT NULL,
  status       journey_status NOT NULL DEFAULT 'draft',
  category     message_category NOT NULL DEFAULT 'marketing',
  -- 편집 중(draft) 정의. 활성화 시 journey_versions로 불변 스냅샷 (2.2)
  draft_definition jsonb NOT NULL DEFAULT '{}',
  active_version   int,               -- 현재 활성 버전 (journey_versions.version)
  created_by   uuid REFERENCES members(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, name)
);

-- 활성화 시점마다 증가하는 불변 버전 스냅샷 (진행 중 유저는 진입 버전으로 완주 — 2.2)
CREATE TABLE journey_versions (
  journey_id   uuid NOT NULL REFERENCES journeys(id),
  version      int NOT NULL,
  definition   jsonb NOT NULL,        -- 불변
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (journey_id, version)
);

CREATE TABLE journey_states (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  app_id         uuid NOT NULL REFERENCES apps(id),
  journey_id     uuid NOT NULL,
  journey_version int NOT NULL,
  user_id        uuid NOT NULL,
  current_node   int NOT NULL DEFAULT 0,
  status         journey_state_status NOT NULL DEFAULT 'active',
  next_wake_at   timestamptz,         -- delay 노드 기상 시각 (즉시 실행이면 NULL/과거)
  claimed_by     text,
  claimed_at     timestamptz,
  fail_reason    text,
  entered_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
-- 동일 유저는 동일 저니에 동시 1개 인스턴스만 (진행 중 = active|waiting|claimed)
CREATE UNIQUE INDEX journey_states_active_uniq
  ON journey_states (journey_id, user_id)
  WHERE status IN ('active', 'waiting', 'claimed');
-- 스케줄러 클레임 인덱스: 기상 시각 도래한 대기 상태
CREATE INDEX journey_states_wake_idx
  ON journey_states (next_wake_at)
  WHERE status IN ('active', 'waiting');

-- outbox: 상태 전이와 발송 잡 발행의 원자성 (4.3 정확히-한-번의 구현체)
CREATE TABLE journey_outbox (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  app_id       uuid NOT NULL,
  stream       text NOT NULL,         -- 발행 대상 스트림 (send.push 등)
  idempotency_key text NOT NULL,      -- (journey_id, version, user_id, node_index, device_id)
  payload      jsonb NOT NULL,        -- envelope payload
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX journey_outbox_unpublished_idx
  ON journey_outbox (id) WHERE published_at IS NULL;

CREATE TABLE user_merges (
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  app_id       uuid NOT NULL REFERENCES apps(id),
  from_user_id uuid PRIMARY KEY,               -- anon(tombstone) 프로필
  to_user_id   uuid NOT NULL REFERENCES users(id),
  merged_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_merges_to_idx ON user_merges (to_user_id);
