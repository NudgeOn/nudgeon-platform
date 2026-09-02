-- 이메일 채널: channel_kind에 email_resend(Resend API 발송기) 추가 (기존 DB 대상; 신규 DB는 schema.sql CREATE TYPE에 포함).
-- ADD VALUE는 트랜잭션 밖에서만 가능 — 마이그레이터는 문 단위 autocommit이라 안전.
ALTER TYPE channel_kind ADD VALUE IF NOT EXISTS 'email_resend';
