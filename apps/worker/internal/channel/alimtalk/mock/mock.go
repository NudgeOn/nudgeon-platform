// Package mock — 알림톡 벤더 계약의 참조 구현(reference vendor).
//
// 실제 발송은 하지 않지만 "가짜"가 아니라 "조종 가능한" 벤더다. 계약 테스트(conformance)와
// docker E2E가 성공·차단·한도초과·인증실패를 배선 추가 없이 재현해야 하므로,
// 결과는 수신번호(SendRequest.To)의 끝 4자리 숫자로 결정한다.
//
// # 조종표 (To의 끝 4자리)
//
//	0001  접수 성공 → 종결 delivered
//	0002  접수 성공 → 종결 failed / invalid_target (카카오톡 미가입·채널 차단)
//	0010  대체발송 분기. Fallback이 실려 있으면 접수 성공 → 종결 sent(SMS 대체발송),
//	      실려 있지 않으면 0002와 같다. fallback_trigger 계약 테스트가 이 쌍을 대조한다.
//	0400  Send 즉시 실패 — permanent_content (공급자가 본문을 반려)
//	0401  Send 즉시 실패 — credential_auth (키 무효·권한 없음)
//	0429  Send 즉시 실패 — rate_limited, Retry-After 3s
//	0500  Send 즉시 실패 — retryable (공급자 5xx)
//	그 외  0001과 같다 (임의의 번호로 해피패스 E2E를 돌릴 수 있게).
//
// # 결정성
//
// 시각은 주입된 clock.Clock에서만 얻고(CLAUDE.md 규칙 3), 상태를 전혀 들고 있지 않다.
// 조종 결과는 ProviderMessageID에 인코딩하므로(mock_<messageID 앞 8자>_<결과코드>)
// PollResults·ParseCallback이 Send 시점의 메모리 없이도 같은 결론에 도달한다.
// NHN이 requestId+recipientSeq 복합키를 한 문자열로 접는 것과 같은 기법이다.
package mock

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/ondahq/onda/apps/worker/internal/channel"
	"github.com/ondahq/onda/apps/worker/internal/channel/alimtalk"
	"github.com/ondahq/onda/apps/worker/internal/clock"
	"github.com/ondahq/onda/apps/worker/internal/connector"
)

// ConnectorID — 레지스트리 키. manifest.json의 id와 같아야 한다.
const ConnectorID = "alimtalk_mock"

// 수신번호 끝 4자리 조종 코드. 패키지 주석의 조종표와 1:1이다.
const (
	SuffixDelivered        = "0001"
	SuffixInvalidTarget    = "0002"
	SuffixFallback         = "0010"
	SuffixPermanentContent = "0400"
	SuffixCredentialAuth   = "0401"
	SuffixRateLimited      = "0429"
	SuffixRetryable        = "0500"
)

// RateLimitRetryAfter — 0429가 실어 보내는 Retry-After. 계약 테스트가 양수임을 확인한다.
const RateLimitRetryAfter = 3 * time.Second

// InvalidAPIKey — Validate가 인증 실패로 판정하는 특수 키. 빈 문자열도 같다.
const InvalidAPIKey = "invalid"

// 결과 코드 — ProviderMessageID의 마지막 마디에 인코딩된다.
const (
	outcomeDelivered     = "dl"
	outcomeInvalidTarget = "it"
	outcomeFallback      = "fb"
)

//go:embed manifest.json
var manifestJSON []byte

// EmbeddedManifest — 파일 경로 없이 이 벤더를 세울 수 있게 내장 manifest를 판다.
// 테스트와 E2E 부트스트랩이 쓴다.
func EmbeddedManifest() (connector.Manifest, error) {
	m, err := connector.Parse(manifestJSON)
	if err != nil {
		return connector.Manifest{}, fmt.Errorf("mock: 내장 manifest 파싱: %w", err)
	}
	return m, nil
}

func init() { alimtalk.Register(ConnectorID, New) }

// Vendor — 조종 가능한 알림톡 벤더.
type Vendor struct {
	manifest connector.Manifest
	clk      clock.Clock
}

var _ alimtalk.Vendor = (*Vendor)(nil)

// New — alimtalk.Factory 구현. 실시계를 쓴다.
//
// Factory 시그니처에 시계·로거·HTTP 클라이언트를 넣을 자리가 없어서 여기서 clock.Real을
// 만든다. 테스트는 NewWithClock을 써서 고정 시계를 주입한다.
func New(m connector.Manifest) (alimtalk.Vendor, error) { return NewWithClock(m, clock.Real{}) }

// NewWithClock — 시계 주입 생성자.
func NewWithClock(m connector.Manifest, clk clock.Clock) (*Vendor, error) {
	if clk == nil {
		return nil, fmt.Errorf("mock: clock이 nil")
	}
	if m.ID == "" {
		var err error
		if m, err = EmbeddedManifest(); err != nil {
			return nil, err
		}
	}
	if m.ID != ConnectorID {
		return nil, fmt.Errorf("mock: manifest id가 %q여야 한다 (got %q)", ConnectorID, m.ID)
	}
	if m.Channel != alimtalk.ChannelID {
		return nil, fmt.Errorf("mock: channel이 %q여야 한다 (got %q)", alimtalk.ChannelID, m.Channel)
	}
	return &Vendor{manifest: m, clk: clk}, nil
}

// Manifest — 생성 시 받은 선언을 그대로 돌려준다.
func (v *Vendor) Manifest() connector.Manifest { return v.manifest }

// credential — manifest.credentials.schema의 Go 투영.
type credential struct {
	APIKey    string `json:"api_key"`
	SenderKey string `json:"sender_key"`
}

// Validate — 크리덴셜 실검증.
//
// 잘못된 키는 반드시 credential_auth여야 한다. channel.Verifier.judge가
// invalid_target·permanent_content를 "인증은 통과"로 읽으므로, 400을 그대로 흘리면
// 틀린 키가 verified로 저장된다.
func (v *Vendor) Validate(_ context.Context, cred alimtalk.Credential) error {
	c, err := parseCredential(cred)
	if err != nil {
		return err
	}
	if c.SenderKey == "" {
		return channel.NewSendError(channel.FailureCredentialAuth, "발신프로필 키(sender_key)가 비어 있습니다")
	}
	return nil
}

func parseCredential(cred alimtalk.Credential) (credential, error) {
	if cred.ConnectorID != "" && cred.ConnectorID != ConnectorID {
		return credential{}, channel.NewSendError(channel.FailureCredentialAuth,
			"크리덴셜의 커넥터가 %q라 이 벤더(%s)와 맞지 않습니다", cred.ConnectorID, ConnectorID)
	}
	var c credential
	if len(cred.JSON) == 0 {
		return credential{}, channel.NewSendError(channel.FailureCredentialAuth, "크리덴셜이 비어 있습니다")
	}
	if err := json.Unmarshal(cred.JSON, &c); err != nil {
		return credential{}, channel.NewSendError(channel.FailureCredentialAuth, "크리덴셜 JSON 파싱 실패: %v", err)
	}
	if c.APIKey == "" || c.APIKey == InvalidAPIKey {
		return credential{}, channel.NewSendError(channel.FailureCredentialAuth, "API 키가 유효하지 않습니다")
	}
	return c, nil
}

// Classify — 이 벤더의 오류는 전부 channel.SendError라 공용 분류기로 충분하다.
func (v *Vendor) Classify(err error) channel.FailureClass { return channel.Classify(err) }

// Send — 단건 발송(접수). 검증 → 조종표 순으로 판정한다.
//
// 검증을 조종보다 먼저 하는 이유: 잘못된 요청은 어떤 번호로 보내든 실패해야 하고,
// unsupported_content 계약 테스트가 그 순서에 의존한다.
func (v *Vendor) Send(_ context.Context, req alimtalk.SendRequest) (alimtalk.Receipt, error) {
	if req.MessageID == "" {
		return alimtalk.Receipt{}, channel.NewSendError(channel.FailurePermanentContent, "message_id 누락")
	}
	tmpl, ok := v.template(req.TemplateCode)
	if !ok {
		return alimtalk.Receipt{}, channel.NewSendError(channel.FailurePermanentContent,
			"승인된 템플릿이 아닙니다: %q", req.TemplateCode)
	}
	if err := v.checkCapabilities(req); err != nil {
		return alimtalk.Receipt{}, err
	}
	if err := alimtalk.ValidateSend(tmpl, req); err != nil {
		return alimtalk.Receipt{}, channel.NewSendError(channel.FailurePermanentContent, "%s", err)
	}
	if v.manifest.SubstitutionMode() == connector.SubstitutionRendered && req.RenderedText == "" {
		return alimtalk.Receipt{}, channel.NewSendError(channel.FailurePermanentContent,
			"이 벤더는 완성 본문(rendered_text)을 요구합니다")
	}

	switch Suffix(req.To) {
	case SuffixCredentialAuth:
		return alimtalk.Receipt{}, channel.NewSendError(channel.FailureCredentialAuth,
			"공급자가 인증을 거절했습니다 (mock 401)")
	case SuffixRateLimited:
		return alimtalk.Receipt{}, channel.NewRateLimitError(RateLimitRetryAfter,
			"발송 한도를 초과했습니다 (mock 429)")
	case SuffixPermanentContent:
		return alimtalk.Receipt{}, channel.NewSendError(channel.FailurePermanentContent,
			"승인 본문과 일치하지 않습니다 (mock 400)")
	case SuffixRetryable:
		return alimtalk.Receipt{}, channel.NewSendError(channel.FailureRetryable,
			"공급자 일시 장애 (mock 500)")
	}

	outcome := outcomeDelivered
	switch Suffix(req.To) {
	case SuffixInvalidTarget:
		outcome = outcomeInvalidTarget
	case SuffixFallback:
		if req.Fallback != nil {
			outcome = outcomeFallback
		} else {
			outcome = outcomeInvalidTarget
		}
	}
	return alimtalk.Receipt{
		ProviderMessageID: ProviderMessageID(req.MessageID, outcome),
		MessageID:         req.MessageID,
		AcceptedAt:        v.clk.Now(),
	}, nil
}

// checkCapabilities — manifest가 선언하지 않은 것을 보내면 거절한다.
// 선언과 구현이 어긋나는 벤더는 엔진 입장에서 최악이므로 스스로 막는다.
func (v *Vendor) checkCapabilities(req alimtalk.SendRequest) error {
	if len(req.Buttons) > 0 && !v.declaresContent("buttons") {
		return channel.NewSendError(channel.FailurePermanentContent, "이 벤더는 버튼을 지원하지 않습니다")
	}
	if len(req.QuickReplies) > 0 && !v.declaresContent("quick_replies") {
		return channel.NewSendError(channel.FailurePermanentContent, "이 벤더는 바로연결(quick_replies)을 지원하지 않습니다")
	}
	if req.Fallback != nil && !v.manifest.Capabilities.VendorFallback {
		return channel.NewSendError(channel.FailurePermanentContent, "이 벤더는 대체발송을 지원하지 않습니다")
	}
	if req.ScheduledAt != nil && !v.manifest.Capabilities.ScheduledSend {
		return channel.NewSendError(channel.FailurePermanentContent, "이 벤더는 예약 발송을 지원하지 않습니다")
	}
	return nil
}

func (v *Vendor) declaresContent(feature string) bool {
	for _, c := range v.manifest.Capabilities.Content {
		if c == feature {
			return true
		}
	}
	return false
}

// Suffix — 수신번호에서 조종 코드(끝 4자리 숫자)를 뽑는다. 숫자가 4개 미만이면 빈 문자열.
func Suffix(to string) string {
	digits := make([]rune, 0, len(to))
	for _, r := range to {
		if r >= '0' && r <= '9' {
			digits = append(digits, r)
		}
	}
	if len(digits) < 4 {
		return ""
	}
	return string(digits[len(digits)-4:])
}

// ProviderMessageID — message_id와 결과코드에서 공급자 식별자를 만든다.
// 같은 입력이면 항상 같은 값이라 재발송이 멱등하다(idempotent_resend 계약).
func ProviderMessageID(messageID, outcome string) string {
	return "mock_" + slug8(messageID) + "_" + outcome
}

func slug8(s string) string {
	b := make([]rune, 0, 8)
	for _, r := range strings.ToLower(s) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b = append(b, r)
			if len(b) == 8 {
				break
			}
		}
	}
	if len(b) == 0 {
		return "00000000"
	}
	return string(b)
}

// outcomeOf — ProviderMessageID를 역해석한다. mock이 만든 값이 아니면 false.
func outcomeOf(providerMessageID string) (string, bool) {
	parts := strings.Split(providerMessageID, "_")
	if len(parts) != 3 || parts[0] != "mock" {
		return "", false
	}
	switch parts[2] {
	case outcomeDelivered, outcomeInvalidTarget, outcomeFallback:
		return parts[2], true
	}
	return "", false
}

// callbackPayload — 이 벤더가 받는 웹훅 원문. 단건 객체와 배열을 모두 받는다.
type callbackPayload struct {
	ProviderMessageID string `json:"provider_message_id"`
	MessageID         string `json:"message_id,omitempty"`
	Status            string `json:"status"`
	OccurredAt        string `json:"occurred_at,omitempty"`
	FailureClass      string `json:"failure_class,omitempty"`
	FailureDetail     string `json:"failure_detail,omitempty"`
}

// ParseCallback — 웹훅 원문을 수명주기 이벤트로 바꾼다.
// 서명 검증은 API 계층 몫이라(manifest.lifecycle.callback.verify) 여기서는 파싱만 한다.
func (v *Vendor) ParseCallback(_ context.Context, cb alimtalk.RawCallback) ([]alimtalk.Event, error) {
	if !v.manifest.NeedsCallback() {
		return nil, alimtalk.ErrUnsupported
	}
	if cb.ConnectorID != "" && cb.ConnectorID != ConnectorID {
		return nil, fmt.Errorf("mock: 콜백의 커넥터가 %q라 이 벤더와 맞지 않는다", cb.ConnectorID)
	}
	body := strings.TrimSpace(string(cb.Body))
	if body == "" {
		return nil, fmt.Errorf("mock: 콜백 본문이 비어 있다")
	}
	var items []callbackPayload
	if strings.HasPrefix(body, "[") {
		if err := json.Unmarshal([]byte(body), &items); err != nil {
			return nil, fmt.Errorf("mock: 콜백 파싱: %w", err)
		}
	} else {
		var one callbackPayload
		if err := json.Unmarshal([]byte(body), &one); err != nil {
			return nil, fmt.Errorf("mock: 콜백 파싱: %w", err)
		}
		items = []callbackPayload{one}
	}
	out := make([]alimtalk.Event, 0, len(items))
	for i, it := range items {
		if it.ProviderMessageID == "" {
			return nil, fmt.Errorf("mock: 콜백 %d번: provider_message_id 누락", i+1)
		}
		if !v.manifest.Reports(it.Status) {
			return nil, fmt.Errorf("mock: 콜백 %d번: 보고하지 않는 상태 %q", i+1, it.Status)
		}
		at := v.clk.Now()
		if it.OccurredAt != "" {
			parsed, err := time.Parse(time.RFC3339, it.OccurredAt)
			if err != nil {
				return nil, fmt.Errorf("mock: 콜백 %d번: occurred_at 파싱: %w", i+1, err)
			}
			at = parsed
		}
		ev := alimtalk.Event{
			MessageID:         it.MessageID,
			ProviderMessageID: it.ProviderMessageID,
			Status:            it.Status,
			OccurredAt:        at,
			FailureClass:      it.FailureClass,
			FailureDetail:     it.FailureDetail,
			Terminal:          isTerminal(it.Status),
		}
		if ev.Status == "failed" && ev.FailureClass == "" {
			ev.FailureClass = channel.FailureInvalidTarget.String()
		}
		if ev.Terminal && ev.Status != "failed" {
			ev.CostCurrency, ev.CostAmount = v.unitCost()
		}
		out = append(out, ev)
	}
	return out, nil
}

func isTerminal(status string) bool { return status == "delivered" || status == "failed" }

func (v *Vendor) unitCost() (string, float64) {
	if v.manifest.Cost == nil {
		return "", 0
	}
	return v.manifest.Cost.Currency, v.manifest.Cost.PerMessage
}

// PollResults — 미종결 접수의 결과를 조회한다.
// 조종 결과가 ProviderMessageID에 들어 있으므로 상태 없이 종결 이벤트를 만들 수 있다.
func (v *Vendor) PollResults(_ context.Context, cred alimtalk.Credential, pending []alimtalk.Receipt) ([]alimtalk.Event, error) {
	if !v.manifest.NeedsPolling() {
		return nil, alimtalk.ErrUnsupported
	}
	if _, err := parseCredential(cred); err != nil {
		return nil, err
	}
	out := make([]alimtalk.Event, 0, len(pending))
	for _, r := range pending {
		outcome, ok := outcomeOf(r.ProviderMessageID)
		if !ok {
			// 우리가 발급하지 않은 식별자는 조용히 건너뛴다 — 폴러가 남의 접수를 물고 오면 안 되지만,
			// 그걸로 배치 전체를 실패시키면 나머지 결과까지 잃는다.
			continue
		}
		out = append(out, v.terminalEvent(r, outcome))
	}
	return out, nil
}

// terminalEvent — 결과코드에서 종결 이벤트를 만든다. 폴링·콜백이 같은 표를 쓴다.
func (v *Vendor) terminalEvent(r alimtalk.Receipt, outcome string) alimtalk.Event {
	ev := alimtalk.Event{
		MessageID:         r.MessageID,
		ProviderMessageID: r.ProviderMessageID,
		OccurredAt:        v.clk.Now(),
		Terminal:          true,
	}
	switch outcome {
	case outcomeInvalidTarget:
		ev.Status = "failed"
		ev.FailureClass = channel.FailureInvalidTarget.String()
		ev.FailureDetail = "카카오톡 미가입이거나 채널을 차단한 수신자입니다"
	case outcomeFallback:
		ev.Status = "sent"
		ev.FailureDetail = "알림톡 실패 — SMS 대체발송으로 전환했습니다"
		ev.CostCurrency, ev.CostAmount = v.unitCost()
	default:
		ev.Status = "delivered"
		ev.CostCurrency, ev.CostAmount = v.unitCost()
	}
	return ev
}

// TerminalCallback — 접수 목록에 대한 "공급자가 보냈을 법한" 웹훅 원문을 만든다.
// 계약 테스트 하네스와 E2E가 콜백 경로를 태우는 데 쓴다.
func (v *Vendor) TerminalCallback(receipts []alimtalk.Receipt) (alimtalk.RawCallback, bool) {
	if !v.manifest.NeedsCallback() {
		return alimtalk.RawCallback{}, false
	}
	items := make([]callbackPayload, 0, len(receipts))
	for _, r := range receipts {
		outcome, ok := outcomeOf(r.ProviderMessageID)
		if !ok {
			continue
		}
		ev := v.terminalEvent(r, outcome)
		items = append(items, callbackPayload{
			ProviderMessageID: ev.ProviderMessageID,
			MessageID:         ev.MessageID,
			Status:            ev.Status,
			OccurredAt:        ev.OccurredAt.Format(time.RFC3339),
			FailureClass:      ev.FailureClass,
			FailureDetail:     ev.FailureDetail,
		})
	}
	if len(items) == 0 {
		return alimtalk.RawCallback{}, false
	}
	body, err := json.Marshal(items)
	if err != nil {
		return alimtalk.RawCallback{}, false
	}
	return alimtalk.RawCallback{
		ConnectorID: ConnectorID,
		Body:        body,
		Headers:     map[string]string{"Content-Type": "application/json"},
	}, true
}
