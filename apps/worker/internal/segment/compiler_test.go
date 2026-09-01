package segment

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestEventWindowBindingOrder(t *testing.T) {
	var dsl DSL
	err := json.Unmarshal([]byte(`{"version":1,"operator":"AND","groups":[{"operator":"AND","conditions":[
		{"type":"event","event":"purchase","op":"count_gte","value":2,"window_days":30},
		{"type":"event","event":"cancel","op":"not_performed","window_days":7}]}]}`), &dsl)
	if err != nil {
		t.Fatal(err)
	}
	compiled, err := Compile(&dsl, testTenant, testApp, Marketing)
	if err != nil {
		t.Fatal(err)
	}
	// R-10 병합 매핑 조인으로 각 이벤트 조건은 mergeMap(tenant/app) + events(tenant/app/event)
	// 순으로 인자를 추가한다. 루트(tenant/app)가 선두.
	want := []any{
		testTenant, testApp,
		testTenant, testApp, testTenant, testApp, "purchase", 30, int64(2),
		testTenant, testApp, testTenant, testApp, "cancel", 7,
	}
	if !reflect.DeepEqual(compiled.Args, want) {
		t.Fatalf("SQL 순서와 인자가 다름: got %#v, want %#v", compiled.Args, want)
	}
}

const (
	testTenant = "11111111-1111-4111-8111-111111111111"
	testApp    = "22222222-2222-4222-8222-222222222222"
)

type goldenFile struct {
	Cases []goldenCase `json:"cases"`
}

type goldenCase struct {
	Name     string          `json:"name"`
	Category string          `json:"category"`
	DSL      json.RawMessage `json:"dsl"`
	Expect   struct {
		Compiles    bool     `json:"compiles"`
		Contains    []string `json:"contains"`
		NotContains []string `json:"not_contains"`
	} `json:"expect"`
}

// G-1: 골든 스위트 — 언어 중립 케이스가 전부 기대대로 컴파일된다.
func TestGoldenSuite(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "packages", "segment-dsl", "golden", "cases.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("골든 파일 읽기 실패: %v", err)
	}
	var gf goldenFile
	if err := json.Unmarshal(data, &gf); err != nil {
		t.Fatalf("골든 파일 파싱: %v", err)
	}
	if len(gf.Cases) == 0 {
		t.Fatal("골든 케이스 없음")
	}

	for _, c := range gf.Cases {
		t.Run(c.Name, func(t *testing.T) {
			var dsl DSL
			if err := json.Unmarshal(c.DSL, &dsl); err != nil {
				t.Fatalf("DSL 파싱: %v", err)
			}
			compiled, err := Compile(&dsl, testTenant, testApp, Category(c.Category))

			if !c.Expect.Compiles {
				if err == nil {
					t.Errorf("컴파일 실패 기대했으나 성공: %s", compiled.SQL)
				}
				return
			}
			if err != nil {
				t.Fatalf("컴파일 실패: %v", err)
			}
			for _, want := range c.Expect.Contains {
				if !strings.Contains(compiled.SQL, want) {
					t.Errorf("SQL에 %q 없음\nSQL: %s", want, compiled.SQL)
				}
			}
			for _, notWant := range c.Expect.NotContains {
				if strings.Contains(compiled.SQL, notWant) {
					t.Errorf("SQL에 %q 있으면 안 됨\nSQL: %s", notWant, compiled.SQL)
				}
			}
		})
	}
}

// G-2: tenant 주입 불변식 — 모든 컴파일 산출 SQL에 tenant/app 필터가 주입되고,
// 첫 두 인자가 tenant_id, app_id다 (우회 불가 구조).
func TestTenantInjectionInvariant(t *testing.T) {
	dsls := []string{
		`{"version":1,"operator":"AND","groups":[]}`,
		`{"version":1,"operator":"AND","groups":[{"operator":"OR","conditions":[{"type":"attribute","key":"country","op":"eq","value":"KR"}]}]}`,
		`{"version":1,"operator":"AND","groups":[{"operator":"AND","conditions":[{"type":"event","event":"purchase","op":"count_gte","value":1,"window_days":30}]}]}`,
	}
	for _, raw := range dsls {
		var dsl DSL
		if err := json.Unmarshal([]byte(raw), &dsl); err != nil {
			t.Fatal(err)
		}
		compiled, err := Compile(&dsl, testTenant, testApp, Marketing)
		if err != nil {
			t.Fatalf("컴파일: %v", err)
		}
		if !strings.Contains(compiled.SQL, "tenant_id = toUUID(?)") || !strings.Contains(compiled.SQL, "app_id = toUUID(?)") {
			t.Errorf("tenant/app 필터 누락: %s", compiled.SQL)
		}
		if !strings.Contains(compiled.SQL, "status = 'active'") {
			t.Errorf("status 필터 누락: %s", compiled.SQL)
		}
		if len(compiled.Args) < 2 || compiled.Args[0] != testTenant || compiled.Args[1] != testApp {
			t.Errorf("첫 두 인자가 tenant/app이 아님: %v", compiled.Args)
		}
		// 이벤트 서브쿼리에도 tenant/app이 재주입되는지
		if strings.Contains(compiled.SQL, "FROM events") {
			if strings.Count(compiled.SQL, "tenant_id = toUUID(?)") < 2 {
				t.Errorf("이벤트 서브쿼리에 tenant 필터 누락: %s", compiled.SQL)
			}
		}
	}
}

// 값이 SQL 문자열에 직접 삽입되지 않는다 (인젝션 방어) — 위험 문자열은 인자로만.
func TestNoStringInterpolation(t *testing.T) {
	raw := `{"version":1,"operator":"AND","groups":[{"operator":"AND","conditions":[
		{"type":"attribute","key":"name","op":"eq","value":"'; DROP TABLE users; --"}]}]}`
	var dsl DSL
	if err := json.Unmarshal([]byte(raw), &dsl); err != nil {
		t.Fatal(err)
	}
	compiled, err := Compile(&dsl, testTenant, testApp, Marketing)
	if err != nil {
		t.Fatalf("컴파일: %v", err)
	}
	if strings.Contains(compiled.SQL, "DROP TABLE") {
		t.Errorf("악성 값이 SQL에 삽입됨: %s", compiled.SQL)
	}
	found := false
	for _, a := range compiled.Args {
		if a == "'; DROP TABLE users; --" {
			found = true
		}
	}
	if !found {
		t.Error("악성 값이 인자로 바인딩되지 않음")
	}
}
