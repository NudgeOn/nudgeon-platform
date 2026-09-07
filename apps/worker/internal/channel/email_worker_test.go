package channel

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/redis/go-redis/v9"

	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/clock"
	libqueue "github.com/nudgeon/nudgeon-platform/packages/libqueue-go"
)

// emailFakeStore — 크리덴셜 한 행을 돌려주고 send_dlq INSERT를 포착하는 가짜 PG.
type emailFakeStore struct {
	kind                string
	ciphertext, dekWrap []byte
	noCred              bool
	dlqCalls            int
	dlqArgs             []any
	lastCredQuery       string
	lastCredArgs        []any
}

type emailFakeRow struct {
	s   *emailFakeStore
	err error
}

func (r emailFakeRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	*dest[0].(*string) = r.s.kind
	*dest[1].(*[]byte) = r.s.ciphertext
	*dest[2].(*[]byte) = r.s.dekWrap
	return nil
}

func (s *emailFakeStore) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	s.lastCredQuery, s.lastCredArgs = sql, args
	if s.noCred {
		return emailFakeRow{err: pgx.ErrNoRows}
	}
	return emailFakeRow{s: s}
}

func (s *emailFakeStore) Exec(_ context.Context, _ string, args ...any) (pgconn.CommandTag, error) {
	s.dlqCalls++
	s.dlqArgs = args
	return pgconn.NewCommandTag("INSERT 0 1"), nil
}

func newEmailStore(t *testing.T, masterKey []byte, kind string, credJSON string) *emailFakeStore {
	t.Helper()
	dek := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, dek); err != nil {
		t.Fatal(err)
	}
	return &emailFakeStore{
		kind:       kind,
		ciphertext: sealForTest(t, dek, []byte(credJSON)),
		dekWrap:    sealForTest(t, masterKey, dek),
	}
}

func emailMsg(t *testing.T, mutate func(*SendEmailPayload)) *libqueue.Message {
	t.Helper()
	p := SendEmailPayload{
		IdempotencyKey: "idem-email-1", MessageID: uuid.NewString(),
		UserID: uuid.NewString(), Email: "to@example.com", Category: "marketing",
	}
	p.Content.Email = &EmailContent{Subject: "hi", HTML: "<p>hi</p>"}
	if mutate != nil {
		mutate(&p)
	}
	raw, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	return &libqueue.Message{
		StreamID: "1-0",
		Envelope: libqueue.Envelope{ID: uuid.NewString(), TenantID: "t1", AppID: "a1", Payload: raw},
	}
}

func newEmailLoop(t *testing.T, store *emailFakeStore, masterKey []byte, plugin *mockPlugin) (*SendLoop[*EmailJob], *miniredis.Miniredis, *clock.Fake) {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	fk := &clock.Fake{Current: mustTime()}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	h := NewEmailWorker(store, plugin, masterKey, logger)
	return NewSendLoop[*EmailJob]("email-test", h, nil, rdb, nil, fk, logger), mr, fk
}

func testMasterKey() []byte {
	k := make([]byte, 32)
	for i := range k {
		k[i] = byte(i)
	}
	return k
}

// 정상 발송: 크리덴셜이 복호화돼 플러그인에 전달되고, message_id가 본문과 로그 행에 같은 값으로 흐른다.
func TestEmailSendCarriesCredentialAndMessageID(t *testing.T) {
	key := testMasterKey()
	store := newEmailStore(t, key, "email_resend", `{"api_key":"re_test"}`)
	plugin := &mockPlugin{}
	loop, mr, _ := newEmailLoop(t, store, key, plugin)
	m := emailMsg(t, nil)

	row, retry := loop.handleOne(context.Background(), m)
	if retry || row == nil {
		t.Fatalf("정상 발송인데 row=%v retry=%v", row, retry)
	}
	if plugin.sends != 1 || plugin.lastReq == nil {
		t.Fatalf("플러그인 Send 1회 기대, got %d", plugin.sends)
	}
	if plugin.lastReq.Credentials.Kind != "email_resend" || string(plugin.lastReq.Credentials.JSON) != `{"api_key":"re_test"}` {
		t.Fatalf("복호화된 크리덴셜이 플러그인에 전달되지 않음: %+v", plugin.lastReq.Credentials)
	}
	if plugin.lastReq.Target.Token != "to@example.com" {
		t.Fatalf("수신 주소가 Target.Token으로 전달되지 않음: %q", plugin.lastReq.Target.Token)
	}
	var p SendEmailPayload
	_ = json.Unmarshal(m.Envelope.Payload, &p)
	if plugin.lastReq.Content.Email.MessageID != p.MessageID || row[2] != p.MessageID {
		t.Fatalf("message_id 계약 위반: content=%q row=%v payload=%q",
			plugin.lastReq.Content.Email.MessageID, row[2], p.MessageID)
	}
	if len(row) != 16 || row[10] != "email" || row[11] != "sent" || row[15] != "prov-1" {
		t.Fatalf("message_log 행 형식: %v", row)
	}
	if v, _ := mr.Get("send:email:idem:t1:idem-email-1"); v != statusSent+"|prov-1" {
		t.Fatalf("멱등 키가 sent로 커밋되지 않음: %q", v)
	}
	if store.dlqCalls != 0 {
		t.Fatal("정상 발송인데 DLQ에 썼다")
	}
}

// provider 지정 시 그 발송기만 조회하고, 미지정 시 폴백 쿼리(ORDER BY last_verified_at)를 쓴다.
func TestEmailResolveHonorsProviderPin(t *testing.T) {
	key := testMasterKey()
	store := newEmailStore(t, key, "email_nhn", `{}`)
	loop, _, _ := newEmailLoop(t, store, key, &mockPlugin{})

	loop.handleOne(context.Background(), emailMsg(t, func(p *SendEmailPayload) { p.Provider = "email_nhn" }))
	if len(store.lastCredArgs) != 2 || store.lastCredArgs[1] != "email_nhn" {
		t.Fatalf("provider 지정 조회 인자: %v", store.lastCredArgs)
	}

	loop.handleOne(context.Background(), emailMsg(t, func(p *SendEmailPayload) { p.IdempotencyKey = "idem-2" }))
	if len(store.lastCredArgs) != 1 {
		t.Fatalf("폴백 조회는 app_id만 받아야 한다: %v", store.lastCredArgs)
	}
}

// 크리덴셜 미등록은 장애가 아니라 설정 문제 — 재시도 없이 credential_missing으로 종결한다.
func TestEmailCredentialMissingIsTerminal(t *testing.T) {
	key := testMasterKey()
	store := &emailFakeStore{noCred: true}
	plugin := &mockPlugin{}
	loop, _, _ := newEmailLoop(t, store, key, plugin)

	row, retry := loop.handleOne(context.Background(), emailMsg(t, nil))
	if retry || row == nil || row[11] != "failed" || row[12] != "credential_missing" {
		t.Fatalf("credential_missing 종결 기대, got row=%v retry=%v", row, retry)
	}
	if row[13] == "" {
		t.Fatal("credential_missing 행의 failure_detail이 비어 있다")
	}
	if plugin.sends != 0 {
		t.Fatal("크리덴셜 없이 Send를 호출했다")
	}
}

// 이관의 핵심: 재시도 소진 시 send_dlq에 적재된다. 구 EmailWorker에는 이 경로가 없었다.
func TestEmailRetryableExhaustLandsInDLQ(t *testing.T) {
	key := testMasterKey()
	store := newEmailStore(t, key, "email_resend", `{}`)
	plugin := &mockPlugin{sendErr: NewSendError(FailureRetryable, "resend 5xx")}
	loop, mr, fk := newEmailLoop(t, store, key, plugin)
	ctx := context.Background()
	m := emailMsg(t, nil)

	for i := 1; i < maxSendAttempts; i++ {
		row, retry := loop.handleOne(ctx, m)
		if !retry || row != nil {
			t.Fatalf("시도 %d: 재시도(nil,true) 기대, got row=%v retry=%v", i, row, retry)
		}
		if !mr.Exists("send:email:retryat:t1:idem-email-1") {
			t.Fatalf("시도 %d: 백오프 retryat 미설정", i)
		}
		fk.Advance(backoffCap + time.Second)
	}
	if store.dlqCalls != 0 {
		t.Fatal("소진 전에 DLQ에 썼다")
	}

	row, retry := loop.handleOne(ctx, m)
	if retry || row == nil || row[11] != "failed" || row[12] != "retryable_exhausted" {
		t.Fatalf("소진: failed/retryable_exhausted 종결 기대, got row=%v retry=%v", row, retry)
	}
	if store.dlqCalls != 1 {
		t.Fatalf("send_dlq INSERT 1회 기대, got %d", store.dlqCalls)
	}
	if plugin.sends != maxSendAttempts {
		t.Fatalf("Send 호출 %d회, want %d", plugin.sends, maxSendAttempts)
	}
	if v, _ := mr.Get("send:email:idem:t1:idem-email-1"); v != statusFailed+"|retryable_exhausted" {
		t.Fatalf("소진: 상태 failed 커밋 기대, got %q", v)
	}
	// DLQ 행에 원본 envelope이 실려야 cmd/dlq가 재처리할 수 있다.
	var found bool
	for _, a := range store.dlqArgs {
		if b, ok := a.([]byte); ok {
			var env libqueue.Envelope
			if json.Unmarshal(b, &env) == nil && env.ID == m.Envelope.ID {
				found = true
			}
		}
	}
	if !found {
		t.Fatalf("DLQ 행에 원본 envelope이 없다: %v", store.dlqArgs)
	}
}

// payload 불량은 재시도 대상이 아니다 — skip(ACK)해야 큐를 막지 않는다.
func TestEmailMalformedPayloadSkips(t *testing.T) {
	key := testMasterKey()
	plugin := &mockPlugin{}
	loop, _, _ := newEmailLoop(t, newEmailStore(t, key, "email_resend", `{}`), key, plugin)

	for name, m := range map[string]*libqueue.Message{
		"idem 없음":    emailMsg(t, func(p *SendEmailPayload) { p.IdempotencyKey = "" }),
		"content 없음": emailMsg(t, func(p *SendEmailPayload) { p.Content.Email = nil }),
		"JSON 아님":    {StreamID: "1-0", Envelope: libqueue.Envelope{TenantID: "t1", AppID: "a1", Payload: []byte("{")}},
	} {
		row, retry := loop.handleOne(context.Background(), m)
		if retry || row != nil {
			t.Fatalf("%s: skip(nil,false) 기대, got row=%v retry=%v", name, row, retry)
		}
	}
	if plugin.sends != 0 {
		t.Fatal("불량 payload로 Send를 호출했다")
	}
}

// message_log.user_id는 UUID 컬럼 — 비UUID user_id는 행을 잃지 않도록 zero로 적재한다.
func TestEmailRowCoercesNonUUIDUser(t *testing.T) {
	key := testMasterKey()
	loop, _, _ := newEmailLoop(t, newEmailStore(t, key, "email_resend", `{}`), key, &mockPlugin{})
	jid, ver, node := uuid.NewString(), 3, 2
	m := emailMsg(t, func(p *SendEmailPayload) {
		p.UserID = "external-user-42"
		p.JourneyID, p.JourneyVersion, p.NodeIndex = &jid, &ver, &node
	})
	row, _ := loop.handleOne(context.Background(), m)
	if row[8] != zeroUUID || row[9] != zeroUUID {
		t.Fatalf("user_id/device_id zero 기대: user=%v device=%v", row[8], row[9])
	}
	if row[4] != jid || row[5] != uint32(3) || row[6] != uint16(2) {
		t.Fatalf("저니 좌표: %v %v %v", row[4], row[5], row[6])
	}
}
