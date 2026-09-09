package journey

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	libqueue "github.com/nudgeon/nudgeon-platform/packages/libqueue-go"
)

// M-3 (DEV-MAIN 7.2) — 선형 저니 시간 가속 E2E:
// "가입 → 1일 대기 → 푸시A → 3일 대기 → 푸시B, purchase 시 이탈".
// 실 PostgreSQL 위에서 Fake clock으로 4일을 돌린다. 세 고객이 세 경로를 밟는다:
//
//	complete   — 4일 뒤 푸시 B까지 완주
//	exit-early — 1일 대기 중 purchase → 푸시 A·B 모두 미발송
//	exit-late  — 푸시 A 뒤 3일 대기 중 purchase → 푸시 B 미발송
//
// 검증: 전이(기상 시각·노드 포트), 이탈(후속 노드 미실행·outbox 없음), 리포트 원천
// (journey_node_executions 노드별 집계 == 콘솔 저니 리포트가 읽는 값).
func TestLinearJourneyM3TimeAccelerated(t *testing.T) {
	const day = 24 * time.Hour
	def := testGraph([]Node{
		{ID: "wait-1d", Type: "delay", DurationSeconds: int64(day / time.Second)},
		testMessage("push-a", "푸시 A — 환영합니다"),
		{ID: "wait-3d", Type: "delay", DurationSeconds: int64(3 * day / time.Second)},
		testMessage("push-b", "푸시 B — 다시 만나요"),
	}, []Edge{
		testEdge("wait-1d", "next", "push-a"), testEdge("push-a", "next", "wait-3d"),
		testEdge("wait-3d", "next", "push-b"), testEdge("push-b", "next", ""),
	}, "wait-1d")
	def.Entry = Entry{Type: "trigger", TriggerEvent: "signup"}
	def.Exit = Exit{ConversionEvent: "purchase"}
	def.Settings.Category = "marketing" // quiet hours·stale 정책이 실제로 걸리는 카테고리
	f := newRuntimeFixture(t, def)
	t0 := f.clk.Now()

	type customer struct{ name, user, device, state string }
	customers := []*customer{{name: "complete", user: f.user, device: f.device}, {name: "exit-early", user: uuid.NewString(), device: uuid.NewString()}, {name: "exit-late", user: uuid.NewString(), device: uuid.NewString()}}
	for _, c := range customers[1:] {
		f.exec(`INSERT INTO users(id,tenant_id,app_id,subscriptions,created_at) VALUES($1,$2,$3,'{"push":"opted_in"}',$4)`, c.user, f.tenant, f.app, t0)
		f.exec(`INSERT INTO devices(id,tenant_id,app_id,user_id,platform,push_token,os_permission)
			VALUES($1,$2,$3,$4,'android',$5,'granted')`, c.device, f.tenant, f.app, c.user, "m3-"+c.name)
	}
	// event — 수집 경로가 남기는 receipt를 심고 trigger-matcher가 하듯 HandleEvent로 넘긴다.
	event := func(c *customer, name string) {
		t.Helper()
		f.user, f.device = c.user, c.device
		if err := f.s.HandleEvent(f.ctx, f.receipt(name, f.clk.Now(), true)); err != nil {
			t.Fatal(err)
		}
	}
	// drainEntries — HandleEvent가 outbox에 남긴 journey.entry를 entry 소비자처럼 처리해 journey_states를 만든다.
	drainEntries := func() {
		t.Helper()
		rows, err := f.pg.Query(f.ctx, `SELECT id,payload FROM journey_outbox WHERE tenant_id=$1 AND stream='stream:journey.entry' AND published_at IS NULL ORDER BY id`, f.tenant)
		if err != nil {
			t.Fatal(err)
		}
		type entry struct {
			id      int64
			payload []byte
		}
		var entries []entry
		for rows.Next() {
			var e entry
			if err := rows.Scan(&e.id, &e.payload); err != nil {
				t.Fatal(err)
			}
			entries = append(entries, e)
		}
		rows.Close()
		for _, e := range entries {
			m := &libqueue.Message{Envelope: libqueue.Envelope{TenantID: f.tenant, AppID: f.app, Payload: e.payload}}
			if err := f.s.handleEntry(f.ctx, m); err != nil {
				t.Fatal(err)
			}
			f.exec(`UPDATE journey_outbox SET published_at=$2 WHERE id=$1`, e.id, f.clk.Now())
		}
	}
	stateOf := func(c *customer) string {
		t.Helper()
		var id string
		if err := f.pg.QueryRow(f.ctx, `SELECT id FROM journey_states WHERE tenant_id=$1 AND app_id=$2 AND journey_id=$3 AND user_id=$4`, f.tenant, f.app, f.journey, c.user).Scan(&id); err != nil {
			t.Fatalf("%s: state missing: %v", c.name, err)
		}
		return id
	}
	wakeOf := func(c *customer) time.Time {
		t.Helper()
		var wake time.Time
		if err := f.pg.QueryRow(f.ctx, `SELECT next_wake_at FROM journey_states WHERE tenant_id=$1 AND id=$2`, f.tenant, c.state).Scan(&wake); err != nil {
			t.Fatalf("%s: wake: %v", c.name, err)
		}
		return wake
	}
	sends := func() int {
		t.Helper()
		var n int
		if err := f.pg.QueryRow(f.ctx, `SELECT count(*) FROM journey_outbox WHERE tenant_id=$1 AND stream<>'stream:journey.entry'`, f.tenant).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	sendTitles := func(c *customer) []string {
		t.Helper()
		rows, err := f.pg.Query(f.ctx, `SELECT payload FROM journey_outbox WHERE tenant_id=$1 AND stream<>'stream:journey.entry' AND payload->>'user_id'=$2 ORDER BY id`, f.tenant, c.user)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var titles []string
		for rows.Next() {
			var raw []byte
			if err := rows.Scan(&raw); err != nil {
				t.Fatal(err)
			}
			var p struct {
				Content struct {
					Push struct{ Title string } `json:"push"`
				} `json:"content"`
				DeviceID string `json:"device_id"`
			}
			if err := json.Unmarshal(raw, &p); err != nil {
				t.Fatal(err)
			}
			if p.DeviceID != c.device {
				t.Fatalf("%s: 발송이 다른 디바이스로: %s", c.name, p.DeviceID)
			}
			titles = append(titles, p.Content.Push.Title)
		}
		return titles
	}

	// Day 0 — 세 명 가입(trigger 진입) → 1일 대기 시작.
	for _, c := range customers {
		event(c, "signup")
	}
	drainEntries()
	for _, c := range customers {
		c.state = stateOf(c)
	}
	f.tick() // delay 노드 실행 → 그 노드에서 waiting, 기상 = t0+1d (v2: 대기 노드는 자기 자리에서 기다린다)
	for _, c := range customers {
		if status, node := f.state(c.state); status != "waiting" || node != 0 {
			t.Fatalf("%s: day0 %s/%d", c.name, status, node)
		}
		if wake := wakeOf(c); !wake.Equal(t0.Add(day)) {
			t.Fatalf("%s: 1일 대기 기상 시각 %v != %v", c.name, wake, t0.Add(day))
		}
	}
	if sends() != 0 {
		t.Fatal("대기 중 발송이 있다")
	}

	// Day 0 + 12h — exit-early가 구매 → 즉시 이탈. 기상 전이라 A도 안 간다.
	f.clk.Advance(12 * time.Hour)
	event(customers[1], "purchase")
	if status, _ := f.state(customers[1].state); status != "exited" {
		t.Fatalf("exit-early: purchase 뒤 상태 %s", status)
	}
	f.tick() // 기상 전 — 아무 일도 없어야 한다
	if sends() != 0 {
		t.Fatal("기상 전에 발송됨")
	}

	// Day 1 — 기상 → 푸시 A (complete·exit-late 2명) → 3일 대기 시작.
	f.clk.Advance(12 * time.Hour)
	f.tick() // wait-1d 완료 → push-a로 전이
	f.tick() // push-a 발송 → wait-3d로 전이
	f.tick() // wait-3d 실행 → waiting
	if n := sends(); n != 2 {
		t.Fatalf("day1: 푸시 A 2건 기대, outbox=%d", n)
	}
	for _, c := range []*customer{customers[0], customers[2]} {
		if status, node := f.state(c.state); status != "waiting" || node != 2 {
			t.Fatalf("%s: day1 %s/%d", c.name, status, node)
		}
		if wake := wakeOf(c); !wake.Equal(t0.Add(4 * day)) {
			t.Fatalf("%s: 3일 대기 기상 시각 %v != %v", c.name, wake, t0.Add(4*day))
		}
	}
	if status, node := f.state(customers[1].state); status != "exited" || node != 0 {
		t.Fatalf("exit-early가 이탈 뒤 움직임: %s/%d", status, node)
	}

	// Day 2 — exit-late가 구매 → 이탈, 푸시 B 미발송.
	f.clk.Advance(day)
	event(customers[2], "purchase")
	if status, node := f.state(customers[2].state); status != "exited" || node != 2 {
		t.Fatalf("exit-late: purchase 뒤 %s/%d", status, node)
	}

	// Day 4 — 기상 → 푸시 B (complete 1명) → 완주. 여분 tick은 무해해야 한다.
	f.clk.Advance(2 * day)
	for i := 0; i < 4; i++ {
		f.tick() // wait-3d 완료 → push-b 발송 → 완주, 여분 tick
	}
	if n := sends(); n != 3 {
		t.Fatalf("day4: 총 3건(A×2, B×1) 기대, outbox=%d", n)
	}
	if status, _ := f.state(customers[0].state); status != "completed" {
		t.Fatalf("complete: %s", status)
	}

	// 발송 내용·귀속: 누구에게 무엇이 갔는지.
	want := map[string][]string{"complete": {"푸시 A — 환영합니다", "푸시 B — 다시 만나요"}, "exit-early": nil, "exit-late": {"푸시 A — 환영합니다"}}
	for _, c := range customers {
		got := sendTitles(c)
		if len(got) != len(want[c.name]) {
			t.Fatalf("%s: 발송 %v, 기대 %v", c.name, got, want[c.name])
		}
		for i := range got {
			if got[i] != want[c.name][i] {
				t.Fatalf("%s: 발송 %v, 기대 %v", c.name, got, want[c.name])
			}
		}
	}

	// 리포트 원천 정합 — 콘솔 저니 리포트(nodeReport)는 journey_node_executions를 node_id·status로 센다.
	rows, err := f.pg.Query(f.ctx, `SELECT node_id,status,count(*) FROM journey_node_executions
		WHERE tenant_id=$1 AND app_id=$2 AND journey_id=$3 GROUP BY node_id,status`, f.tenant, f.app, f.journey)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]int{}
	for rows.Next() {
		var node, status string
		var n int
		if err := rows.Scan(&node, &status, &n); err != nil {
			t.Fatal(err)
		}
		got[node+"/"+status] = n
	}
	rows.Close()
	wantReport := map[string]int{
		"wait-1d/resolved": 2, // complete·exit-late가 첫 대기를 지났다 (실행 완료 = resolved)
		"wait-1d/exited":   1, // exit-early는 첫 대기 중 이탈
		"push-a/resolved":  2,
		"wait-3d/resolved": 1, // complete만 3일 대기를 끝냈다
		"wait-3d/exited":   1, // exit-late는 3일 대기 중 이탈
		"push-b/resolved":  1,
	}
	if len(got) != len(wantReport) {
		t.Fatalf("리포트 원천에 예상 밖 행: %v", got)
	}
	for k, n := range wantReport {
		if got[k] != n {
			t.Fatalf("리포트 원천 %s = %d, 기대 %d (전체 %v)", k, got[k], n, got)
		}
	}
	// 이탈 2명은 저니 상태가 exited이고, 리포트 분모(진입 3·완주 1·이탈 2)가 맞아야 한다.
	var entered, completed, exited int
	if err := f.pg.QueryRow(f.ctx, `SELECT count(*), count(*) FILTER (WHERE status='completed'), count(*) FILTER (WHERE status='exited')
		FROM journey_states WHERE tenant_id=$1 AND journey_id=$2`, f.tenant, f.journey).Scan(&entered, &completed, &exited); err != nil {
		t.Fatal(err)
	}
	if entered != 3 || completed != 1 || exited != 2 {
		t.Fatalf("진입/완주/이탈 = %d/%d/%d, 기대 3/1/2", entered, completed, exited)
	}
}
