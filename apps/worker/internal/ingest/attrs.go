package ingest

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Querier — pgxpool.Pool과 pgx.Tx 양쪽에서 동작하는 최소 인터페이스.
type Querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// 표준 속성 예약 필드 (PRD-01 4.1). created_at은 고객사 기준 가입일.
var stdAttrKeys = map[string]bool{
	"first_name": true, "last_name": true, "email": true, "phone": true,
	"language": true, "country": true, "timezone": true, "created_at": true,
}

// InferAttrType은 JSON 디코드 값에서 속성 타입을 판정한다 (PRD-01 4.2).
// 반환: attr_type enum 문자열, ok=false면 지원하지 않는 형태(중첩 객체 등).
func InferAttrType(v any) (string, bool) {
	switch t := v.(type) {
	case string:
		if _, err := time.Parse(time.RFC3339, t); err == nil {
			return "datetime", true
		}
		return "string", true
	case float64: // encoding/json 숫자 기본 디코드
		return "number", true
	case bool:
		return "boolean", true
	case []any:
		for _, item := range t {
			if _, isStr := item.(string); !isStr {
				return "", false
			}
		}
		return "string_array", true
	default:
		return "", false
	}
}

// AttrResult — 속성 적용 결과 (CH 기록 행 재료).
type AttrResult struct {
	Changes [][]any // attr_changes 행
	Errors  [][]any // ingestion_errors 행
}

// ApplyAttributes는 유저의 속성을 갱신한다 (D-5의 구현부).
//   - null 값 = unset (키 제거)
//   - registry 타입 불일치 → 해당 키 거부 + ingestion_errors 기록, 기존 값 불변
//   - 표준/커스텀 분리 저장, attr_changes 이력 기록
func ApplyAttributes(
	ctx context.Context,
	q Querier,
	tenantID, appID, userID string,
	attrs map[string]any,
	source, requestID string,
	now time.Time,
) (*AttrResult, error) {
	res := &AttrResult{}
	if len(attrs) == 0 {
		return res, nil
	}

	var stdRaw, customRaw []byte
	err := q.QueryRow(ctx,
		`SELECT std_attrs, custom_attrs FROM users WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
		tenantID, userID).Scan(&stdRaw, &customRaw)
	if err != nil {
		return nil, fmt.Errorf("속성 적용 대상 유저 조회: %w", err)
	}
	std := map[string]any{}
	custom := map[string]any{}
	_ = json.Unmarshal(stdRaw, &std)
	_ = json.Unmarshal(customRaw, &custom)

	dirty := false
	for key, value := range attrs {
		target := custom
		if stdAttrKeys[key] {
			target = std
		}
		old, hadOld := target[key]

		// null = unset (PRD-01 4.2)
		if value == nil {
			if hadOld {
				delete(target, key)
				dirty = true
				res.Changes = append(res.Changes, changeRow(tenantID, appID, userID, key, old, nil, "unset", source, now, requestID))
			}
			continue
		}

		inferred, ok := InferAttrType(value)
		if !ok {
			res.Errors = append(res.Errors, errorRow(tenantID, appID, "attributes", "unsupported_type",
				fmt.Sprintf("키 %q: 지원하지 않는 값 형태", key), value, requestID, now))
			continue
		}

		// registry upsert + 타입 검증 — 기존 등록 타입이 우선 (조용한 타입 오염 방지)
		var registered string
		err := q.QueryRow(ctx, `
			INSERT INTO attribute_registry (tenant_id, app_id, key, type, first_seen_at, last_seen_at)
			VALUES ($1, $2, $3, $4, $5, $5)
			ON CONFLICT (app_id, key) DO UPDATE SET last_seen_at = $5
			RETURNING type`,
			tenantID, appID, key, inferred, now).Scan(&registered)
		if err != nil {
			return nil, fmt.Errorf("registry upsert (%s): %w", key, err)
		}
		if registered != inferred {
			res.Errors = append(res.Errors, errorRow(tenantID, appID, "attributes", "type_mismatch",
				fmt.Sprintf("키 %q: 등록 타입 %s, 수신 값 타입 %s — 기존 값 불변", key, registered, inferred),
				value, requestID, now))
			continue
		}

		if !hadOld || !jsonEqual(old, value) {
			target[key] = value
			dirty = true
			res.Changes = append(res.Changes, changeRow(tenantID, appID, userID, key, old, value, "set", source, now, requestID))
		}
	}

	if dirty {
		newStd, _ := json.Marshal(std)
		newCustom, _ := json.Marshal(custom)
		if _, err := q.Exec(ctx,
			`UPDATE users SET std_attrs = $3, custom_attrs = $4, updated_at = now()
			  WHERE tenant_id = $1 AND id = $2`,
			tenantID, userID, newStd, newCustom); err != nil {
			return nil, fmt.Errorf("속성 갱신: %w", err)
		}
	}
	return res, nil
}

func jsonEqual(a, b any) bool {
	ab, _ := json.Marshal(a)
	bb, _ := json.Marshal(b)
	return string(ab) == string(bb)
}

func changeRow(tenantID, appID, userID, key string, old, new_ any, kind, source string, at time.Time, requestID string) []any {
	oldStr := ""
	if old != nil {
		b, _ := json.Marshal(old)
		oldStr = string(b)
	}
	newStr := ""
	if new_ != nil {
		b, _ := json.Marshal(new_)
		newStr = string(b)
	}
	return []any{tenantID, appID, userID, key, oldStr, newStr, kind, source, at, requestID}
}

func errorRow(tenantID, appID, endpoint, reason, detail string, payload any, requestID string, at time.Time) []any {
	payloadStr := ""
	if payload != nil {
		b, _ := json.Marshal(payload)
		payloadStr = string(b)
	}
	return []any{tenantID, appID, endpoint, reason, detail, payloadStr, requestID, at}
}
