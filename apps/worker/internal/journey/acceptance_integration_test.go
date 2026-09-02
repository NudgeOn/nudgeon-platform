package journey

import (
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/google/uuid"
	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/segment"
)

// The product acceptance graph uses one shared thank-you node and two exclusive
// reminder variants. Real CH history decides the branch; fake time drives waits.
func TestRuntimePurchaseFollowupThreeCustomerPaths(t *testing.T) {
	chURL := os.Getenv("NUDGEON_JOURNEY_TEST_CLICKHOUSE_URL")
	if chURL == "" {
		t.Skip("set NUDGEON_JOURNEY_TEST_CLICKHOUSE_URL")
	}
	def := testGraph([]Node{
		{ID: "recent-purchase", Type: "branch", Condition: &segment.DSL{Version: 1, Operator: "AND", Groups: []segment.Group{{Operator: "AND", Conditions: []segment.Condition{
			{Type: "event", Event: "purchase", Op: "performed"}, // Default lookback is 30 days.
		}}}}},
		{ID: "wait-purchase", Type: "event_wait", EventName: "purchase", TimeoutSeconds: 10},
		testMessage("thank-you", "구매해 주셔서 감사합니다"),
		{ID: "reminder-test", Type: "ab_split", Variants: []Variant{{ID: "a", Label: "A", Weight: 50}, {ID: "b", Label: "B", Weight: 50}}},
		testMessage("reminder-a", "다시 만나고 싶어요 A"), testMessage("reminder-b", "다시 만나고 싶어요 B"),
	}, []Edge{
		testEdge("recent-purchase", "true", "thank-you"), testEdge("recent-purchase", "false", "wait-purchase"),
		testEdge("wait-purchase", "matched", "thank-you"), testEdge("wait-purchase", "timeout", "reminder-test"),
		testEdge("thank-you", "next", ""), testEdge("reminder-test", "a", "reminder-a"), testEdge("reminder-test", "b", "reminder-b"),
		testEdge("reminder-a", "next", ""), testEdge("reminder-b", "next", ""),
	}, "recent-purchase")
	f := newRuntimeFixture(t, def)
	opts, err := clickhouse.ParseDSN(chURL)
	if err != nil {
		t.Fatal(err)
	}
	ch, err := clickhouse.Open(opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ch.Close() })
	f.s.ch = ch
	customers := []struct{ name, user, device, state string }{
		{name: "already-purchased", user: f.user, device: f.device},
		{name: "purchase-while-waiting", user: uuid.NewString(), device: uuid.NewString()},
		{name: "timeout", user: uuid.NewString(), device: uuid.NewString()},
	}
	for _, customer := range customers[1:] {
		f.exec(`INSERT INTO users(id,tenant_id,app_id,subscriptions) VALUES($1,$2,$3,'{"push":"opted_in"}')`, customer.user, f.tenant, f.app)
		f.exec(`INSERT INTO devices(id,tenant_id,app_id,user_id,platform,push_token,os_permission)
			VALUES($1,$2,$3,$4,'android',$5,'granted')`, customer.device, f.tenant, f.app, customer.user, "test-"+customer.name)
	}
	projectPurchase := func(customerIndex int, at time.Time) {
		t.Helper()
		f.user, f.device = customers[customerIndex].user, customers[customerIndex].device
		event := f.receipt("purchase", at, true)
		var payload struct {
			InsertID string `json:"insert_id"`
		}
		if err := json.Unmarshal(event.Envelope.Payload, &payload); err != nil {
			t.Fatal(err)
		}
		if err := ch.Exec(f.ctx, `INSERT INTO events(tenant_id,app_id,event_name,user_id,device_id,properties,client_ts,server_ts,insert_id)
			VALUES(?,?,'purchase',?,?,'{}',?,?,?)`, f.tenant, f.app, f.user, f.device, at, at, payload.InsertID); err != nil {
			t.Fatal(err)
		}
		if err := f.s.HandleEvent(f.ctx, event); err != nil {
			t.Fatal(err)
		}
	}
	projectPurchase(0, f.clk.Now().Add(-24*time.Hour))
	projectPurchase(2, f.clk.Now().Add(-31*24*time.Hour)) // An old purchase must not satisfy the recent condition or the new wait.
	for i := range customers {
		f.user = customers[i].user
		customers[i].state = f.admit(customers[i].name, 1)
	}
	f.tick() // Evaluate all three real ClickHouse conditions.
	f.tick() // Thank the existing buyer and register two waits.
	if f.count("journey_outbox") != 1 {
		t.Fatal("initial condition sent a reminder or missed the existing buyer")
	}
	f.clk.Advance(5 * time.Second)
	projectPurchase(1, f.clk.Now())
	f.tick()
	f.tick()
	if f.count("journey_outbox") != 2 {
		t.Fatal("purchase during the wait did not send exactly one thank-you")
	}
	f.clk.Advance(5 * time.Second)
	for i := 0; i < 5; i++ {
		f.tick() // Timeout, stable variant selection, reminder, and harmless extra ticks.
	}
	if f.count("journey_outbox") != 3 {
		t.Fatal("three customers did not produce exactly three send intents")
	}
	for i, customer := range customers {
		if status, _ := f.state(customer.state); status != "completed" {
			t.Fatalf("%s: state %s", customer.name, status)
		}
		want := map[string]string{"recent-purchase": "true", "thank-you": "next"}
		wantTitle := "구매해 주셔서 감사합니다"
		if i == 1 {
			want["recent-purchase"], want["wait-purchase"] = "false", "matched"
		}
		if i == 2 {
			_, variant, _ := f.execution(customer.state, 3)
			if variant != "a" && variant != "b" {
				t.Fatalf("timeout chose invalid variant %q", variant)
			}
			want = map[string]string{"recent-purchase": "false", "wait-purchase": "timeout", "reminder-test": variant, "reminder-" + variant: "next"}
			wantTitle = "다시 만나고 싶어요 A"
			if variant == "b" {
				wantTitle = "다시 만나고 싶어요 B"
			}
		}
		rows, err := f.pg.Query(f.ctx, `SELECT node_id,status,COALESCE(output_port,'') FROM journey_node_executions
			WHERE tenant_id=$1 AND app_id=$2 AND state_id=$3 ORDER BY node_index`, f.tenant, f.app, customer.state)
		if err != nil {
			t.Fatal(err)
		}
		path := []string{}
		for rows.Next() {
			var node, status, port string
			if err := rows.Scan(&node, &status, &port); err != nil {
				t.Fatal(err)
			}
			wantPort, visited := want[node]
			if !visited || status != "resolved" || port != wantPort {
				t.Errorf("%s: unexpected execution %s %s %s", customer.name, node, status, port)
			}
			path = append(path, node+":"+port)
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		rows.Close()
		if len(path) != len(want) {
			t.Fatalf("%s: path %v expected %v", customer.name, path, want)
		}
		var count, identities int
		var title string
		if err := f.pg.QueryRow(f.ctx, `SELECT count(*),count(DISTINCT idempotency_key),min(payload->'content'->'push'->>'title')
			FROM journey_outbox WHERE tenant_id=$1 AND app_id=$2 AND stream='stream:send.push' AND payload->>'user_id'=$3`,
			f.tenant, f.app, customer.user).Scan(&count, &identities, &title); err != nil {
			t.Fatal(err)
		}
		if count != 1 || identities != 1 || title != wantTitle {
			t.Fatalf("%s: sends=%d keys=%d title=%q", customer.name, count, identities, title)
		}
		t.Logf("%s: %v; one send intent %q", customer.name, path, title)
	}
}
