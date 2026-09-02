package lifecycle

import (
	"encoding/json"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/ondahq/onda/apps/worker/internal/clock"
	libqueue "github.com/ondahq/onda/packages/libqueue-go"
)

const (
	tid = "11111111-1111-1111-1111-111111111111"
	aid = "22222222-2222-2222-2222-222222222222"
	mid = "33333333-3333-3333-3333-333333333333"
	uid = "44444444-4444-4444-4444-444444444444"
	eid = "55555555-5555-5555-5555-555555555555"
)

func env(payload string) *libqueue.Envelope {
	return &libqueue.Envelope{ID: "e1", Type: "message.lifecycle", SchemaVer: 1,
		TenantID: tid, AppID: aid, Payload: json.RawMessage(payload)}
}

func recv() time.Time { return time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC) }

func build(payload string) ([]any, error) {
	return BuildRow(env(payload), json.RawMessage(payload), recv())
}

// 전체 필드가 채워진 payload → 컬럼 순서대로 행이 만들어진다.
func TestBuildRowFull(t *testing.T) {
	row, err := build(`{
		"message_id":"` + mid + `","status":"delivered","occurred_at":"2026-09-02T11:59:30.250Z",
		"source":"provider_callback","channel":"email","connector_id":"email_resend",
		"provider_message_id":"prov-9","user_id":"` + uid + `","endpoint_id":"` + eid + `",
		"failure_class":null,"failure_detail":null,"fallback_index":1,"attempt":2,
		"cost":{"currency":"USD","amount":0.0015},"click_ref":"cta-1"}`)
	if err != nil {
		t.Fatalf("BuildRow: %v", err)
	}
	want := []any{
		tid, aid, mid, "delivered", time.Date(2026, 9, 2, 11, 59, 30, 250_000_000, time.UTC),
		"provider_callback", "email", "email_resend", "prov-9", uid, eid,
		"", "", uint8(1), uint8(2), "USD", 0.0015, "cta-1", recv(),
	}
	if len(row) != len(want) {
		t.Fatalf("len=%d want %d", len(row), len(want))
	}
	for i := range want {
		if tv, ok := want[i].(time.Time); ok {
			if !row[i].(time.Time).Equal(tv) {
				t.Errorf("col %d: %v want %v", i, row[i], tv)
			}
			continue
		}
		if row[i] != want[i] {
			t.Errorf("col %d: %#v want %#v", i, row[i], want[i])
		}
	}
}

// 선택 필드 생략/null → zero UUID / ” / 0.
func TestBuildRowNulls(t *testing.T) {
	row, err := build(`{"message_id":"` + mid + `","status":"failed","occurred_at":"2026-09-02T11:59:30+09:00",
		"source":"connector","channel":"push","connector_id":"push_fcm","failure_class":"invalid_target",
		"failure_detail":"UNREGISTERED","user_id":null}`)
	if err != nil {
		t.Fatalf("BuildRow: %v", err)
	}
	if row[8] != "" || row[9] != zeroUUID || row[10] != zeroUUID {
		t.Errorf("provider/user/endpoint: %v %v %v", row[8], row[9], row[10])
	}
	if row[11] != "invalid_target" || row[12] != "UNREGISTERED" {
		t.Errorf("failure: %v %v", row[11], row[12])
	}
	if row[13] != uint8(0) || row[14] != uint8(0) || row[15] != "" || row[16] != float64(0) || row[17] != "" {
		t.Errorf("zero defaults: %v", row[13:18])
	}
	// +09:00 → UTC 정규화
	if got := row[4].(time.Time); !got.Equal(time.Date(2026, 9, 2, 2, 59, 30, 0, time.UTC)) || got.Location() != time.UTC {
		t.Errorf("occurred_at=%v", got)
	}
}

// 검증 실패 케이스 표.
func TestBuildRowRejects(t *testing.T) {
	base := func(over string) string {
		return `{"message_id":"` + mid + `","status":"sent","occurred_at":"2026-09-02T00:00:00Z",` +
			`"source":"engine","channel":"email","connector_id":"email_smtp"` + over + `}`
	}
	cases := []struct {
		name    string
		env     *libqueue.Envelope
		payload string
		wantErr string
	}{
		{"bad json", env(""), `{not json`, "payload 파싱"},
		{"message_id not uuid", env(""), strings.Replace(base(""), mid, "mid-1", 1), "message_id UUID"},
		{"status unknown", env(""), strings.Replace(base(""), `"sent"`, `"queued"`, 1), "status 불명"},
		{"source unknown", env(""), strings.Replace(base(""), `"engine"`, `"api"`, 1), "source 불명"},
		{"channel empty", env(""), strings.Replace(base(""), `"channel":"email"`, `"channel":""`, 1), "channel 누락"},
		{"connector_id bad", env(""), strings.Replace(base(""), `"email_smtp"`, `"Email-SMTP"`, 1), "connector_id"},
		{"occurred_at bad", env(""), strings.Replace(base(""), `2026-09-02T00:00:00Z`, `yesterday`, 1), "occurred_at"},
		{"user_id bad", env(""), base(`,"user_id":"u1"`), "user_id UUID"},
		{"endpoint_id bad", env(""), base(`,"endpoint_id":"d1"`), "endpoint_id UUID"},
		{"tenant not uuid", &libqueue.Envelope{TenantID: "t1", AppID: aid}, base(""), "tenant_id"},
		{"app not uuid", &libqueue.Envelope{TenantID: tid, AppID: "a1"}, base(""), "app_id"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := BuildRow(tc.env, json.RawMessage(tc.payload), recv())
			if err == nil {
				t.Fatal("오류 기대")
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("err=%v want contains %q", err, tc.wantErr)
			}
		})
	}
}

// UInt8 컬럼: 음수→0, 255 초과→255 클램프.
func TestOptUint8(t *testing.T) {
	neg, big, ok := -1, 300, 7
	if optUint8(nil) != 0 || optUint8(&neg) != 0 || optUint8(&big) != 255 || optUint8(&ok) != 7 {
		t.Error("optUint8 클램프 불일치")
	}
}

// 배치: 불량 행은 skip하되 ACK 대상에는 포함, 정상 행만 적재 대상. received_at은 주입 시계.
func TestBuildRowsSkipsInvalidButAcks(t *testing.T) {
	fk := &clock.Fake{Current: recv()}
	c := NewConsumer(nil, nil, fk, slog.New(slog.NewTextHandler(io.Discard, nil)))
	good := `{"message_id":"` + mid + `","status":"opened","occurred_at":"2026-09-02T00:00:00Z",
		"source":"sdk","channel":"push","connector_id":"push_apns"}`
	msgs := []libqueue.Message{
		{StreamID: "1-0", Envelope: *env(good)},
		{StreamID: "1-1", Envelope: *env(`{"message_id":"nope"}`)},
		{StreamID: "1-2", Envelope: *env(good)},
	}
	rows, acks := c.buildRows(msgs)
	if len(rows) != 2 {
		t.Fatalf("rows=%d want 2", len(rows))
	}
	if len(acks) != 3 || acks[1] != "1-1" {
		t.Fatalf("acks=%v want 3 incl. invalid", acks)
	}
	if !rows[0][18].(time.Time).Equal(recv()) {
		t.Errorf("received_at=%v want %v", rows[0][18], recv())
	}
}
