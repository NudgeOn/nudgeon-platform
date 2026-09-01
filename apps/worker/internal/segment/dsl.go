// Package segment — DSL(JSON) → ClickHouse SQL 컴파일러 (PRD-02, DEV-sub-02).
// 원칙: 임의 문자열 조립 금지. 연산자·컬럼은 화이트리스트 테이블 기반이며,
// tenant/app 필터는 AST 루트에 무조건 주입된다(우회 불가 구조).
// 이 모듈의 버그 = 잘못된 대상 발송이므로 화이트리스트를 절대 우회하지 않는다.
package segment

import "encoding/json"

// DSL 구조 — packages/segment-dsl/schema/segment.schema.json과 동형.
type DSL struct {
	Version  int     `json:"version"`
	Operator string  `json:"operator"` // AND | OR
	Groups   []Group `json:"groups"`
}

type Group struct {
	Operator   string      `json:"operator"`
	Conditions []Condition `json:"conditions"`
}

type Condition struct {
	Type       string          `json:"type"` // attribute | event | channel | device
	Key        string          `json:"key,omitempty"`
	Event      string          `json:"event,omitempty"`
	Op         string          `json:"op"`
	Value      json.RawMessage `json:"value,omitempty"`
	WindowDays *int            `json:"window_days,omitempty"`
}

// Category — 발송 카테고리에 따라 push_reachable 조합이 달라진다 (PRD-03 6.3).
type Category string

const (
	Marketing     Category = "marketing"
	Transactional Category = "transactional"
)

const anonUser = "00000000-0000-0000-0000-000000000000"

// 표준 속성 예약 필드 — std_attrs JSON에서 추출. 그 외는 custom_attrs.
var stdAttrCols = map[string]bool{
	"external_id": true, "first_name": true, "last_name": true, "email": true,
	"phone": true, "language": true, "country": true, "timezone": true,
	"created_at": true, "last_seen_at": true,
}

// 속성 연산자 화이트리스트 → SQL 비교 연산자
var attrCmpOps = map[string]string{
	"eq": "=", "neq": "!=", "gt": ">", "gte": ">=", "lt": "<", "lte": "<=",
}

// 디바이스 컬럼 화이트리스트 (device_meta JSON 키)
var deviceCols = map[string]bool{"app_version": true, "os_version": true}

// platformValues — token_platform_in 값 화이트리스트 (PRD-01A 지원 플랫폼).
var platformValues = map[string]bool{"ios": true, "android": true}
