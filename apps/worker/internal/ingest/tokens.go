package ingest

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// ProcessToken은 푸시 토큰 등록/갱신을 처리한다 (PRD-01 7.2, PRD-04 4.4).
// UNIQUE(app_id, push_token) 원칙: 동일 토큰을 다른 디바이스가 등록하면 소유가 이전된다
// (재설치 → 새 device_id + 기존 토큰 → 자연 회복 경로).
func ProcessToken(
	ctx context.Context,
	q Querier,
	tenantID, appID, userID string,
	device *DeviceInfo,
	token *TokenPayload,
	now time.Time,
) error {
	// 1) 동일 토큰을 쥔 다른 디바이스에서 회수
	if _, err := q.Exec(ctx, `
		UPDATE devices SET push_token = NULL, token_status = 'expired', updated_at = now()
		 WHERE app_id = $1 AND push_token = $2 AND id <> $3`,
		appID, token.PushToken, device.DeviceID); err != nil {
		return fmt.Errorf("토큰 소유 이전: %w", err)
	}

	osPerm := token.OSPermission
	if osPerm == "" {
		osPerm = "undetermined"
	}
	meta, _ := json.Marshal(map[string]string{
		"app_version": device.AppVersion, "os_version": device.OSVersion,
		"model": device.Model, "locale": device.Locale,
	})

	// 2) 대상 디바이스 upsert — 토큰 active
	if _, err := q.Exec(ctx, `
		INSERT INTO devices (id, tenant_id, app_id, user_id, platform, push_token,
		                     token_status, os_permission, device_meta, last_active_at)
		VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $9)
		ON CONFLICT (id) DO UPDATE SET
		  user_id = EXCLUDED.user_id,
		  push_token = EXCLUDED.push_token,
		  token_status = 'active',
		  os_permission = EXCLUDED.os_permission,
		  device_meta = EXCLUDED.device_meta,
		  last_active_at = EXCLUDED.last_active_at,
		  updated_at = now()`,
		device.DeviceID, tenantID, appID, userID, device.Platform,
		token.PushToken, osPerm, meta, now); err != nil {
		return fmt.Errorf("디바이스 토큰 upsert: %w", err)
	}
	return nil
}
