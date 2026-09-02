// nudgeon-loadgen — 수집 부하 러너 (DEV-sub-01 D-7, PT-1).
// track 엔드포인트에 지속 부하를 걸고 처리량·지연(p50/p99)·유실을 측정한다.
// 로컬 하네스 검증용 소규모부터 실환경 부하까지 --rate/--dur로 조정.
//
//	go run ./apps/worker/cmd/loadgen --url http://localhost:8080 --key pk_dev_... --rate 500 --dur 30s --concurrency 20
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math/rand/v2"
	"net/http"
	"os"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
)

func main() {
	url := flag.String("url", "http://localhost:8080", "API 베이스 URL")
	key := flag.String("key", "", "SDK Key (필수)")
	rate := flag.Int("rate", 500, "초당 요청 수 목표")
	dur := flag.Duration("dur", 30*time.Second, "지속 시간")
	concurrency := flag.Int("concurrency", 20, "동시 전송자 수")
	flag.Parse()

	if *key == "" {
		log.Fatal("--key (SDK Key) 필수")
	}

	ctx, cancel := context.WithTimeout(context.Background(), *dur)
	defer cancel()

	client := &http.Client{Timeout: 10 * time.Second}
	var sent, ok, failed atomic.Int64
	latencies := &latencyRecorder{}

	// rate limiter: 초당 rate개 토큰
	interval := time.Second / time.Duration(*rate)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	jobs := make(chan struct{}, *concurrency*2)
	var wg sync.WaitGroup
	for i := 0; i < *concurrency; i++ {
		wg.Add(1)
		go func(seed int) {
			defer wg.Done()
			rng := rand.New(rand.NewPCG(uint64(seed), 7))
			for range jobs {
				start := time.Now()
				// 요청은 부하 기간 ctx와 분리 — 이미 발행된 잡은 종료 레이스로 취소되지 않게
				reqCtx, reqCancel := context.WithTimeout(context.Background(), 10*time.Second)
				success := postTrack(reqCtx, client, *url, *key, rng)
				reqCancel()
				if success {
					ok.Add(1)
				} else {
					failed.Add(1)
				}
				latencies.record(time.Since(start))
			}
		}(i)
	}

	start := time.Now()
	go func() {
		for {
			select {
			case <-ctx.Done():
				close(jobs)
				return
			case <-ticker.C:
				select {
				case jobs <- struct{}{}:
					sent.Add(1)
				default: // 백프레셔 — 소비 못 따라가면 드롭(측정에서 별도 집계 안 함)
				}
			}
		}
	}()

	wg.Wait()
	elapsed := time.Since(start)

	p50, p99, max := latencies.percentiles()
	fmt.Fprintf(os.Stderr, "\n=== loadgen 결과 ===\n")
	fmt.Printf("기간:        %s\n", elapsed.Round(time.Millisecond))
	fmt.Printf("발행:        %d\n", sent.Load())
	fmt.Printf("성공(202):   %d\n", ok.Load())
	fmt.Printf("실패:        %d\n", failed.Load())
	fmt.Printf("처리량:      %.0f req/s\n", float64(ok.Load())/elapsed.Seconds())
	fmt.Printf("지연 p50:    %s\n", p50.Round(time.Microsecond))
	fmt.Printf("지연 p99:    %s\n", p99.Round(time.Microsecond))
	fmt.Printf("지연 max:    %s\n", max.Round(time.Microsecond))
	if failed.Load() > 0 {
		fmt.Printf("\n⚠ 실패 %d건 — 유실 0 요건 미달\n", failed.Load())
		os.Exit(1)
	}
}

func postTrack(ctx context.Context, client *http.Client, url, key string, rng *rand.Rand) bool {
	body, _ := json.Marshal(map[string]any{
		"batch": []map[string]any{{
			"insert_id":   uuid.NewString(),
			"anon_id":     uuid.NewString(),
			"event":       "load_event",
			"properties":  map[string]any{"n": rng.IntN(1000)},
			"client_ts":   time.Now().UTC().Format(time.RFC3339),
		}},
		"device": map[string]any{"device_id": uuid.NewString(), "platform": "android"},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url+"/v1/track", bytes.NewReader(body))
	if err != nil {
		return false
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	res, err := client.Do(req)
	if err != nil {
		return false
	}
	defer res.Body.Close()
	return res.StatusCode == http.StatusAccepted
}

// latencyRecorder — 지연 샘플 수집 (락 보호)
type latencyRecorder struct {
	mu      sync.Mutex
	samples []time.Duration
}

func (r *latencyRecorder) record(d time.Duration) {
	r.mu.Lock()
	r.samples = append(r.samples, d)
	r.mu.Unlock()
}

func (r *latencyRecorder) percentiles() (p50, p99, max time.Duration) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.samples) == 0 {
		return
	}
	sort.Slice(r.samples, func(i, j int) bool { return r.samples[i] < r.samples[j] })
	n := len(r.samples)
	return r.samples[n*50/100], r.samples[min(n*99/100, n-1)], r.samples[n-1]
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
