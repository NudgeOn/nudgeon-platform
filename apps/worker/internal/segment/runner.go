package segment

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/clock"
)

// defaultInterval — 정기 세그먼트 평가 주기. 통계(last_count) 신선도와 CH 부하의 절충.
const defaultInterval = 60 * time.Second

// Runner — segment role. 활성/broken 세그먼트를 주기적으로 컴파일·평가해 통계(last_count·
// last_evaluated_at)를 갱신하고, 컴파일 실패(화이트리스트 위반·잘못된 값)를 broken으로 표시한다.
// 평가 카운트는 CH profiles_mirror(속성/채널) + events(행동) 단일 쿼리로 산출한다.
type Runner struct {
	pg       *pgxpool.Pool
	ch       driver.Conn
	clk      clock.Clock
	logger   *slog.Logger
	interval time.Duration
}

func NewRunner(pg *pgxpool.Pool, ch driver.Conn, clk clock.Clock, logger *slog.Logger) *Runner {
	return &Runner{pg: pg, ch: ch, clk: clk, logger: logger, interval: defaultInterval}
}

// RunMaintenance — 기동 즉시 1회 평가 후 interval 주기로 반복. ctx 취소 시 종료.
func (r *Runner) RunMaintenance(ctx context.Context) error {
	r.logger.Info("segment 정기 평가 시작", "interval", r.interval.String())
	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()
	r.evaluateAll(ctx)
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			r.evaluateAll(ctx)
		}
	}
}

type segRow struct {
	id       string
	tenantID string
	appID    string
	def      []byte
}

// evaluateAll — 활성·broken 세그먼트를 모두 재평가한다(broken은 정의 수정 시 자동 회복 가능).
// 개별 세그먼트 실패는 로그만 남기고 다음으로 진행(한 세그먼트가 잡 전체를 막지 않는다).
func (r *Runner) evaluateAll(ctx context.Context) {
	rows, err := r.pg.Query(ctx,
		`SELECT id, tenant_id, app_id, definition FROM segments
		  WHERE status IN ('active','broken')`)
	if err != nil {
		r.logger.Error("세그먼트 목록 조회 실패", "err", err)
		return
	}
	var segs []segRow
	for rows.Next() {
		var s segRow
		if err := rows.Scan(&s.id, &s.tenantID, &s.appID, &s.def); err != nil {
			r.logger.Error("세그먼트 행 스캔 실패", "err", err)
			continue
		}
		segs = append(segs, s)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		r.logger.Error("세그먼트 커서 오류", "err", err)
		return
	}

	for _, s := range segs {
		if ctx.Err() != nil {
			return
		}
		if err := r.evaluateOne(ctx, s); err != nil {
			r.logger.Error("세그먼트 평가 실패", "segment", s.id, "err", err)
		}
	}
}

// evaluateOne — 한 세그먼트를 컴파일·카운트하고 통계를 갱신한다.
// 컴파일 오류(CompileError)는 broken으로 표시(발송 대상 오포함 방지). 그 외 오류는 상위로 반환.
func (r *Runner) evaluateOne(ctx context.Context, s segRow) error {
	var dsl DSL
	if err := json.Unmarshal(s.def, &dsl); err != nil {
		return r.markBroken(ctx, s, fmt.Sprintf("정의 파싱 실패: %v", err))
	}
	// 카운트는 마케팅 카테고리로 산출(push_reachable 조합은 채널 조건이 있을 때만 영향).
	compiled, err := Compile(&dsl, s.tenantID, s.appID, Marketing)
	if err != nil {
		var ce *CompileError
		if errors.As(err, &ce) {
			return r.markBroken(ctx, s, ce.Reason)
		}
		return err
	}
	countSQL := "SELECT count() AS n FROM (" + compiled.SQL + ")"
	var n uint64
	if err := r.ch.QueryRow(ctx, countSQL, compiled.Args...).Scan(&n); err != nil {
		return fmt.Errorf("CH 카운트: %w", err)
	}
	if _, err := r.pg.Exec(ctx,
		`UPDATE segments SET last_count = $3, last_evaluated_at = $4,
		        status = 'active', status_detail = NULL, updated_at = $4
		  WHERE id = $1 AND tenant_id = $2`,
		s.id, s.tenantID, int64(n), r.clk.Now()); err != nil {
		return fmt.Errorf("통계 갱신: %w", err)
	}
	return nil
}

// markBroken — 세그먼트를 broken으로 표시(사유 기록). 저니 활성화는 broken 세그먼트를 거부한다.
func (r *Runner) markBroken(ctx context.Context, s segRow, reason string) error {
	if _, err := r.pg.Exec(ctx,
		`UPDATE segments SET status = 'broken', status_detail = $3, last_evaluated_at = $4, updated_at = $4
		  WHERE id = $1 AND tenant_id = $2`,
		s.id, s.tenantID, reason, r.clk.Now()); err != nil {
		return fmt.Errorf("broken 표시: %w", err)
	}
	r.logger.Warn("세그먼트 broken 표시", "segment", s.id, "reason", reason)
	return nil
}
