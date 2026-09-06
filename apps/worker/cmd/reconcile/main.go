// cmd/reconcile — 발송 원장 대사. Redis 유실 이후 중복 발송·누락을 찾는다.
//
//	reconcile [--tenant <uuid>] [--app <uuid>] [--since 24h] [--samples 20] [--json]
//
// PRD-08 5장이 Redis 유실의 2차 방어로 지정한 도구다. 발송 멱등 키·중복 억제·
// 빈도 제한 카운터가 모두 Redis에 있으므로, Redis가 휘발하면 "이미 보냈는지"를
// 알 수 없다. 이 도구는 PostgreSQL journey_outbox(발행 원장)와 ClickHouse
// message_log(발송 결과)를 대조해 실제로 무슨 일이 있었는지 보여 준다.
//
// 읽기 전용이다. 아무것도 고치지 않는다. 복구 조치(재발행·무시·고객 고지)는 사람이 정한다.
//
// 종료 코드: 0 이상 없음 · 1 조치 필요한 발견 있음 · 2 실행 실패.
// 조치 필요한 발견에는 "범위가 상한을 넘어 판단할 수 없음"도 포함한다 —
// 모르는 것을 이상 없음으로 보고하지 않는다.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/clock"
	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/config"
	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/reconcile"
)

const (
	exitClean    = 0
	exitFindings = 1
	exitError    = 2
)

func main() {
	var (
		tenant  = flag.String("tenant", "", "테넌트 UUID (비우면 전체)")
		app     = flag.String("app", "", "앱 UUID (비우면 전체)")
		since   = flag.Duration("since", 24*time.Hour, "대사 기간 (예: 24h, 72h)")
		samples = flag.Int("samples", 20, "분류별 표본 출력 수")
		maxKeys = flag.Int("max-keys", 0, "메모리 보호 상한 (0=기본 500000)")
		asJSON  = flag.Bool("json", false, "JSON으로 출력")
	)
	flag.Usage = usage
	flag.Parse()

	cfg, err := config.Load("DATABASE_URL", "CLICKHOUSE_URL")
	if err != nil {
		fail("설정 로드: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	pg, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		fail("PostgreSQL 연결: %v", err)
	}
	defer pg.Close()

	chOpts, err := clickhouse.ParseDSN(cfg.ClickHouseURL)
	if err != nil {
		fail("ClickHouse DSN: %v", err)
	}
	chOpts.MaxOpenConns, chOpts.MaxIdleConns = 2, 1
	ch, err := clickhouse.Open(chOpts)
	if err != nil {
		fail("ClickHouse 연결: %v", err)
	}
	defer ch.Close()

	clk := clock.Real{} // 조립 지점에서만 실제 시계를 만든다 (CLAUDE.md 규칙 3).
	rep, err := reconcile.Run(ctx, pg, ch, clk, reconcile.Scope{
		TenantID: *tenant, AppID: *app,
		Since:   clk.Now().Add(-*since),
		MaxKeys: *maxKeys, Samples: *samples,
	})
	if err != nil {
		fail("대사: %v", err)
	}

	if *asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(rep); err != nil {
			fail("출력: %v", err)
		}
	} else {
		printReport(rep, *since)
	}

	if rep.Clean() {
		os.Exit(exitClean)
	}
	os.Exit(exitFindings)
}

func printReport(r reconcile.Report, window time.Duration) {
	fmt.Printf("발송 원장 대사 — 최근 %s\n", window)
	scope := "전체 테넌트"
	if r.Scope.TenantID != "" {
		scope = "tenant=" + r.Scope.TenantID
		if r.Scope.AppID != "" {
			scope += " app=" + r.Scope.AppID
		}
	}
	fmt.Printf("범위: %s\n\n", scope)

	fmt.Printf("발행 원장(PG) %d건 · 발송 로그(CH) %d키\n\n", r.PublishedKeys, r.LoggedKeys)

	// 1) 중복 발송
	if r.DuplicateKeys == 0 {
		fmt.Println("중복 발송      없음")
	} else {
		fmt.Printf("중복 발송      멱등 키 %d개에서 초과 발송 %d건 ⚠️\n", r.DuplicateKeys, r.DuplicateSends)
		fmt.Println("               같은 멱등 키에 서로 다른 message_id로 성공 발송이 둘 이상이다.")
		fmt.Println("               고객이 알림을 두 번 받았다는 뜻이다.")
		for _, d := range r.Duplicates {
			fmt.Printf("               · %s  %s  %d회  %s ~ %s\n",
				short(d.IdempotencyKey), d.Channel, len(d.MessageIDs),
				d.FirstSentAt.Format(time.RFC3339), d.LastSentAt.Format(time.RFC3339))
		}
		if r.DuplicateKeys > len(r.Duplicates) {
			fmt.Printf("               (표본 %d개만 표시, 총 %d개)\n", len(r.Duplicates), r.DuplicateKeys)
		}
	}

	// 2) 누락
	fmt.Println()
	if r.Truncated {
		fmt.Println("누락           판단 불가 — 범위가 상한을 넘었다")
	} else if r.MissingCount == 0 {
		fmt.Println("누락           없음")
	} else {
		fmt.Printf("누락           발행됐으나 결과 기록 없음 %d건 ⚠️\n", r.MissingCount)
		fmt.Println("               큐에서 사라졌거나 결과 기록이 실패한 뒤 복구되지 않았다.")
		for _, m := range r.Missing {
			fmt.Printf("               · %s  %s  발행 %s\n",
				short(m.IdempotencyKey), m.Stream, m.PublishedAt.Format(time.RFC3339))
		}
		if r.MissingCount > len(r.Missing) {
			fmt.Printf("               (표본 %d개만 표시, 총 %d개)\n", len(r.Missing), r.MissingCount)
		}
	}

	// 3) 미발행 정체
	fmt.Println()
	if r.StuckCount == 0 {
		fmt.Println("미발행 정체    없음")
	} else {
		fmt.Printf("미발행 정체    15분 넘게 발행되지 않은 outbox %d건 ⚠️\n", r.StuckCount)
		fmt.Println("               outbox relay가 멈췄거나 뒤처지고 있다.")
		for _, s := range r.Stuck {
			fmt.Printf("               · %s  %s  생성 %s  시도 %d회\n",
				short(s.IdempotencyKey), s.Stream, s.CreatedAt.Format(time.RFC3339), s.AttemptCount)
		}
		if r.StuckCount > len(r.Stuck) {
			fmt.Printf("               (표본 %d개만 표시, 총 %d개)\n", len(r.Stuck), r.StuckCount)
		}
	}

	for _, n := range r.Notes {
		fmt.Printf("\n주의: %s\n", n)
	}

	fmt.Println()
	if r.Clean() {
		fmt.Println("조치가 필요한 발견 없음.")
		return
	}
	fmt.Println("다음 조치")
	if r.DuplicateKeys > 0 {
		fmt.Println("  · 중복 발송은 되돌릴 수 없다. 규모를 파악해 고객 고지 여부를 판단하라.")
		fmt.Println("    Redis 유실 시점과 중복 발송 시각이 겹치는지 먼저 확인하라.")
	}
	if r.MissingCount > 0 {
		fmt.Println("  · 누락 건은 journey_outbox의 payload가 남아 있다. 재발행 전에")
		fmt.Println("    실제로 미발송인지 확인하라 — 발송 후 기록만 실패했다면 재발행이 곧 중복이다.")
	}
	if r.StuckCount > 0 {
		fmt.Println("  · outbox relay 상태와 nudgeon_outbox_relay_round_errors_total 지표를 확인하라.")
	}
	if r.Truncated {
		fmt.Println("  · --tenant/--app/--since로 범위를 좁혀 다시 실행하라. 지금 수치는 최소값이다.")
	}
}

func short(key string) string {
	if len(key) <= 56 {
		return key
	}
	return key[:53] + "..."
}

func usage() {
	fmt.Fprint(os.Stderr, `reconcile — 발송 원장 대사 (읽기 전용)

  reconcile [--tenant <uuid>] [--app <uuid>] [--since 24h] [--samples 20] [--json]

무엇을 찾나
  중복 발송     같은 멱등 키에 서로 다른 message_id로 성공 발송이 둘 이상
  누락          journey_outbox는 발행 완료인데 message_log에 결과가 없음
  미발행 정체   15분 넘게 발행되지 않은 outbox 행

언제 쓰나
  Redis를 잃었거나 재기동한 뒤. 발송 멱등 키가 Redis에만 있어
  유실되면 중복 발송을 막을 수 없다 (PRD-08 5장).

환경변수
  DATABASE_URL, CLICKHOUSE_URL

종료 코드
  0  이상 없음
  1  조치가 필요한 발견 있음 (판단 불가도 포함)
  2  실행 실패
`)
	os.Exit(exitError)
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(exitError)
}
