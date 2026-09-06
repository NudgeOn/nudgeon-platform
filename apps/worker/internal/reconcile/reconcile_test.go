package reconcile

import (
	"strings"
	"testing"
	"time"

	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/clock"
)

func TestCleanRequiresCompleteScan(t *testing.T) {
	// 상한을 넘겨 판단하지 못한 결과를 "이상 없음"으로 보고하면 안 된다.
	// 대사 도구에서 가장 위험한 실패 방식이다.
	r := Report{Truncated: true}
	if r.Clean() {
		t.Fatal("Truncated 결과를 clean으로 보고했다")
	}
	if !(Report{}).Clean() {
		t.Fatal("발견이 없는데 clean이 아니다")
	}
	for name, bad := range map[string]Report{
		"중복":  {DuplicateKeys: 1},
		"누락":  {MissingCount: 1},
		"미발행": {StuckCount: 1},
	} {
		if bad.Clean() {
			t.Fatalf("%s 발견을 clean으로 보고했다", name)
		}
	}
}

func TestScopeDefaultsUseInjectedClock(t *testing.T) {
	// CLAUDE.md 규칙 3 — 기본 창 계산도 주입 시계를 따라야 시간 가속 테스트가 가능하다.
	fixed := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	clk := &clock.Fake{Current: fixed}
	s := Scope{}
	s.applyDefaults(clk)

	if want := fixed.Add(-24 * time.Hour); !s.Since.Equal(want) {
		t.Fatalf("Since=%v, want %v", s.Since, want)
	}
	if s.MaxKeys != defaultMaxKeys || s.Samples != defaultSamples {
		t.Fatalf("기본값 미적용: MaxKeys=%d Samples=%d", s.MaxKeys, s.Samples)
	}

	// 명시된 값은 덮어쓰지 않는다.
	explicit := Scope{Since: fixed, MaxKeys: 7, Samples: 3}
	explicit.applyDefaults(clk)
	if !explicit.Since.Equal(fixed) || explicit.MaxKeys != 7 || explicit.Samples != 3 {
		t.Fatal("명시된 Scope 값을 기본값이 덮어썼다")
	}
}

func TestChScopeOmitsEmptyFilters(t *testing.T) {
	// ClickHouse는 OR 단축평가를 보장하지 않는다. 빈 값에 toUUID('')를 넘기면
	// CANNOT_PARSE_UUID로 쿼리 자체가 실패한다 — 절을 아예 넣지 않아야 한다.
	since := time.Unix(1_700_000_000, 0).UTC()

	where, args := chScope(Scope{Since: since})
	if strings.Contains(where, "toUUID") {
		t.Fatalf("스코프가 비었는데 toUUID 절이 들어갔다: %q", where)
	}
	if len(args) != 1 {
		t.Fatalf("args=%d, want 1", len(args))
	}

	where, args = chScope(Scope{Since: since, TenantID: "t-1", AppID: "a-1"})
	if strings.Count(where, "toUUID(?)") != 2 {
		t.Fatalf("tenant/app 절이 모두 들어가지 않았다: %q", where)
	}
	if len(args) != 3 || args[1] != "t-1" || args[2] != "a-1" {
		t.Fatalf("인자 순서가 절과 어긋난다: %v", args)
	}
}

func TestPgScopeNumbersPlaceholdersInOrder(t *testing.T) {
	// 자리표시자 번호가 인자 순서와 어긋나면 조용히 잘못된 행을 대사한다.
	where, args := pgScope(Scope{}, 2)
	if where != "" || len(args) != 0 {
		t.Fatalf("빈 스코프인데 절이 생성됐다: %q %v", where, args)
	}

	where, args = pgScope(Scope{TenantID: "t-1"}, 2)
	if !strings.Contains(where, "$2::uuid") || len(args) != 1 {
		t.Fatalf("tenant 단독: %q %v", where, args)
	}

	where, args = pgScope(Scope{TenantID: "t-1", AppID: "a-1"}, 2)
	if !strings.Contains(where, "tenant_id = $2::uuid") || !strings.Contains(where, "app_id = $3::uuid") {
		t.Fatalf("자리표시자 번호가 어긋났다: %q", where)
	}
	if len(args) != 2 || args[0] != "t-1" || args[1] != "a-1" {
		t.Fatalf("인자 순서: %v", args)
	}
}
