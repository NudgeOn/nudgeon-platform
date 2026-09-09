package channel

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/redis/go-redis/v9"

	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/clock"
	libqueue "github.com/nudgeon/nudgeon-platform/packages/libqueue-go"
)

// pushFakeStore — PushWorker가 PG에 요구하는 세 쿼리를 포착하는 가짜 저장소:
// 크리덴셜 조회(QueryRow SELECT), 토큰 invalid 반영(QueryRow UPDATE devices … RETURNING),
// 크리덴셜 error 전환·send_dlq INSERT(Exec).
type pushFakeStore struct {
	ciphertext, dekWrap []byte
	noCred              bool
	credQueries         int
	credArgs            []any
	deviceUpdates       int
	deviceArgs          []any
	deviceNoRows        bool
	execs               []string
	execArgs            [][]any
}

type pushFakeRow struct {
	s    *pushFakeStore
	kind string
	err  error
}

func (r pushFakeRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	switch r.kind {
	case "cred":
		*dest[0].(*[]byte) = r.s.ciphertext
		*dest[1].(*[]byte) = r.s.dekWrap
	case "device":
		*dest[0].(*string) = "dev-1"
		*dest[1].(*string) = "user-1"
		*dest[2].(*string) = "android"
	}
	return nil
}

func (s *pushFakeStore) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	if strings.Contains(sql, "UPDATE devices") {
		s.deviceUpdates++
		s.deviceArgs = args
		if s.deviceNoRows {
			return pushFakeRow{err: pgx.ErrNoRows}
		}
		return pushFakeRow{s: s, kind: "device"}
	}
	s.credQueries++
	s.credArgs = args
	if s.noCred {
		return pushFakeRow{err: pgx.ErrNoRows}
	}
	return pushFakeRow{s: s, kind: "cred"}
}

func (s *pushFakeStore) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	s.execs = append(s.execs, sql)
	s.execArgs = append(s.execArgs, args)
	return pgconn.NewCommandTag("INSERT 0 1"), nil
}

func (s *pushFakeStore) execsMatching(sub string) int {
	n := 0
	for _, q := range s.execs {
		if strings.Contains(q, sub) {
			n++
		}
	}
	return n
}

func newPushStore(t *testing.T, masterKey []byte, credJSON string) *pushFakeStore {
	t.Helper()
	dek := make([]byte, 32)
	for i := range dek {
		dek[i] = byte(200 - i)
	}
	return &pushFakeStore{
		ciphertext: sealForTest(t, dek, []byte(credJSON)),
		dekWrap:    sealForTest(t, masterKey, dek),
	}
}

func pushMsg(t *testing.T, mutate func(*SendPushPayload)) *libqueue.Message {
	t.Helper()
	p := SendPushPayload{
		IdempotencyKey: "idem-push-1", MessageID: "mid-push-1", UserID: "u1", DeviceID: "d1",
		PushToken: "tok-1", Platform: "android", Category: "marketing",
	}
	p.Content.Push = &PushContent{Title: "T", Body: "B"}
	if mutate != nil {
		mutate(&p)
	}
	raw, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	return &libqueue.Message{
		StreamID: "1-0",
		Envelope: libqueue.Envelope{ID: "env-1", Type: "send.push", TenantID: "t1", AppID: "a1", Payload: raw},
	}
}

func newPushLoop(t *testing.T, store *pushFakeStore, masterKey []byte, plugin *mockPlugin) (*PushWorker, *SendLoop[*PushJob], *miniredis.Miniredis, *clock.Fake) {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	fk := &clock.Fake{Current: mustTime()}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	var pg pushStore
	if store != nil {
		pg = store
	}
	h := NewPushWorker(pg, nil, plugin, masterKey, fk, logger)
	return h, NewSendLoop[*PushJob]("push-test", h, nil, rdb, nil, fk, logger), mr, fk
}

// 이관 후에도 PG 크리덴셜을 복호화해 플러그인에 넘기고, 플랫폼이 크리덴셜 종류(FCM/APNs)를 고른다.
// 두 번째 발송은 10분 캐시를 써서 PG를 다시 조회하지 않는다.
func TestPushResolveDecryptsByPlatformAndCaches(t *testing.T) {
	master := testMasterKey()
	store := newPushStore(t, master, `{"project_id":"p"}`)
	plugin := &mockPlugin{}
	_, loop, _, _ := newPushLoop(t, store, master, plugin)

	row, retry := loop.handleOne(context.Background(), pushMsg(t, func(p *SendPushPayload) { p.Platform = "ios" }))
	if retry || row == nil || row[11] != "sent" {
		t.Fatalf("sent 기대, got row=%v retry=%v", row, retry)
	}
	if store.credArgs[1] != "push_apns" {
		t.Fatalf("iOS는 push_apns 크리덴셜 기대, got %v", store.credArgs)
	}
	if plugin.lastReq.Credentials.Kind != "push_apns" || string(plugin.lastReq.Credentials.JSON) != `{"project_id":"p"}` {
		t.Fatalf("복호화된 크리덴셜 전달 기대, got %+v", plugin.lastReq.Credentials)
	}
	if row[10] != "push_apns" || row[15] != "prov-1" || row[2] != "mid-push-1" {
		t.Fatalf("channel/provider_message_id/message_id 행 계약 불일치: %v", row)
	}
	if plugin.lastReq.Content.Push.MessageID != "mid-push-1" {
		t.Fatalf("푸시 data에 message_id 주입 기대, got %q", plugin.lastReq.Content.Push.MessageID)
	}

	loop.handleOne(context.Background(), pushMsg(t, func(p *SendPushPayload) { p.Platform = "ios"; p.IdempotencyKey = "idem-push-2" }))
	if store.credQueries != 1 {
		t.Fatalf("캐시 적중으로 PG 조회 1회 기대, got %d", store.credQueries)
	}
	if plugin.sends != 2 {
		t.Fatalf("Send 2회 기대, got %d", plugin.sends)
	}
}

// 크리덴셜 미등록은 장애가 아니므로 재시도 없이 종결하고, 행 detail에 어떤 종류가 없는지 남긴다.
func TestPushCredentialMissingTerminal(t *testing.T) {
	store := &pushFakeStore{noCred: true}
	plugin := &mockPlugin{}
	_, loop, mr, _ := newPushLoop(t, store, testMasterKey(), plugin)

	row, retry := loop.handleOne(context.Background(), pushMsg(t, nil))
	if retry || row == nil || row[11] != "failed" || row[12] != "credential_missing" {
		t.Fatalf("credential_missing 종결 기대, got row=%v retry=%v", row, retry)
	}
	if row[13] != "push_fcm 크리덴셜 미등록/미검증" {
		t.Fatalf("detail에 크리덴셜 종류 기대, got %v", row[13])
	}
	if plugin.sends != 0 {
		t.Fatal("크리덴셜 없이 Send 호출됨")
	}
	if v, _ := mr.Get("send:idem:t1:idem-push-1"); v != statusFailed+"|credential_missing" {
		t.Fatalf("상태 failed|credential_missing 커밋 기대, got %q", v)
	}
}

// invalid_target(UNREGISTERED/410): 토큰 피드백 루프 — devices invalid 반영(C-5). 재시도 없음.
func TestPushInvalidTargetInvalidatesToken(t *testing.T) {
	master := testMasterKey()
	store := newPushStore(t, master, `{}`)
	plugin := &mockPlugin{sendErr: NewSendError(FailureInvalidTarget, "UNREGISTERED")}
	_, loop, _, _ := newPushLoop(t, store, master, plugin)

	row, retry := loop.handleOne(context.Background(), pushMsg(t, nil))
	if retry || row == nil || row[11] != "failed" || row[12] != "invalid_target" {
		t.Fatalf("invalid_target 종결 기대, got row=%v retry=%v", row, retry)
	}
	if store.deviceUpdates != 1 || store.deviceArgs[0] != "a1" || store.deviceArgs[1] != "tok-1" {
		t.Fatalf("devices invalid UPDATE(app, token) 1회 기대, got %d %v", store.deviceUpdates, store.deviceArgs)
	}
	if store.execsMatching("UPDATE credentials") != 0 {
		t.Fatal("invalid_target이 크리덴셜을 error로 바꿈")
	}
	// 재전달: 종결 결과 재기록만, 부수효과·재전송 없음
	loop.handleOne(context.Background(), pushMsg(t, nil))
	if store.deviceUpdates != 1 || plugin.sends != 1 {
		t.Fatalf("재전달 시 부수효과/재전송 없어야 함: updates=%d sends=%d", store.deviceUpdates, plugin.sends)
	}
}

// credential_auth(401/403): 크리덴셜 error 전환 + 메모리 캐시 무효화(C-8) → 다음 건은 PG를 다시 본다.
func TestPushCredentialAuthMarksCredentialError(t *testing.T) {
	master := testMasterKey()
	store := newPushStore(t, master, `{}`)
	plugin := &mockPlugin{sendErr: NewSendError(FailureCredentialAuth, "403 SENDER_ID_MISMATCH")}
	h, loop, _, _ := newPushLoop(t, store, master, plugin)

	row, retry := loop.handleOne(context.Background(), pushMsg(t, nil))
	if retry || row == nil || row[12] != "credential_auth" {
		t.Fatalf("credential_auth 종결 기대, got row=%v retry=%v", row, retry)
	}
	if n := store.execsMatching("UPDATE credentials SET status = 'error'"); n != 1 {
		t.Fatalf("크리덴셜 error 전환 1회 기대, got %d", n)
	}
	args := store.execArgs[len(store.execArgs)-1]
	if args[0] != "a1" || args[1] != "push_fcm" || !strings.Contains(args[2].(string), "SENDER_ID_MISMATCH") {
		t.Fatalf("error 전환 인자 불일치: %v", args)
	}
	if _, cached := h.credCache["a1/push_fcm"]; cached {
		t.Fatal("크리덴셜 캐시가 무효화되지 않음")
	}
	loop.handleOne(context.Background(), pushMsg(t, func(p *SendPushPayload) { p.IdempotencyKey = "idem-push-2" }))
	if store.credQueries != 2 {
		t.Fatalf("캐시 무효화 후 PG 재조회 기대, got %d", store.credQueries)
	}
}

// retryable 5회 소진 → send_dlq에 원본 envelope과 함께 적재(이관 전 사본과 같은 계약), 상태 failed 커밋.
func TestPushRetryExhaustionLandsInDLQ(t *testing.T) {
	master := testMasterKey()
	store := newPushStore(t, master, `{}`)
	plugin := &mockPlugin{sendErr: NewSendError(FailureRetryable, "503")}
	_, loop, mr, fk := newPushLoop(t, store, master, plugin)
	ctx := context.Background()
	m := pushMsg(t, nil)

	var row []any
	var retry bool
	for i := 1; i <= maxSendAttempts; i++ {
		row, retry = loop.handleOne(ctx, m)
		fk.Advance(backoffCap + time.Second)
	}
	if retry || row == nil || row[11] != "failed" || row[12] != "retryable_exhausted" {
		t.Fatalf("소진 종결 기대, got row=%v retry=%v", row, retry)
	}
	if plugin.sends != maxSendAttempts {
		t.Fatalf("Send %d회 기대, got %d", maxSendAttempts, plugin.sends)
	}
	if n := store.execsMatching("INSERT INTO send_dlq"); n != 1 {
		t.Fatalf("send_dlq INSERT 1회 기대, got %d (execs=%v)", n, store.execs)
	}
	args := store.execArgs[len(store.execArgs)-1]
	if args[0] != "t1" || args[1] != "a1" || args[2] != "idem-push-1" {
		t.Fatalf("DLQ 행 (tenant, app, idem) 불일치: %v", args)
	}
	var envJSON []byte
	for _, a := range args {
		if b, ok := a.([]byte); ok && strings.Contains(string(b), `"tenant_id":"t1"`) {
			envJSON = b
		}
	}
	if envJSON == nil {
		t.Fatalf("DLQ 행에 원본 envelope 기대: %v", args)
	}
	var env libqueue.Envelope
	if err := json.Unmarshal(envJSON, &env); err != nil || env.ID != "env-1" || env.Type != "send.push" {
		t.Fatalf("DLQ envelope 복원 실패: err=%v env=%+v", err, env)
	}
	if v, _ := mr.Get("send:idem:t1:idem-push-1"); v != statusFailed+"|retryable_exhausted" {
		t.Fatalf("상태 failed|retryable_exhausted 기대, got %q", v)
	}
}

// 불량 payload(멱등 키·push 콘텐츠 없음)는 재처리해도 무의미하므로 ACK하고 버린다.
func TestPushMalformedPayloadSkipped(t *testing.T) {
	plugin := &mockPlugin{}
	_, loop, _, _ := newPushLoop(t, nil, nil, plugin)
	m := pushMsg(t, nil)
	m.Envelope.Payload = []byte(`{"idempotency_key":"x"}`)
	if row, retry := loop.handleOne(context.Background(), m); row != nil || retry {
		t.Fatalf("skip(nil,false) 기대, got row=%v retry=%v", row, retry)
	}
	if plugin.sends != 0 {
		t.Fatal("불량 payload로 Send 호출됨")
	}
}
