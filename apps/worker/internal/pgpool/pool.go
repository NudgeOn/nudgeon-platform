// Package pgpool — 워커 프로세스의 PostgreSQL 풀. 세션 파라미터를 한곳에서 정한다.
package pgpool

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

// IdleInTransactionTimeout — 트랜잭션을 연 채 멈춘 세션을 PG가 끊는 시간.
//
// 워커가 kill -9로 죽으면 FOR UPDATE를 잡은 채 열려 있던 트랜잭션이 남는다. 커널이 FIN을 보내지 않는
// 경우(컨테이너 네트워크 네임스페이스 소멸) PG는 TCP keepalive(기본 2시간)까지 그 연결을 산 것으로
// 보고 잠금을 풀지 않는다. M-4 카오스(2026-09-10)에서 리퍼 UPDATE가 그 잠금에 막혀 회수가 10분
// 늦어졌다. 워커의 어떤 트랜잭션도 문장 사이에서 이 시간 이상 쉬지 않는다(노드 실행·릴레이 배치는
// 초 단위).
const IdleInTransactionTimeout = "30s"

// New — 워커용 풀. 세션마다 idle_in_transaction_session_timeout을 건다.
func New(ctx context.Context, url string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("PG URL 파싱: %w", err)
	}
	if cfg.ConnConfig.RuntimeParams == nil {
		cfg.ConnConfig.RuntimeParams = map[string]string{}
	}
	cfg.ConnConfig.RuntimeParams["idle_in_transaction_session_timeout"] = IdleInTransactionTimeout
	// 스케줄러 틱이 노드를 병렬 실행하고(journey.tickConcurrency) 릴레이·채널·수집이 같은 풀을 쓴다.
	// pgxpool 기본값(max(4, NumCPU))은 컨테이너에서 4까지 내려가 병렬 실행이 풀 대기로 직렬화된다.
	if cfg.MaxConns < 32 && !strings.Contains(url, "pool_max_conns") {
		cfg.MaxConns = 32
	}
	return pgxpool.NewWithConfig(ctx, cfg)
}
