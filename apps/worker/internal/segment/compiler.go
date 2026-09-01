package segment

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// Compiled — 컴파일 산출물. SQL은 ? 위치 인자 바인딩(문자열 삽입 없음)을 사용한다.
type Compiled struct {
	SQL  string
	Args []any
}

// params — ? 위치 인자 수집기. 값은 절대 SQL 문자열에 직접 넣지 않는다.
type params struct{ args []any }

func (p *params) add(v any) string {
	p.args = append(p.args, v)
	return "?"
}

// CompileError — DSL 오류(화이트리스트 위반·잘못된 값 등). 세그먼트 broken 처리 근거.
type CompileError struct{ Reason string }

func (e *CompileError) Error() string { return e.Reason }

func errf(format string, a ...any) *CompileError {
	return &CompileError{Reason: fmt.Sprintf(format, a...)}
}

// Compile은 DSL을 "user_id 집합을 반환하는 CH SELECT"로 변환한다.
// tenant/app 필터·status='active'는 무조건 주입된다(우회 불가 — G-2 불변식).
func Compile(dsl *DSL, tenantID, appID string, category Category) (*Compiled, error) {
	if dsl.Version != 1 {
		return nil, errf("지원하지 않는 DSL 버전: %d", dsl.Version)
	}
	if dsl.Operator != "AND" && dsl.Operator != "OR" {
		return nil, errf("최상위 operator는 AND|OR: %q", dsl.Operator)
	}
	p := &params{}

	// tenant/app/status — 루트 강제 주입 (선두). 위치 인자로 바인딩.
	// UUID 컬럼은 toUUID(?)로 감싸 String 인자를 안전 캐스팅한다.
	where := []string{
		"tenant_id = toUUID(" + p.add(tenantID) + ")",
		"app_id = toUUID(" + p.add(appID) + ")",
		"status = 'active'",
	}

	if len(dsl.Groups) > 0 {
		groupSQLs := make([]string, 0, len(dsl.Groups))
		for i, g := range dsl.Groups {
			sql, err := compileGroup(&g, tenantID, appID, category, p)
			if err != nil {
				return nil, fmt.Errorf("group[%d]: %w", i, err)
			}
			groupSQLs = append(groupSQLs, sql)
		}
		joined := strings.Join(groupSQLs, " "+dsl.Operator+" ")
		where = append(where, "("+joined+")")
	}

	sql := "SELECT user_id FROM profiles_mirror FINAL WHERE " + strings.Join(where, " AND ")
	return &Compiled{SQL: sql, Args: p.args}, nil
}

func compileGroup(g *Group, tenantID, appID string, category Category, p *params) (string, error) {
	if g.Operator != "AND" && g.Operator != "OR" {
		return "", errf("group operator는 AND|OR: %q", g.Operator)
	}
	if len(g.Conditions) == 0 {
		return "", errf("빈 group")
	}
	parts := make([]string, 0, len(g.Conditions))
	for i := range g.Conditions {
		sql, err := compileCondition(&g.Conditions[i], tenantID, appID, category, p)
		if err != nil {
			return "", fmt.Errorf("condition[%d]: %w", i, err)
		}
		parts = append(parts, sql)
	}
	return "(" + strings.Join(parts, " "+g.Operator+" ") + ")", nil
}

func compileCondition(c *Condition, tenantID, appID string, category Category, p *params) (string, error) {
	switch c.Type {
	case "attribute":
		return compileAttribute(c, p)
	case "channel":
		return compileChannel(c, category, p)
	case "device":
		return compileDevice(c, p)
	case "event":
		return compileEvent(c, tenantID, appID, p)
	default:
		return "", errf("알 수 없는 condition type: %q", c.Type)
	}
}

// 속성 조건 — std_attrs/custom_attrs JSON에서 값 추출. 키는 화이트리스트가 아니라
// (테넌트가 정의하는 동적 속성이므로) JSONExtract로 안전 추출하되 키 자체를 인자 바인딩한다.
func compileAttribute(c *Condition, p *params) (string, error) {
	if c.Key == "" {
		return "", errf("attribute 조건에 key 없음")
	}
	col := "custom_attrs"
	if stdAttrCols[c.Key] {
		col = "std_attrs"
	}
	// JSONExtractString(col, key) — key는 인자 바인딩(문자열 삽입 아님)
	extract := func() string {
		return fmt.Sprintf("JSONExtractString(%s, %s)", col, p.add(c.Key))
	}
	extractRaw := func() string {
		return fmt.Sprintf("JSONExtractRaw(%s, %s)", col, p.add(c.Key))
	}

	switch c.Op {
	case "exists":
		return extractRaw() + " != ''", nil
	case "not_exists":
		return extractRaw() + " = ''", nil
	case "eq", "neq", "gt", "gte", "lt", "lte":
		sqlOp := attrCmpOps[c.Op]
		v, isNum, err := scalarValue(c.Value)
		if err != nil {
			return "", err
		}
		if isNum {
			// 숫자 비교 — toFloat64OrNull
			return fmt.Sprintf("toFloat64OrNull(%s) %s %s", extract(), sqlOp, p.add(v)), nil
		}
		return fmt.Sprintf("%s %s %s", extract(), sqlOp, p.add(v)), nil
	case "in":
		vals, err := arrayValues(c.Value)
		if err != nil {
			return "", err
		}
		if len(vals) == 0 {
			return "0", nil // 빈 in → 항상 거짓
		}
		placeholders := make([]string, len(vals))
		for i, v := range vals {
			placeholders[i] = p.add(v)
		}
		return fmt.Sprintf("%s IN (%s)", extract(), strings.Join(placeholders, ", ")), nil
	case "contains":
		// string[] 커스텀 속성에 특정 값 포함 (JSON 배열)
		v, _, err := scalarValue(c.Value)
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("has(JSONExtract(%s, 'Array(String)'), %s)", extractRaw(), p.add(v)), nil
	case "in_last_days", "not_in_last_days":
		days, err := intValue(c.Value)
		if err != nil {
			return "", err
		}
		cmp := ">="
		if c.Op == "not_in_last_days" {
			cmp = "<"
		}
		return fmt.Sprintf("parseDateTimeBestEffortOrNull(%s) %s now() - INTERVAL %s DAY",
			extract(), cmp, p.add(days)), nil
	case "before", "after":
		v, _, err := scalarValue(c.Value)
		if err != nil {
			return "", err
		}
		cmp := "<"
		if c.Op == "after" {
			cmp = ">"
		}
		return fmt.Sprintf("parseDateTimeBestEffortOrNull(%s) %s parseDateTimeBestEffortOrNull(%s)",
			extract(), cmp, p.add(v)), nil
	default:
		return "", errf("attribute 연산자 화이트리스트 위반: %q", c.Op)
	}
}

// 채널 조건 — push_reachable을 카테고리별로 조합 (PRD-02 2.3), token_platform_in은 보유 플랫폼 매칭.
func compileChannel(c *Condition, category Category, p *params) (string, error) {
	switch c.Op {
	case "push_reachable":
		if category == Transactional {
			return "(os_permission_granted = 1 AND token_active = 1)", nil
		}
		return "(push_opt_in = 1 AND os_permission_granted = 1 AND token_active = 1)", nil
	case "token_platform_in":
		// profiles_mirror.platforms(Array(String))에 지정 플랫폼 중 하나라도 있으면 매치.
		// 값은 화이트리스트(ios/android)로 제한하고 위치 인자로 바인딩(문자열 삽입 없음).
		vals, err := arrayValues(c.Value)
		if err != nil {
			return "", err
		}
		if len(vals) == 0 {
			return "0", nil // 빈 목록 → 항상 거짓
		}
		placeholders := make([]string, len(vals))
		for i, v := range vals {
			s, ok := v.(string)
			if !ok || !platformValues[s] {
				return "", errf("token_platform_in 값 화이트리스트 위반(ios|android): %v", v)
			}
			placeholders[i] = p.add(s)
		}
		return fmt.Sprintf("arrayExists(x -> x IN (%s), platforms)", strings.Join(placeholders, ", ")), nil
	default:
		return "", errf("channel 연산자 화이트리스트 위반: %q", c.Op)
	}
}

// 디바이스 조건 — device_meta JSON 키(화이트리스트) 비교. platforms는 배열.
func compileDevice(c *Condition, p *params) (string, error) {
	if !deviceCols[c.Key] {
		return "", errf("device 컬럼 화이트리스트 위반: %q", c.Key)
	}
	sqlOp, ok := attrCmpOps[c.Op]
	if !ok {
		return "", errf("device 연산자 화이트리스트 위반: %q", c.Op)
	}
	if _, _, err := scalarValue(c.Value); err != nil {
		return "", err
	}
	_ = sqlOp
	// fail-closed (재검증 B): device_meta(app_version/os_version 등)는 아직 mirror에 없어
	// 정밀 비교가 불가능하다. 이전 구현은 SQL "1"(전건 매치)을 반환해 조건에 맞지 않는 대상까지
	// 포함시켰다. 구현 전까지는 명시적으로 거부해 잘못된 타기팅을 막는다(세그먼트는 broken 처리됨).
	return "", errf("device 조건 %q는 아직 지원되지 않습니다 — 지원 전까지 대상 오포함 방지를 위해 거부(재검증 B)", c.Key)
}

// 이벤트 조건 — events 서브쿼리. server_ts 기준(신뢰). 병합 매핑(user_merges)을 반영해
// 병합 이전 user_id로 적재된 과거 이벤트를 canonical 사용자에 귀속시킨다 (R-10, G-9):
// events.user_id를 user_merges 최신 간선(from→to)과 LEFT JOIN 후 coalesce로 canonical 해소.
// 경로 압축(merge.go)으로 간선은 최종 canonical을 가리키므로 단일 조인이면 충분하다.
func compileEvent(c *Condition, tenantID, appID string, p *params) (string, error) {
	if c.Event == "" {
		return "", errf("event 조건에 event 없음")
	}
	// applyWindow=true면 events 행을 window로 사전 필터(performed/count 계열).
	// first/last_performed는 최초/최근 시점을 전 기간에서 구해 HAVING으로 비교해야 하므로
	// 사전 필터를 끄고(applyWindow=false) window를 HAVING 임계로만 쓴다.
	base := func(applyWindow bool) string {
		// SQL의 ? 등장 순서대로 인자를 바인딩한다: 조인 서브쿼리 tenant/app,
		// 그다음 events tenant/app/event, 마지막에 선택적 window.
		mergeMap := fmt.Sprintf(
			"(SELECT from_user_id, argMax(to_user_id, merged_at) AS to_user_id FROM user_merges "+
				"WHERE tenant_id = toUUID(%s) AND app_id = toUUID(%s) GROUP BY from_user_id)",
			p.add(tenantID), p.add(appID))
		// CH LEFT JOIN은 미매칭 시 to_user_id를 NULL이 아니라 타입 기본값(zero-UUID)으로 채운다
		// (join_use_nulls=0 기본). 따라서 coalesce가 아니라 zero-UUID를 "병합 없음"으로 판정해야
		// 병합 이력이 없는(대다수) 사용자의 이벤트가 zero-user로 오귀속되지 않는다. (R-10 회귀 수정)
		query := fmt.Sprintf(
			"SELECT if(m.to_user_id = toUUID('%s'), e.user_id, m.to_user_id) AS user_id FROM events e "+
				"LEFT JOIN %s m ON e.user_id = m.from_user_id "+
				"WHERE e.tenant_id = toUUID(%s) AND e.app_id = toUUID(%s) AND e.event_name = %s",
			anonUser, mergeMap, p.add(tenantID), p.add(appID), p.add(c.Event))
		if applyWindow && c.WindowDays != nil {
			query += fmt.Sprintf(" AND e.server_ts >= now() - INTERVAL %s DAY", p.add(*c.WindowDays))
		}
		return query
	}

	switch c.Op {
	case "performed":
		return "user_id IN (" + base(true) + " GROUP BY user_id)", nil
	case "not_performed":
		return "user_id NOT IN (" + base(true) + " GROUP BY user_id)", nil
	case "count_gte", "count_lte":
		n, err := intValue(c.Value)
		if err != nil {
			return "", err
		}
		cmp := ">="
		if c.Op == "count_lte" {
			cmp = "<="
		}
		// insert_id 유일 집계 — ReplacingMergeTree 병합 전 중복 행이 카운트를 부풀리지 않게 (R-05).
		return fmt.Sprintf("user_id IN (%s GROUP BY user_id HAVING uniqExact(insert_id) %s %s)",
			base(true), cmp, p.add(n)), nil
	case "first_performed", "last_performed":
		// 시점 비교 (PRD-02): 사용자의 최초(min)/최근(max) 발생 server_ts가 최근 window_days 이내인지.
		// 예) first_performed 7d = 최근 7일 내 처음 수행(신규 채택자), last_performed 30d = 최근 30일 내 마지막 수행(활성).
		if c.WindowDays == nil {
			return "", errf("%s는 window_days가 필요합니다", c.Op)
		}
		agg := "min"
		if c.Op == "last_performed" {
			agg = "max"
		}
		return fmt.Sprintf("user_id IN (%s GROUP BY user_id HAVING %s(e.server_ts) >= now() - INTERVAL %s DAY)",
			base(false), agg, p.add(*c.WindowDays)), nil
	default:
		return "", errf("event 연산자 화이트리스트 위반: %q", c.Op)
	}
}

// --- 값 파서 (JSON RawMessage → 안전 스칼라) ---

func scalarValue(raw json.RawMessage) (any, bool, error) {
	if len(raw) == 0 {
		return nil, false, errf("value 없음")
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s, false, nil
	}
	var f float64
	if json.Unmarshal(raw, &f) == nil {
		return f, true, nil
	}
	var b bool
	if json.Unmarshal(raw, &b) == nil {
		if b {
			return "true", false, nil
		}
		return "false", false, nil
	}
	return nil, false, errf("지원하지 않는 value 형태: %s", string(raw))
}

func arrayValues(raw json.RawMessage) ([]any, error) {
	var arr []any
	if err := json.Unmarshal(raw, &arr); err != nil {
		return nil, errf("value가 배열이 아님: %s", string(raw))
	}
	out := make([]any, len(arr))
	for i, v := range arr {
		switch t := v.(type) {
		case string:
			out[i] = t
		case float64:
			out[i] = strconv.FormatFloat(t, 'f', -1, 64)
		case bool:
			out[i] = strconv.FormatBool(t)
		default:
			return nil, errf("배열 원소 타입 미지원: %v", v)
		}
	}
	return out, nil
}

func intValue(raw json.RawMessage) (int64, error) {
	var f float64
	if err := json.Unmarshal(raw, &f); err != nil {
		return 0, errf("정수 value 아님: %s", string(raw))
	}
	return int64(f), nil
}
