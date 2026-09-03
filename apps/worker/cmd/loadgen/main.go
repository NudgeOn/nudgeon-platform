// nudgeon-loadgen — 수집 부하 러너 (DEV-sub-01 D-7, PT-1).
// track 엔드포인트의 HTTP 접수 처리량·지연·실패를 측정한다. 저장/분석 대사는 별도다.
// 로컬 하네스 검증용 소규모부터 실환경 부하까지 --rate/--dur로 조정.
//
//	go run ./apps/worker/cmd/loadgen --url http://localhost:8080 --key-file /private/path/sdk-key --rate 500 --dur 30s --concurrency 100 --max-p99 500ms --output-dir /private/path/new-run
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"math/rand/v2"
	"net"
	"net/http"
	"net/http/httptrace"
	neturl "net/url"
	"os"
	"os/signal"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/google/uuid"
)

type loadConfig struct {
	url            string
	key            string
	rate           int
	duration       time.Duration
	concurrency    int
	queueCapacity  int
	requestTimeout time.Duration
	maxDropRate    float64
	maxErrorRate   float64
	minRateRatio   float64
	maxP99         time.Duration
	runID          string
	keyFile        string
	outputDir      string
}

type loadJob struct {
	sequence    int64
	scheduledAt time.Time
}

type loadCounters struct {
	scheduled           atomic.Int64
	enqueued            atomic.Int64
	dropped             atomic.Int64
	started             atomic.Int64
	accepted            atomic.Int64
	acceptedInWindow    atomic.Int64
	httpErrors          atomic.Int64
	networkErrors       atomic.Int64
	timeouts            atomic.Int64
	responseErrors      atomic.Int64
	connectionsAcquired atomic.Int64
	connectionsReused   atomic.Int64
	connectionsOpened   atomic.Int64
}

type counterSnapshot struct {
	scheduled           int64
	enqueued            int64
	dropped             int64
	started             int64
	accepted            int64
	acceptedInWindow    int64
	httpErrors          int64
	networkErrors       int64
	timeouts            int64
	responseErrors      int64
	connectionsAcquired int64
	connectionsReused   int64
	connectionsOpened   int64
}

func (c *loadCounters) snapshot() counterSnapshot {
	return counterSnapshot{
		scheduled:           c.scheduled.Load(),
		enqueued:            c.enqueued.Load(),
		dropped:             c.dropped.Load(),
		started:             c.started.Load(),
		accepted:            c.accepted.Load(),
		acceptedInWindow:    c.acceptedInWindow.Load(),
		httpErrors:          c.httpErrors.Load(),
		networkErrors:       c.networkErrors.Load(),
		timeouts:            c.timeouts.Load(),
		responseErrors:      c.responseErrors.Load(),
		connectionsAcquired: c.connectionsAcquired.Load(),
		connectionsReused:   c.connectionsReused.Load(),
		connectionsOpened:   c.connectionsOpened.Load(),
	}
}

type requestResult struct {
	statusCode int
	err        error
}

type loadResult struct {
	runID            string
	expected         int64
	activeDuration   time.Duration
	wallDuration     time.Duration
	drainDuration    time.Duration
	counters         counterSnapshot
	queueLatency     latencyStats
	serviceLatency   latencyStats
	endToEndLatency  latencyStats
	httpStatusCounts map[int]int64
}

func main() {
	os.Exit(runMain())
}

func runMain() int {
	cfg := loadConfig{}
	flag.StringVar(&cfg.url, "url", "http://localhost:8080", "API 베이스 URL")
	flag.StringVar(&cfg.key, "key", "", "SDK Key (호환용; --key-file 권장)")
	flag.StringVar(&cfg.keyFile, "key-file", "", "SDK Key 파일, /dev/fd/N 또는 - (stdin; 키를 argv에 노출하지 않음)")
	flag.StringVar(&cfg.outputDir, "output-dir", "", "새 증거 디렉터리 (기존 경로 덮어쓰기 금지)")
	flag.IntVar(&cfg.rate, "rate", 500, "초당 요청 수 목표")
	flag.DurationVar(&cfg.duration, "dur", 30*time.Second, "지속 시간")
	flag.IntVar(&cfg.concurrency, "concurrency", 20, "동시 전송자 수")
	flag.IntVar(&cfg.queueCapacity, "queue-capacity", 0, "발생기 대기열 크기(0이면 concurrency*2)")
	flag.DurationVar(&cfg.requestTimeout, "request-timeout", 10*time.Second, "요청별 제한 시간")
	flag.Float64Var(&cfg.maxDropRate, "max-drop-rate", 0, "허용 발생기 드롭률(0~1)")
	flag.Float64Var(&cfg.maxErrorRate, "max-error-rate", 0, "허용 HTTP/네트워크 오류율(0~1)")
	flag.Float64Var(&cfg.minRateRatio, "min-rate-ratio", 0.99, "목표 대비 최소 202 처리량 비율(0~1)")
	flag.DurationVar(&cfg.maxP99, "max-p99", 0, "허용 종단 p99(0이면 지연 게이트 비활성)")
	flag.StringVar(&cfg.runID, "run-id", "", "대사용 실행 ID(비우면 UUID 생성)")
	flag.Parse()
	if err := cfg.resolveKey(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}

	if cfg.runID == "" {
		cfg.runID = uuid.NewString()
	}
	if cfg.queueCapacity == 0 && cfg.concurrency > 0 {
		cfg.queueCapacity = cfg.concurrency * 2
	}
	if err := cfg.validate(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}

	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.MaxIdleConns = cfg.concurrency * 2
	transport.MaxIdleConnsPerHost = cfg.concurrency
	transport.MaxConnsPerHost = cfg.concurrency
	client := &http.Client{Transport: transport, Timeout: cfg.requestTimeout, CheckRedirect: noRedirect}
	defer transport.CloseIdleConnections()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	result, err := runLoad(ctx, cfg, client)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		if result.expected > 0 {
			printResult(result, cfg)
		}
		return 1
	}
	printResult(result, cfg)
	violations := evaluate(result, cfg)
	if len(violations) > 0 {
		fmt.Fprintln(os.Stderr, "\n=== loadgen 게이트 실패 ===")
		for _, violation := range violations {
			fmt.Fprintf(os.Stderr, "- %s\n", violation)
		}
		return 1
	}
	fmt.Fprintln(os.Stderr, "\nloadgen gate: PASS (HTTP 접수만 검증; 저장/분석 대사 별도)")
	return 0
}

func noRedirect(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

func (c *loadConfig) resolveKey() error {
	if c.keyFile == "" {
		return nil
	}
	if c.key != "" {
		return errors.New("--key와 --key-file은 함께 사용할 수 없습니다")
	}
	f := os.Stdin
	if c.keyFile != "-" {
		var err error
		f, err = os.Open(c.keyFile)
		if err != nil {
			return errors.New("--key-file을 열 수 없습니다")
		}
		defer f.Close()
	}
	data, err := io.ReadAll(io.LimitReader(f, 4097))
	if err != nil || len(data) > 4096 {
		return errors.New("--key-file 읽기 실패 또는 크기 초과")
	}
	c.key = strings.TrimSpace(string(data))
	return nil
}

var validRunID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$`)

func (c loadConfig) validate() error {
	u, err := neturl.Parse(c.url)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("--url은 사용자정보·query·fragment 없는 HTTP(S) 주소여야 합니다")
	}
	switch {
	case strings.TrimSpace(c.key) == "":
		return errors.New("--key-file 또는 --key (SDK Key) 필수")
	case strings.ContainsAny(c.key, "\r\n"):
		return errors.New("SDK Key에 줄바꿈을 포함할 수 없습니다")
	case !validRunID.MatchString(c.runID):
		return errors.New("--run-id는 1~128자의 영문·숫자·점·밑줄·하이픈이어야 합니다")
	case c.rate <= 0 || int64(c.rate) > int64(time.Second):
		return errors.New("--rate는 1~1000000000 범위여야 합니다")
	case c.duration <= 0:
		return errors.New("--dur은 0보다 커야 합니다")
	case c.concurrency <= 0:
		return errors.New("--concurrency는 1 이상이어야 합니다")
	case c.queueCapacity <= 0:
		return errors.New("--queue-capacity는 1 이상이어야 합니다")
	case c.requestTimeout <= 0:
		return errors.New("--request-timeout은 0보다 커야 합니다")
	case math.IsNaN(c.maxDropRate) || c.maxDropRate < 0 || c.maxDropRate > 1:
		return errors.New("--max-drop-rate는 0 이상 1 이하여야 합니다")
	case math.IsNaN(c.maxErrorRate) || c.maxErrorRate < 0 || c.maxErrorRate > 1:
		return errors.New("--max-error-rate는 0 이상 1 이하여야 합니다")
	case math.IsNaN(c.minRateRatio) || c.minRateRatio < 0 || c.minRateRatio > 1:
		return errors.New("--min-rate-ratio는 0 이상 1 이하여야 합니다")
	case c.maxP99 < 0:
		return errors.New("--max-p99는 0 이상이어야 합니다")
	}
	return nil
}

func runLoad(ctx context.Context, cfg loadConfig, client *http.Client) (loadResult, error) {
	if err := cfg.validate(); err != nil {
		return loadResult{}, err
	}
	planned := math.Round(float64(cfg.rate) * cfg.duration.Seconds())
	if planned < 1 || planned > 1<<53 {
		return loadResult{}, errors.New("목표 요청 수는 1~2^53 범위여야 합니다")
	}
	expected := int64(planned)
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	jobs := make(chan loadJob, cfg.queueCapacity)
	counters := &loadCounters{}
	queueLatencies := &latencyRecorder{}
	serviceLatencies := &latencyRecorder{}
	endToEndLatencies := &latencyRecorder{}
	statusCounts := &statusRecorder{}
	// Metadata describes the actual all-new, single-event workload. It never
	// claims the planned returning-user/multi-tenant profile is implemented.
	loadStartedAt := time.Now()
	evidence, err := newEvidence(cfg.outputDir, map[string]any{
		"schema_version": 1, "run_id": cfg.runID, "started_at": loadStartedAt.UTC(),
		"expected": expected, "rate_rps": cfg.rate, "duration_ns": int64(cfg.duration),
		"concurrency": cfg.concurrency, "queue_capacity": cfg.queueCapacity,
		"request_timeout_ns": int64(cfg.requestTimeout), "workload": "all_new_identity_single_event",
		"identity_scheme":      "uuid-v5: namespace=URL(nudgeon-loadgen:v1:<run_id>); name=<event|anon|device>:<sequence>",
		"journal_record_bytes": eventRecordBytes, "journal_format": "uint8 kind + uint64 little-endian sequence + uint64 little-endian count",
		"journal_kinds":   map[string]byte{"attempt_started": eventStarted, "accepted": eventAccepted, "dropped": eventDropped, "http_error": eventHTTPError, "network_error": eventNetworkError, "response_error": eventResponseError},
		"histogram":       "cumulative us: index=shift*1024+(us>>shift), shift=max(0,bit_length(us)-11); range=0..60s; upper-rounded",
		"automatic_retry": false,
	}, cancel)
	if err != nil {
		return loadResult{}, fmt.Errorf("evidence preflight failed: %w", err)
	}
	// Evidence setup is included in scheduled latency and measured duration;
	// a slow disk must not silently shift the target window.
	activeDeadline := loadStartedAt.Add(cfg.duration)
	histograms := func() map[string]histogramSnapshot {
		return map[string]histogramSnapshot{"queue": queueLatencies.snapshot(), "service": serviceLatencies.snapshot(), "end_to_end": endToEndLatencies.snapshot()}
	}
	sample := func() {
		evidence.sample(map[string]any{"elapsed_ns": int64(time.Since(loadStartedAt)), "counters": counters.snapshot().report(), "histograms": histograms()})
	}
	var sampleWG sync.WaitGroup
	sampleDone := make(chan struct{})
	if evidence != nil {
		sampleWG.Add(1)
		go func() {
			defer sampleWG.Done()
			ticker := time.NewTicker(time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-sampleDone:
					return
				case <-ticker.C:
					sample()
				}
			}
		}()
	}
	trace := &httptrace.ClientTrace{
		GotConn: func(info httptrace.GotConnInfo) {
			counters.connectionsAcquired.Add(1)
			if info.Reused {
				counters.connectionsReused.Add(1)
			}
		},
		ConnectDone: func(_, _ string, err error) {
			if err == nil {
				counters.connectionsOpened.Add(1)
			}
		},
	}

	var wg sync.WaitGroup
	for i := 0; i < cfg.concurrency; i++ {
		wg.Add(1)
		go func(seed int) {
			defer wg.Done()
			rng := rand.New(rand.NewPCG(uint64(seed+1), 7))
			for job := range jobs {
				evidence.record(eventStarted, job.sequence, 1)
				startedAt := time.Now()
				counters.started.Add(1)
				queueLatencies.record(nonNegative(startedAt.Sub(job.scheduledAt)))

				reqCtx, reqCancel := context.WithTimeout(httptrace.WithClientTrace(ctx, trace), cfg.requestTimeout)
				outcome := postTrack(reqCtx, client, cfg.url, cfg.key, cfg.runID, job, rng)
				reqCancel()
				completedAt := time.Now()
				serviceLatencies.record(completedAt.Sub(startedAt))
				endToEndLatencies.record(nonNegative(completedAt.Sub(job.scheduledAt)))

				kind := eventHTTPError
				switch {
				case errors.Is(outcome.err, errResponse):
					counters.responseErrors.Add(1)
					kind = eventResponseError
				case outcome.err != nil:
					kind = eventNetworkError
					counters.networkErrors.Add(1)
					if isTimeout(outcome.err) {
						counters.timeouts.Add(1)
					}
				case outcome.statusCode == http.StatusAccepted:
					kind = eventAccepted
					counters.accepted.Add(1)
					if completedAt.Before(activeDeadline) {
						counters.acceptedInWindow.Add(1)
					}
				default:
					counters.httpErrors.Add(1)
					statusCounts.add(outcome.statusCode)
				}
				evidence.record(kind, job.sequence, 1)
			}
		}(i)
	}

	var runErr error
	for sequence := int64(0); sequence < expected; sequence++ {
		offset := scheduleOffset(sequence, cfg.rate)
		scheduledAt := loadStartedAt.Add(offset)
		runErr = waitUntil(ctx, scheduledAt)
		if runErr != nil || !time.Now().Before(activeDeadline) {
			// Missing arrivals are not sent as an unbounded catch-up burst after T1.
			remaining := expected - sequence
			counters.scheduled.Add(remaining)
			counters.dropped.Add(remaining)
			evidence.record(eventDropped, sequence, remaining)
			break
		}
		if !tryEnqueue(loadJob{sequence: sequence, scheduledAt: scheduledAt}, jobs, counters) {
			evidence.record(eventDropped, sequence, 1)
		}
	}
	if runErr == nil {
		runErr = waitUntil(ctx, activeDeadline)
	}
	close(jobs)
	wg.Wait()
	close(sampleDone)
	sampleWG.Wait()

	wallDuration := time.Since(loadStartedAt)
	drainDuration := nonNegative(wallDuration - cfg.duration)
	result := loadResult{
		runID:            cfg.runID,
		expected:         expected,
		activeDuration:   cfg.duration,
		wallDuration:     wallDuration,
		drainDuration:    drainDuration,
		counters:         counters.snapshot(),
		queueLatency:     queueLatencies.stats(),
		serviceLatency:   serviceLatencies.stats(),
		endToEndLatency:  endToEndLatencies.stats(),
		httpStatusCounts: statusCounts.snapshot(),
	}
	if runErr == nil {
		runErr = ctx.Err()
	}
	if evidence != nil {
		sample()
		if err := evidence.finish(result.report(cfg, runErr)); err != nil {
			return result, err
		}
	}
	return result, runErr
}

func scheduleOffset(sequence int64, rate int) time.Duration {
	return time.Duration(sequence/int64(rate))*time.Second + time.Duration(sequence%int64(rate))*time.Second/time.Duration(rate)
}

func waitUntil(ctx context.Context, at time.Time) error {
	delay := time.Until(at)
	if delay <= 0 {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
			return nil
		}
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func tryEnqueue(job loadJob, jobs chan<- loadJob, counters *loadCounters) bool {
	counters.scheduled.Add(1)
	select {
	case jobs <- job:
		counters.enqueued.Add(1)
		return true
	default:
		counters.dropped.Add(1)
		return false
	}
}

func deterministicID(runID, kind string, sequence int64) string {
	namespace := uuid.NewSHA1(uuid.NameSpaceURL, []byte("nudgeon-loadgen:v1:"+runID))
	return uuid.NewSHA1(namespace, []byte(fmt.Sprintf("%s:%d", kind, sequence))).String()
}

func trackBody(runID string, job loadJob) ([]byte, error) {
	body, err := json.Marshal(map[string]any{
		"batch": []map[string]any{{
			"insert_id":  deterministicID(runID, "event", job.sequence),
			"anon_id":    deterministicID(runID, "anon", job.sequence),
			"event":      "load_event",
			"properties": map[string]any{"n": job.sequence % 1000, "load_run_id": runID, "load_sequence": job.sequence},
			"client_ts":  job.scheduledAt.UTC().Format(time.RFC3339Nano),
		}},
		"device": map[string]any{"device_id": deterministicID(runID, "device", job.sequence), "platform": "android"},
	})
	return body, err
}

const maxResponseBytes = 64 * 1024

var errResponse = errors.New("invalid or oversized track response")

// rng stays in the signature for the existing diagnostic overlay; IDs and
// payload values no longer depend on worker assignment or random state.
func postTrack(ctx context.Context, client *http.Client, url, key, runID string, job loadJob, _ *rand.Rand) requestResult {
	body, err := trackBody(runID, job)
	if err != nil {
		return requestResult{err: err}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(url, "/")+"/v1/track", bytes.NewReader(body))
	if err != nil {
		return requestResult{err: err}
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	// Do not replay a body on a stale pooled connection. The caller must see
	// failures, not a transparent retry that changes the offered workload.
	req.GetBody = nil
	res, err := client.Do(req)
	if err != nil {
		return requestResult{err: err}
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, maxResponseBytes+1))
	if err != nil {
		return requestResult{statusCode: res.StatusCode, err: err}
	}
	if len(data) > maxResponseBytes {
		return requestResult{statusCode: res.StatusCode, err: errResponse}
	}
	if res.StatusCode == http.StatusAccepted {
		var ack struct {
			Accepted *int `json:"accepted"`
		}
		if json.Unmarshal(data, &ack) != nil || ack.Accepted == nil || *ack.Accepted != 1 {
			return requestResult{statusCode: res.StatusCode, err: errResponse}
		}
	}
	return requestResult{statusCode: res.StatusCode}
}

func isTimeout(err error) bool {
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
}

func evaluate(result loadResult, cfg loadConfig) []string {
	c := result.counters
	violations := make([]string, 0, 6)
	if c.scheduled != result.expected {
		violations = append(violations, "목표 요청 수와 스케줄 합계 불일치")
	}
	if c.scheduled != c.enqueued+c.dropped {
		violations = append(violations, fmt.Sprintf("발생기 회계 불일치: scheduled=%d, enqueued+dropped=%d", c.scheduled, c.enqueued+c.dropped))
	}
	if c.enqueued != c.started {
		violations = append(violations, fmt.Sprintf("큐 회계 불일치: enqueued=%d, started=%d", c.enqueued, c.started))
	}
	if c.started != c.accepted+c.httpErrors+c.networkErrors+c.responseErrors {
		violations = append(violations, fmt.Sprintf("요청 회계 불일치: started=%d, completed=%d", c.started, c.accepted+c.httpErrors+c.networkErrors+c.responseErrors))
	}
	if c.acceptedInWindow < 0 || c.acceptedInWindow > c.accepted {
		violations = append(violations, "측정 구간 성공 수 불일치")
	}

	dropRate := ratio(c.dropped, c.scheduled)
	errorRate := ratio(c.httpErrors+c.networkErrors+c.responseErrors, c.started)
	rateRatio := ratio(c.acceptedInWindow, result.expected)
	if dropRate > cfg.maxDropRate {
		violations = append(violations, fmt.Sprintf("발생기 드롭률 %.4f%% > 허용 %.4f%%", dropRate*100, cfg.maxDropRate*100))
	}
	if errorRate > cfg.maxErrorRate {
		violations = append(violations, fmt.Sprintf("요청 오류율 %.4f%% > 허용 %.4f%%", errorRate*100, cfg.maxErrorRate*100))
	}
	if rateRatio < cfg.minRateRatio {
		violations = append(violations, fmt.Sprintf("측정 구간 내 202 처리량 비율 %.4f%% < 최소 %.4f%%", rateRatio*100, cfg.minRateRatio*100))
	}
	if result.queueLatency.overflow+result.serviceLatency.overflow+result.endToEndLatency.overflow > 0 {
		violations = append(violations, "지연 histogram 범위 초과 (60초): clipping한 결과로 통과할 수 없습니다")
	}
	if cfg.maxP99 > 0 && result.endToEndLatency.p99 > cfg.maxP99 {
		violations = append(violations, fmt.Sprintf("종단 p99 %s > 허용 %s", result.endToEndLatency.p99.Round(time.Microsecond), cfg.maxP99))
	}
	return violations
}

func printResult(result loadResult, cfg loadConfig) {
	c := result.counters
	dropRate := ratio(c.dropped, c.scheduled)
	errorRate := ratio(c.httpErrors+c.networkErrors+c.responseErrors, c.started)
	acceptedRate := float64(c.acceptedInWindow) / result.activeDuration.Seconds()
	wallRate := float64(c.accepted) / result.wallDuration.Seconds()

	fmt.Println("\n=== loadgen 결과 ===")
	fmt.Printf("run_id:          %s\n", result.runID)
	fmt.Printf("부하 구간:       %s\n", result.activeDuration.Round(time.Millisecond))
	fmt.Printf("drain 시간:      %s\n", result.drainDuration.Round(time.Millisecond))
	fmt.Printf("전체 경과:       %s\n", result.wallDuration.Round(time.Millisecond))
	fmt.Printf("목표 요청:       %d (%d req/s)\n", result.expected, cfg.rate)
	fmt.Printf("스케줄됨:        %d\n", c.scheduled)
	fmt.Printf("큐 진입:         %d\n", c.enqueued)
	fmt.Printf("발생기 드롭:     %d (%.4f%%)\n", c.dropped, dropRate*100)
	fmt.Printf("HTTP 시작:       %d\n", c.started)
	fmt.Printf("성공(202):       %d\n", c.accepted)
	fmt.Printf("구간 내 성공:    %d (종료 후 %d)\n", c.acceptedInWindow, c.accepted-c.acceptedInWindow)
	fmt.Printf("실패 합계:       %d (목표 - 성공, 발생기 드롭 포함)\n", result.failedTotal())
	fmt.Printf("HTTP 오류:       %d%s\n", c.httpErrors, formatStatuses(result.httpStatusCounts))
	fmt.Printf("네트워크 오류:   %d (timeout %d)\n", c.networkErrors, c.timeouts)
	fmt.Printf("응답 계약 오류:  %d\n", c.responseErrors)
	fmt.Printf("202 처리량:      %.1f req/s (구간 내 완료만)\n", acceptedRate)
	fmt.Printf("완료 처리량:     %.1f req/s (drain 포함)\n", wallRate)
	fmt.Printf("요청 오류율:     %.4f%%\n", errorRate*100)
	fmt.Printf("TCP 연결 생성:   %d, 연결 획득 %d, 재사용 %d\n", c.connectionsOpened, c.connectionsAcquired, c.connectionsReused)
	fmt.Printf("지연 저장 공간:  %d bytes (3개 histogram 고정 bucket 배열)\n", 3*latencyBuckets*8)
	printLatency("큐 대기", result.queueLatency)
	printLatency("서비스", result.serviceLatency)
	printLatency("종단", result.endToEndLatency)
	fmt.Printf("대사 필터:       properties.load_run_id=%s\n", result.runID)
	if cfg.outputDir == "" {
		fmt.Println("증거 파일:       미기록 (--output-dir 필요)")
	} else {
		fmt.Printf("증거 파일:       %s\n", cfg.outputDir)
	}
}

func (r loadResult) failedTotal() int64 { return r.expected - r.counters.accepted }

func printLatency(label string, stats latencyStats) {
	fmt.Printf("%-12s p50=%-10s p99=%-10s max=%s overflow=%d\n", label+" 지연:", stats.p50.Round(time.Microsecond), stats.p99.Round(time.Microsecond), stats.max.Round(time.Microsecond), stats.overflow)
}

func formatStatuses(counts map[int]int64) string {
	if len(counts) == 0 {
		return ""
	}
	codes := make([]int, 0, len(counts))
	for code := range counts {
		codes = append(codes, code)
	}
	sort.Ints(codes)
	parts := make([]string, 0, len(codes))
	for _, code := range codes {
		parts = append(parts, fmt.Sprintf("%d=%d", code, counts[code]))
	}
	return " [" + strings.Join(parts, ", ") + "]"
}

func ratio(numerator, denominator int64) float64 {
	if denominator == 0 {
		return 0
	}
	return float64(numerator) / float64(denominator)
}

func nonNegative(d time.Duration) time.Duration {
	if d < 0 {
		return 0
	}
	return d
}

type statusRecorder struct {
	mu     sync.Mutex
	counts map[int]int64
}

func (r *statusRecorder) add(status int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.counts == nil {
		r.counts = make(map[int]int64)
	}
	r.counts[status]++
}

func (r *statusRecorder) snapshot() map[int]int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	result := make(map[int]int64, len(r.counts))
	for status, count := range r.counts {
		result[status] = count
	}
	return result
}
