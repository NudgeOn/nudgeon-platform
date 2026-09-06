// Package reconcile — 발송 원장 대사. Redis 유실 이후 중복 발송·누락을 찾아낸다.
//
// PRD-08 5장이 Redis 유실의 2차 방어로 지정한 "message_log 대사"의 구현이다.
// 발송 멱등 키·재시도 카운터·중복 억제가 모두 Redis에 있으므로, Redis가 완전 휘발하면
// "이미 보냈는지"를 알 수 없다. 그때 PostgreSQL의 journey_outbox(발행 원장)와
// ClickHouse의 message_log(발송 결과)를 대조해 실제로 무슨 일이 벌어졌는지 확인한다.
//
// 이 패키지는 읽기 전용이다. 어떤 것도 고치지 않는다 — 대사는 판단의 근거를 만드는
// 작업이고, 복구 방법(재발행/무시/고객 고지)은 사람이 정한다.
package reconcile

import (
	"context"
	"fmt"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/clock"
)

// Scope — 대사 범위. tenant/app는 비우면 전체.
type Scope struct {
	TenantID string
	AppID    string
	Since    time.Time
	// MaxKeys — 메모리 보호 상한. 초과하면 잘라내지 않고 Truncated로 보고한다.
	// 조용히 자른 결과를 "이상 없음"으로 읽는 것이 대사에서 가장 위험하다.
	MaxKeys int
	// Samples — 각 분류마다 보고할 표본 수.
	Samples int
}

// Duplicate — 하나의 멱등 키에 성공 발송이 둘 이상. Redis 멱등 유실의 직접 증거다.
type Duplicate struct {
	TenantID       string
	AppID          string
	IdempotencyKey string
	MessageIDs     []string
	Channel        string
	FirstSentAt    time.Time
	LastSentAt     time.Time
}

// Missing — outbox가 발행 완료로 표시됐는데 message_log에 결과가 없다.
// 발송 작업이 큐에서 사라졌거나, 결과 기록이 실패한 뒤 복구되지 않은 경우다.
type Missing struct {
	TenantID       string
	AppID          string
	IdempotencyKey string
	Stream         string
	PublishedAt    time.Time
}

// Stuck — 발행되지 않은 채 오래 남은 outbox 행. 릴레이 정지의 신호다.
type Stuck struct {
	TenantID       string
	AppID          string
	IdempotencyKey string
	Stream         string
	CreatedAt      time.Time
	AttemptCount   int64
}

// Report — 대사 결과. Truncated가 true면 수치를 "최소값"으로 읽어야 한다.
type Report struct {
	Scope Scope

	DuplicateKeys  int
	DuplicateSends int // 중복분만. 키당 (성공 발송 수 - 1)의 합
	Duplicates     []Duplicate

	MissingCount int
	Missing      []Missing

	StuckCount int
	Stuck      []Stuck

	PublishedKeys int
	LoggedKeys    int

	Truncated bool
	Notes     []string
}

// Clean — 조치가 필요한 발견이 없는가. Truncated면 clean이라고 말하지 않는다.
func (r Report) Clean() bool {
	return !r.Truncated && r.DuplicateKeys == 0 && r.MissingCount == 0 && r.StuckCount == 0
}

const (
	defaultMaxKeys = 500_000
	defaultSamples = 20
	// stuckAfter — 이 시간을 넘겨 발행되지 않으면 릴레이 문제로 본다.
	stuckAfter = 15 * time.Minute
)

func (s *Scope) applyDefaults(clk clock.Clock) {
	if s.MaxKeys <= 0 {
		s.MaxKeys = defaultMaxKeys
	}
	if s.Samples <= 0 {
		s.Samples = defaultSamples
	}
	if s.Since.IsZero() {
		s.Since = clk.Now().Add(-24 * time.Hour)
	}
}

// Run — 세 가지 대사를 순서대로 수행한다.
//
// 중복은 ClickHouse 단독 집계로 찾고, 누락은 PostgreSQL의 발행 키 집합과
// ClickHouse의 기록 키 집합을 비교해 찾는다. 교차 DB 조인이 불가능하므로
// 키 집합을 메모리로 가져와 대조하며, 그래서 MaxKeys 상한이 필요하다.
func Run(ctx context.Context, pg *pgxpool.Pool, ch driver.Conn, clk clock.Clock, scope Scope) (Report, error) {
	scope.applyDefaults(clk)
	rep := Report{Scope: scope}

	dups, dupSends, err := findDuplicates(ctx, ch, scope)
	if err != nil {
		return rep, fmt.Errorf("중복 발송 조회: %w", err)
	}
	rep.Duplicates, rep.DuplicateSends = dups, dupSends
	rep.DuplicateKeys = len(dups)
	if len(dups) > scope.Samples {
		rep.Duplicates = dups[:scope.Samples]
	}

	logged, truncated, err := loggedKeys(ctx, ch, scope)
	if err != nil {
		return rep, fmt.Errorf("발송 로그 키 조회: %w", err)
	}
	rep.LoggedKeys = len(logged)
	if truncated {
		rep.Truncated = true
		rep.Notes = append(rep.Notes, fmt.Sprintf(
			"message_log 키가 상한 %d를 넘었다. 누락 수치는 신뢰할 수 없다 — 범위를 좁혀 다시 실행하라.", scope.MaxKeys))
	}

	if !truncated {
		missing, published, err := findMissing(ctx, pg, scope, logged)
		if err != nil {
			return rep, fmt.Errorf("누락 대사: %w", err)
		}
		rep.PublishedKeys = published
		rep.MissingCount = len(missing)
		rep.Missing = missing
		if len(missing) > scope.Samples {
			rep.Missing = missing[:scope.Samples]
		}
	}

	stuck, total, err := findStuck(ctx, pg, clk, scope)
	if err != nil {
		return rep, fmt.Errorf("미발행 조회: %w", err)
	}
	rep.StuckCount = total
	rep.Stuck = stuck

	return rep, nil
}

// chScope — ClickHouse용 스코프 절과 인자를 만든다.
//
// (? = ” OR col = toUUID(?)) 형태를 쓰지 않는다 — ClickHouse는 OR 단축평가를
// 보장하지 않아 빈 문자열에도 toUUID(”)를 평가하고 CANNOT_PARSE_UUID로 실패한다.
// 필요한 절만 넣는 편이 인덱스 활용에도 낫다.
func chScope(s Scope) (string, []any) {
	where := " AND sent_at >= ?"
	args := []any{s.Since}
	if s.TenantID != "" {
		where += " AND tenant_id = toUUID(?)"
		args = append(args, s.TenantID)
	}
	if s.AppID != "" {
		where += " AND app_id = toUUID(?)"
		args = append(args, s.AppID)
	}
	return where, args
}

// pgScope — PostgreSQL용 스코프 절과 인자. 시작 인덱스는 next.
func pgScope(s Scope, next int) (string, []any) {
	where, args := "", []any{}
	if s.TenantID != "" {
		where += fmt.Sprintf(" AND tenant_id = $%d::uuid", next)
		args, next = append(args, s.TenantID), next+1
	}
	if s.AppID != "" {
		where += fmt.Sprintf(" AND app_id = $%d::uuid", next)
		args = append(args, s.AppID)
	}
	return where, args
}

// findDuplicates — 같은 멱등 키에 서로 다른 message_id로 성공 발송이 둘 이상인 경우.
//
// message_id가 같은 행이 여러 개인 것은 projection 재적재로 생길 수 있는 무해한
// 중복이므로 세지 않는다. 실제 이중 발송은 message_id가 달라진다.
func findDuplicates(ctx context.Context, ch driver.Conn, s Scope) ([]Duplicate, int, error) {
	where, args := chScope(s)
	q := `
		SELECT tenant_id, app_id, idempotency_key,
		       groupUniqArray(toString(message_id)) AS ids,
		       any(channel) AS channel,
		       min(sent_at) AS first_at,
		       max(sent_at) AS last_at
		  FROM message_log
		 WHERE status = 'sent'` + where + `
		 GROUP BY tenant_id, app_id, idempotency_key
		HAVING uniqExact(message_id) > 1
		 ORDER BY last_at DESC`
	rows, err := ch.Query(ctx, q, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var out []Duplicate
	extra := 0
	for rows.Next() {
		var d Duplicate
		if err := rows.Scan(&d.TenantID, &d.AppID, &d.IdempotencyKey,
			&d.MessageIDs, &d.Channel, &d.FirstSentAt, &d.LastSentAt); err != nil {
			return nil, 0, err
		}
		extra += len(d.MessageIDs) - 1
		out = append(out, d)
	}
	return out, extra, rows.Err()
}

// loggedKeys — 창 안에서 message_log에 결과가 남은 멱등 키 집합.
// 상한을 넘으면 잘라낸 집합을 돌려주지 않고 truncated로 알린다.
func loggedKeys(ctx context.Context, ch driver.Conn, s Scope) (map[string]struct{}, bool, error) {
	where, args := chScope(s)
	q := `
		SELECT DISTINCT idempotency_key
		  FROM message_log
		 WHERE 1` + where + `
		 LIMIT ?`
	args = append(args, s.MaxKeys+1)
	rows, err := ch.Query(ctx, q, args...)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()

	set := make(map[string]struct{})
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			return nil, false, err
		}
		set[k] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	return set, len(set) > s.MaxKeys, nil
}

// findMissing — 발행 완료로 표시됐으나 결과 기록이 없는 키.
func findMissing(ctx context.Context, pg *pgxpool.Pool, s Scope, logged map[string]struct{}) ([]Missing, int, error) {
	scopeSQL, scopeArgs := pgScope(s, 2)
	q := `
		SELECT tenant_id::text, app_id::text, idempotency_key, stream, published_at
		  FROM journey_outbox
		 WHERE published_at IS NOT NULL
		   AND published_at >= $1` + scopeSQL + `
		 ORDER BY published_at`
	rows, err := pg.Query(ctx, q, append([]any{s.Since}, scopeArgs...)...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var out []Missing
	published := 0
	for rows.Next() {
		var m Missing
		if err := rows.Scan(&m.TenantID, &m.AppID, &m.IdempotencyKey, &m.Stream, &m.PublishedAt); err != nil {
			return nil, 0, err
		}
		published++
		if _, ok := logged[m.IdempotencyKey]; !ok {
			out = append(out, m)
		}
	}
	return out, published, rows.Err()
}

// findStuck — 발행되지 않고 stuckAfter를 넘긴 outbox 행. 총계와 표본을 함께 돌려준다.
func findStuck(ctx context.Context, pg *pgxpool.Pool, clk clock.Clock, s Scope) ([]Stuck, int, error) {
	cutoff := clk.Now().Add(-stuckAfter)
	var total int
	scopeSQL, scopeArgs := pgScope(s, 2)
	countQ := `
		SELECT count(*) FROM journey_outbox
		 WHERE published_at IS NULL AND created_at < $1` + scopeSQL
	if err := pg.QueryRow(ctx, countQ, append([]any{cutoff}, scopeArgs...)...).Scan(&total); err != nil {
		return nil, 0, err
	}
	if total == 0 {
		return nil, 0, nil
	}

	limitArg := 2 + len(scopeArgs)
	q := fmt.Sprintf(`
		SELECT tenant_id::text, app_id::text, idempotency_key, stream, created_at, relay_attempt_count
		  FROM journey_outbox
		 WHERE published_at IS NULL AND created_at < $1%s
		 ORDER BY created_at
		 LIMIT $%d`, scopeSQL, limitArg)
	rows, err := pg.Query(ctx, q, append(append([]any{cutoff}, scopeArgs...), s.Samples)...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var out []Stuck
	for rows.Next() {
		var st Stuck
		if err := rows.Scan(&st.TenantID, &st.AppID, &st.IdempotencyKey, &st.Stream,
			&st.CreatedAt, &st.AttemptCount); err != nil {
			return nil, 0, err
		}
		out = append(out, st)
	}
	return out, total, rows.Err()
}
