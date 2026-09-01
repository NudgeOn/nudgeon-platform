package ingest

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ProcessIdentify는 identify 병합을 단일 트랜잭션으로 처리한다 (PRD-01 3.1/3.2).
//   - external 프로필 없음 + anon 있음 → 승격(promote)
//   - 둘 다 있음 → 병합: 속성 external 우선, 디바이스 이관, anon tombstone + user_merges
//   - 동시 identify 경합은 unique 제약 위반/데드락 → 재시도로 수렴 (D-4)
//
// 반환: 최종 user_id + 속성 적용 결과(CH 기록 행).
func ProcessIdentify(
	ctx context.Context,
	pool *pgxpool.Pool,
	tenantID, appID string,
	p *IdentifyPayload,
	requestID string,
	now time.Time,
) (string, *AttrResult, error) {
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		userID, res, err := identifyOnce(ctx, pool, tenantID, appID, p, requestID, now)
		if err == nil {
			return userID, res, nil
		}
		if !isRetryable(err) {
			return "", nil, err
		}
		lastErr = err
	}
	return "", nil, fmt.Errorf("identify 경합 재시도 소진: %w", lastErr)
}

func identifyOnce(
	ctx context.Context,
	pool *pgxpool.Pool,
	tenantID, appID string,
	p *IdentifyPayload,
	requestID string,
	now time.Time,
) (string, *AttrResult, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return "", nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Receipt acceptance and v2 execution lock cursors before profile rows.
	// Discover without locks, acquire both profiles in that order, then recheck
	// identity so a concurrent promotion/merge cannot leave us using stale IDs.
	profiles, err := lockIdentifyProfiles(ctx, tx, tenantID, appID, p)
	if err != nil {
		return "", nil, err
	}
	extID, anonID := profiles.external, profiles.anonymous
	hasExt, hasAnon := extID != "", anonID != ""

	var finalID string
	switch {
	case hasExt && hasAnon && extID != anonID:
		// 병합: 속성 external 우선(anon || ext), 디바이스 이관, tombstone (PRD-01 3.2)
		if _, err := tx.Exec(ctx, `
			UPDATE users ext SET
			  std_attrs    = anon.std_attrs || ext.std_attrs,
			  custom_attrs = anon.custom_attrs || ext.custom_attrs,
			  last_seen_at = GREATEST(ext.last_seen_at, anon.last_seen_at),
			  updated_at   = $5
			FROM users anon WHERE ext.id = $1 AND anon.id = $2
			  AND ext.tenant_id = $3 AND ext.app_id = $4
			  AND anon.tenant_id = $3 AND anon.app_id = $4`, extID, anonID, tenantID, appID, now); err != nil {
			return "", nil, fmt.Errorf("병합 속성: %w", err)
		}
		if _, err := tx.Exec(ctx,
			`UPDATE devices SET user_id = $1, updated_at = $5
			 WHERE user_id = $2 AND tenant_id = $3 AND app_id = $4`,
			extID, anonID, tenantID, appID, now); err != nil {
			return "", nil, fmt.Errorf("디바이스 이관: %w", err)
		}
		if _, err := tx.Exec(ctx,
			`UPDATE users SET status = 'merged', merged_into = $1, updated_at = $5
			 WHERE id = $2 AND tenant_id = $3 AND app_id = $4`,
			extID, anonID, tenantID, appID, now); err != nil {
			return "", nil, fmt.Errorf("tombstone: %w", err)
		}
		if err := exitMergedV2Journeys(ctx, tx, tenantID, appID, anonID, now); err != nil {
			return "", nil, err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO user_merges (tenant_id, app_id, from_user_id, to_user_id, merged_at)
			VALUES ($1, $2, $3, $4, $5) ON CONFLICT (from_user_id) DO NOTHING`,
			tenantID, appID, anonID, extID, now); err != nil {
			return "", nil, fmt.Errorf("user_merges: %w", err)
		}
		finalID = extID

	case hasExt:
		finalID = extID

	case hasAnon:
		// 승격: anon 프로필에 external_id 부여 — 경합으로 unique 위반 시 재시도가 병합 경로로 수렴
		if _, err := tx.Exec(ctx,
			`UPDATE users SET external_id = $1, last_seen_at = GREATEST(last_seen_at, $3), updated_at = $3
			 WHERE id = $2 AND tenant_id = $4 AND app_id = $5`,
			p.ExternalID, anonID, now, tenantID, appID); err != nil {
			return "", nil, err
		}
		finalID = anonID

	default:
		if err := tx.QueryRow(ctx, `
			INSERT INTO users (tenant_id, app_id, external_id, last_seen_at)
			VALUES ($1, $2, $3, $4) RETURNING id`,
			tenantID, appID, p.ExternalID, now).Scan(&finalID); err != nil {
			return "", nil, err
		}
	}

	res, err := ApplyAttributes(ctx, tx, tenantID, appID, finalID, p.Attributes, "sdk", requestID, now)
	if err != nil {
		return "", nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", nil, err
	}
	return finalID, res, nil
}

// isRetryable — unique 위반(23505)·데드락(40P01)·직렬화 실패(40001)는 재시도로 수렴한다.
func isRetryable(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505", "40P01", "40001":
			return true
		}
	}
	return false
}
