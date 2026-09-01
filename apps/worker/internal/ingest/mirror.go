package ingest

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// BuildMirrorRows는 배치에서 건드린 유저들의 최종 PG 상태를 읽어 profiles_mirror 행을 만든다
// (PRD-02 3.1: ingest-consumer가 동일 마이크로배치에 미러 upsert 동봉).
// 디바이스 요약(push_reachable 구성 3필드·platforms)은 devices 집계로 산출한다.
func BuildMirrorRows(ctx context.Context, pg *pgxpool.Pool, userIDs []string, now time.Time) ([][]any, error) {
	if len(userIDs) == 0 {
		return nil, nil
	}
	rows, err := pg.Query(ctx, `
		SELECT
		  u.tenant_id, u.app_id, u.id,
		  COALESCE(u.external_id, ''),
		  u.std_attrs::text, u.custom_attrs::text,
		  COALESCE(u.subscriptions->>'push' = 'opted_in', false) AS opt_in,
		  COALESCE(bool_or(d.os_permission = 'granted'), false) AS os_granted,
		  COALESCE(bool_or(d.token_status = 'active' AND d.push_token IS NOT NULL), false) AS token_active,
		  COALESCE(array_agg(DISTINCT d.platform::text) FILTER (WHERE d.platform IS NOT NULL), '{}') AS platforms,
		  u.status::text
		FROM users u
		LEFT JOIN devices d ON d.user_id = u.id
		WHERE u.id = ANY($1)
		GROUP BY u.id`,
		userIDs)
	if err != nil {
		return nil, fmt.Errorf("미러 대상 조회: %w", err)
	}
	defer rows.Close()

	var out [][]any
	for rows.Next() {
		var (
			tenantID, appID, userID, externalID string
			stdAttrs, customAttrs, status       string
			optIn, osGranted, tokenActive       bool
			platforms                           []string
		)
		if err := rows.Scan(&tenantID, &appID, &userID, &externalID,
			&stdAttrs, &customAttrs, &optIn, &osGranted, &tokenActive, &platforms, &status); err != nil {
			return nil, err
		}
		out = append(out, []any{
			tenantID, appID, userID, externalID, stdAttrs, customAttrs,
			b2u8(optIn), b2u8(osGranted), b2u8(tokenActive), platforms, status, now,
		})
	}
	return out, rows.Err()
}

// BuildMergeMirrorRows는 이번 배치가 건드린 canonical(to_user_id) 사용자로 향하는
// 병합 간선을 PG user_merges에서 읽어 CH user_merges 미러 행을 만든다 (R-10, G-9).
// 병합이 발생한 배치에서 finalID(=to_user_id)가 affected에 포함되므로, 신규 간선과
// 경로 압축으로 재지정된 기존 간선이 모두 이 조회에 잡힌다. merged_at은 PG 값을 그대로
// 미러링해 CH argMax(to_user_id, merged_at)가 from별 최신 간선을 채택하게 한다.
func BuildMergeMirrorRows(ctx context.Context, pg *pgxpool.Pool, userIDs []string) ([][]any, error) {
	if len(userIDs) == 0 {
		return nil, nil
	}
	rows, err := pg.Query(ctx, `
		SELECT tenant_id, app_id, from_user_id, to_user_id, merged_at
		FROM user_merges WHERE to_user_id = ANY($1)`, userIDs)
	if err != nil {
		return nil, fmt.Errorf("병합 미러 대상 조회: %w", err)
	}
	defer rows.Close()

	var out [][]any
	for rows.Next() {
		var tenantID, appID, fromID, toID string
		var mergedAt time.Time
		if err := rows.Scan(&tenantID, &appID, &fromID, &toID, &mergedAt); err != nil {
			return nil, err
		}
		out = append(out, []any{tenantID, appID, fromID, toID, mergedAt})
	}
	return out, rows.Err()
}

func b2u8(b bool) uint8 {
	if b {
		return 1
	}
	return 0
}
