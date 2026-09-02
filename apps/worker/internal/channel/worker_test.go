package channel

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"

	"github.com/ondahq/onda/apps/worker/internal/clock"
	libqueue "github.com/ondahq/onda/packages/libqueue-go"
)

// mockPlugin — Send 오류를 제어하고 마지막 요청·호출 수를 포착하는 최소 플러그인.
type mockPlugin struct {
	sendErr error
	lastReq *SendRequest
	sends   int // 실제 Send 호출 수 (재전송 없음 검증용)
}

func (m *mockPlugin) Kind() ChannelKind      { return KindPush }
func (m *mockPlugin) TargetType() TargetType { return TargetDeviceToken }
func (m *mockPlugin) ValidateCredentials(context.Context, Credentials) error {
	return nil
}
func (m *mockPlugin) Send(_ context.Context, req SendRequest) (SendResult, error) {
	r := req
	m.lastReq = &r
	m.sends++
	return SendResult{ProviderID: "prov-1"}, m.sendErr
}
func (m *mockPlugin) ClassifyError(err error) FailureClass { return Classify(err) }
func (m *mockPlugin) HandleCallback(context.Context, []byte) ([]DeliveryUpdate, error) {
	return nil, nil
}

func newTestWorker(t *testing.T, sendErr error) (*Worker, *miniredis.Miniredis, *clock.Fake) {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	fk := &clock.Fake{Current: mustTime()}
	w := &Worker{
		rdb:       rdb,
		plugin:    &mockPlugin{sendErr: sendErr},
		clk:       fk,
		logger:    slog.New(slog.NewTextHandler(io.Discard, nil)),
		credCache: map[string]cachedCred{},
	}
	// verified 크리덴셜을 캐시에 심어 pg 조회를 우회 (pg=nil)
	w.storeCredCache("a1/push_fcm", Credentials{Kind: "push_fcm", JSON: []byte("{}")}, true, w.clk.Now())
	return w, mr, fk
}

func mustTime() time.Time { return time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC) }

func testMsg() *libqueue.Message {
	p := SendPushPayload{
		IdempotencyKey: "idem-1", MessageID: "mid-1", UserID: "u1", DeviceID: "d1",
		PushToken: "tok", Platform: "android", Category: "marketing",
	}
	p.Content.Push = &PushContent{}
	raw, _ := json.Marshal(p)
	return &libqueue.Message{
		StreamID: "1-0",
		Envelope: libqueue.Envelope{TenantID: "t1", AppID: "a1", Payload: raw},
	}
}

// message_id 계약: payload의 message_id가 (1) message_log 행에, (2) 푸시 data(onda.message_id)에
// 동일하게 흐른다 — 발송↔SDK 도달/오픈 연결 (재검증 F).
func TestHandleOneMessageIDContract(t *testing.T) {
	w, _, _ := newTestWorker(t, nil)
	mp := w.plugin.(*mockPlugin)
	ctx := context.Background()

	row, retry := w.handleOne(ctx, testMsg())
	if retry || row == nil {
		t.Fatalf("전송 성공 기대, got row=%v retry=%v", row, retry)
	}
	// (1) message_log 행의 message_id(row[2]) == payload message_id
	if row[2] != "mid-1" {
		t.Errorf("message_log message_id: mid-1 기대, got %v", row[2])
	}
	// (2) 렌더에 message_id 전달 — FCM data["message_id"]/APNs onda.message_id로 방출됨(공통 계약 R-01)
	if mp.lastReq == nil || mp.lastReq.Content.Push == nil ||
		mp.lastReq.Content.Push.MessageID != "mid-1" {
		t.Errorf("푸시 MessageID: mid-1 기대, got %v", mp.lastReq)
	}
}

// retryable 실패는 ACK하지 않고(백오프 후 재시도) 리스를 해제. 상한 초과 시 소진 종결.
// 백오프 때문에 재시도 사이에 시계를 전진시켜야 다음 처리가 미뤄지지 않는다.
func TestHandleOneRetryableThenExhaust(t *testing.T) {
	w, mr, fk := newTestWorker(t, NewSendError(FailureRetryable, "5xx 일시 오류"))
	ctx := context.Background()
	m := testMsg()

	for i := 1; i < maxSendAttempts; i++ {
		row, retry := w.handleOne(ctx, m)
		if !retry || row != nil {
			t.Fatalf("시도 %d: 재시도(nil,true) 기대, got row=%v retry=%v", i, row, retry)
		}
		if mr.Exists("send:idem:t1:idem-1") {
			t.Fatalf("시도 %d: 멱등 리스가 해제되지 않음", i)
		}
		if !mr.Exists("send:retryat:t1:idem-1") {
			t.Fatalf("시도 %d: 백오프 retryat 미설정", i)
		}
		fk.Advance(backoffCap + time.Second)                                                               // 백오프 경과 시뮬
		w.storeCredCache("a1/push_fcm", Credentials{Kind: "push_fcm", JSON: []byte("{}")}, true, fk.Now()) // 크리덴셜 캐시 갱신(pg 우회)
	}

	// 상한 도달 → 소진 종결(ACK), failed/retryable_exhausted 기록, 상태=failed 커밋
	row, retry := w.handleOne(ctx, m)
	if retry || row == nil || row[11] != "failed" || row[12] != "retryable_exhausted" {
		t.Fatalf("소진: failed/retryable_exhausted 종결 기대, got row=%v retry=%v", row, retry)
	}
	if v, _ := mr.Get("send:idem:t1:idem-1"); v != statusFailed+"|retryable_exhausted" {
		t.Fatalf("소진: 상태 failed 커밋 기대, got %q", v)
	}
}

// 백오프 대기 중에는 처리를 미룬다(리스 없이, Send 호출 없음). 경과 후 처리.
func TestHandleOneBackoffDefers(t *testing.T) {
	w, mr, fk := newTestWorker(t, NewSendError(FailureRetryable, "5xx"))
	mp := w.plugin.(*mockPlugin)
	ctx := context.Background()
	m := testMsg()

	// 1차: retryable → retryat 설정, Send 1회
	if _, retry := w.handleOne(ctx, m); !retry {
		t.Fatal("1차 재시도 기대")
	}
	if mp.sends != 1 {
		t.Fatalf("Send 1회 기대, got %d", mp.sends)
	}
	// 시계 전진 없이 재호출 → 백오프 대기로 defer, Send 호출 안 됨
	row, retry := w.handleOne(ctx, m)
	if !retry || row != nil {
		t.Fatalf("백오프 defer 기대(nil,true), got row=%v retry=%v", row, retry)
	}
	if mp.sends != 1 {
		t.Fatalf("백오프 중 재전송 없어야 함, sends=%d", mp.sends)
	}
	if mr.Exists("send:idem:t1:idem-1") {
		t.Fatal("defer 시 리스를 잡지 않아야 함")
	}
	// 백오프 경과 후 → 처리(Send 2회째)
	fk.Advance(backoffCap + time.Second)
	w.storeCredCache("a1/push_fcm", Credentials{Kind: "push_fcm", JSON: []byte("{}")}, true, fk.Now())
	if _, retry := w.handleOne(ctx, m); !retry {
		t.Fatal("경과 후 재처리 기대")
	}
	if mp.sends != 2 {
		t.Fatalf("경과 후 Send 2회 기대, got %d", mp.sends)
	}
}

// 전송 성공 후 재전달: 재전송 없이 sent를 재기록(결과 보존 — CH 로그 flush 실패 복구, R-02).
func TestHandleOneSentThenReemitSent(t *testing.T) {
	w, mr, _ := newTestWorker(t, nil)
	mp := w.plugin.(*mockPlugin)
	ctx := context.Background()
	m := testMsg()

	row, retry := w.handleOne(ctx, m)
	if retry || row == nil || row[11] != "sent" {
		t.Fatalf("전송 성공 기대(sent), got row=%v retry=%v", row, retry)
	}
	if v, _ := mr.Get("send:idem:t1:idem-1"); v != statusSent+"|prov-1" {
		t.Fatalf("상태 sent|prov-1 기대, got %q", v)
	}
	// sent 행은 provider_message_id(row[15])에 공급자 ID를 싣는다(콜백 조인 키)
	if row[15] != "prov-1" {
		t.Errorf("provider_message_id=prov-1 기대, got %v", row[15])
	}

	// 재전달 → 재전송 없이 sent 재기록(provider_id 보존), duplicate 아님
	row2, retry2 := w.handleOne(ctx, m)
	if retry2 || row2 == nil || row2[11] != "sent" {
		t.Fatalf("재전달은 sent 재기록 기대, got row=%v", row2)
	}
	if mp.sends != 1 {
		t.Fatalf("재전달 시 재전송 없어야 함, sends=%d", mp.sends)
	}
	if row2[13] != "provider_id=prov-1" || row2[15] != "prov-1" {
		t.Errorf("provider_id 보존 기대, got detail=%v provider_message_id=%v", row2[13], row2[15])
	}
}

// 공통 발송 계약(R-01): FCM 평면 data(Android 파서) / APNs 중첩 onda(iOS NSE) 정확 방출.
func TestPushContractPayloads(t *testing.T) {
	c := &PushContent{
		Title: "T", Body: "B", DeepLink: "onda://p/1", ImageURL: "https://x/i.png",
		MessageID: "mid-9", Data: map[string]string{"k": "v"},
	}

	// --- FCM (Android): data-only 평면 키 ---
	fd := fcmData(c)
	if fd["message_id"] != "mid-9" || fd["title"] != "T" || fd["body"] != "B" ||
		fd["deep_link"] != "onda://p/1" || fd["image_url"] != "https://x/i.png" {
		t.Errorf("FCM data 평면 키 불일치: %v", fd)
	}
	if fd["data"] != `{"k":"v"}` {
		t.Errorf("FCM data[\"data\"] JSON 문자열 기대: %q", fd["data"])
	}
	if _, bad := fd["onda.message_id"]; bad {
		t.Error("FCM에 잘못된 onda.message_id 키가 남음")
	}

	// --- APNs (iOS): 중첩 onda ---
	ap := apnsPayload(c)
	onda, ok := ap["onda"].(map[string]any)
	if !ok || onda["message_id"] != "mid-9" || onda["deep_link"] != "onda://p/1" ||
		onda["image_url"] != "https://x/i.png" {
		t.Errorf("APNs onda 중첩 불일치: %v", ap["onda"])
	}
	aps, _ := ap["aps"].(map[string]any)
	if aps["mutable-content"] != 1 {
		t.Errorf("APNs mutable-content=1 기대: %v", aps["mutable-content"])
	}
	// 커스텀 data는 onda["data"] 중첩 (iOS PushPayload.parse가 읽는 위치), 최상위 아님
	od, _ := onda["data"].(map[string]any)
	if od["k"] != "v" {
		t.Errorf("APNs onda[\"data\"] 중첩 기대: %v", onda["data"])
	}
	if _, top := ap["k"]; top {
		t.Error("APNs 최상위에 커스텀 data가 남음 (onda.data로 중첩되어야 함)")
	}
	if _, bad := ap["onda.message_id"]; bad {
		t.Error("APNs 최상위에 평면 onda.message_id 키가 남음")
	}
}

// 영구 실패(잘못된 콘텐츠)는 재시도하지 않고 종결.
func TestHandleOnePermanentTerminal(t *testing.T) {
	w, _, _ := newTestWorker(t, NewSendError(FailurePermanentContent, "잘못된 payload"))
	ctx := context.Background()
	row, retry := w.handleOne(ctx, testMsg())
	if retry {
		t.Fatal("영구 실패는 종결(retry=false) 기대")
	}
	if row == nil || row[11] != "failed" || row[12] != "permanent_content" {
		t.Fatalf("failed/permanent_content 기대, got %v", row)
	}
	if row[15] != "" {
		t.Errorf("실패 행의 provider_message_id는 '' 기대, got %v", row[15])
	}
}
