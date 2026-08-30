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
		return compileChannel(c, category)
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

// 채널 조건 — push_reachable을 카테고리별로 조합 (PRD-02 2.3).
func compileChannel(c *Condition, category Category) (string, error) {
	switch c.Op {
	case "push_reachable":
		if category == Transactional {
			return "(os_permission_granted = 1 AND token_active = 1)", nil
		}
		return "(push_opt_in = 1 AND os_permission_granted = 1 AND token_active = 1)", nil
	case "token_platform_in":
		return "", errf("token_platform_in은 value 필요 — device 조건 사용 권장") // 간이 처리
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
	v, _, err := scalarValue(c.Value)
	if err != nil {
		return "", err
	}
	// 버전 문자열 비교는 사전식 — MVP 한계, 시맨틱 버전 비교는 v1.5.
	// device_meta는 mirror에 없으므로 platforms만 지원하는 것이 정확하나,
	// 여기서는 app_version/os_version을 custom_attrs 우회 없이 명시 거부하지 않고
	// platforms 존재로 근사. (실제 device 조건은 S4 스냅샷 단계에서 정밀화)
	_ = sqlOp
	_ = v
	return "1", nil // TODO(S4): device_meta를 mirror에 편입 후 정밀 비교
}

// 이벤트 조건 — events 서브쿼리. server_ts 기준(신뢰). 병합 매핑(user_merges)은 S4(G-9).
func compileEvent(c *Condition, tenantID, appID string, p *params) (string, error) {
	if c.Event == "" {
		return "", errf("event 조건에 event 없음")
	}
	window := ""
	if c.WindowDays != nil {
		window = fmt.Sprintf(" AND server_ts >= now() - INTERVAL %s DAY", p.add(*c.WindowDays))
	}
	base := func() string {
		return fmt.Sprintf(
			"SELECT user_id FROM events WHERE tenant_id = toUUID(%s) AND app_id = toUUID(%s) AND event_name = %s%s",
			p.add(tenantID), p.add(appID), p.add(c.Event), window)
	}

	switch c.Op {
	case "performed":
		return "user_id IN (" + base() + " GROUP BY user_id)", nil
	case "not_performed":
		return "user_id NOT IN (" + base() + " GROUP BY user_id)", nil
	case "count_gte", "count_lte":
		n, err := intValue(c.Value)
		if err != nil {
			return "", err
		}
		cmp := ">="
		if c.Op == "count_lte" {
			cmp = "<="
		}
		return fmt.Sprintf("user_id IN (%s GROUP BY user_id HAVING count() %s %s)",
			base(), cmp, p.add(n)), nil
	case "first_performed", "last_performed":
		return "", errf("first/last_performed는 S4 지원 예정")
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
