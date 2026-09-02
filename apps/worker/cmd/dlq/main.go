// cmd/dlq — 발송 DLQ 운영 도구 (R-02). 재시도 소진된 send.push를 조회·재처리(replay)한다.
//
//	dlq list [--tenant <uuid>] [--limit N]
//	dlq replay <idempotency_key>      # 특정 항목 재처리
//	dlq replay --all [--tenant <uuid>]  # 전량 재처리
//
// replay: 저장된 원본 envelope를 send.push 스트림에 재발행하고, 멱등 상태 키를 제거해
// 채널 워커가 다시 처리하도록 한다. replayed_at을 기록한다.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/config"
	libqueue "github.com/nudgeon/nudgeon-platform/packages/libqueue-go"
)

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	cfg, err := config.Load("DATABASE_URL", "REDIS_URL")
	if err != nil {
		log.Fatalf("설정 로드: %v", err)
	}
	ctx := context.Background()
	pg, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("PG 연결: %v", err)
	}
	defer pg.Close()
	ropts, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		log.Fatalf("REDIS_URL 파싱: %v", err)
	}
	rdb := redis.NewClient(ropts)
	defer rdb.Close()

	switch os.Args[1] {
	case "list":
		listDLQ(ctx, pg, os.Args[2:])
	case "replay":
		replayDLQ(ctx, pg, rdb, os.Args[2:])
	default:
		usage()
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: dlq list [--tenant <uuid>] [--limit N] | dlq replay <idempotency_key> | dlq replay --all [--tenant <uuid>]")
	os.Exit(2)
}

func listDLQ(ctx context.Context, pg *pgxpool.Pool, args []string) {
	fs := flag.NewFlagSet("list", flag.ExitOnError)
	tenant := fs.String("tenant", "", "테넌트 필터")
	limit := fs.Int("limit", 100, "최대 건수")
	_ = fs.Parse(args)

	rows, err := pg.Query(ctx, `
		SELECT tenant_id, app_id, idempotency_key, COALESCE(message_id::text,''),
		       failure_class, attempts, created_at, replayed_at
		  FROM send_dlq
		 WHERE ($1 = '' OR tenant_id = $1::uuid)
		 ORDER BY created_at DESC LIMIT $2`, *tenant, *limit)
	if err != nil {
		log.Fatalf("조회: %v", err)
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var tid, aid, idem, mid, class string
		var attempts int
		var created, replayed any
		if err := rows.Scan(&tid, &aid, &idem, &mid, &class, &attempts, &created, &replayed); err != nil {
			log.Fatalf("scan: %v", err)
		}
		fmt.Printf("tenant=%s app=%s idem=%s msg=%s class=%s attempts=%d created=%v replayed=%v\n",
			tid, aid, idem, mid, class, attempts, created, replayed)
		n++
	}
	fmt.Printf("총 %d건\n", n)
}

func replayDLQ(ctx context.Context, pg *pgxpool.Pool, rdb *redis.Client, args []string) {
	fs := flag.NewFlagSet("replay", flag.ExitOnError)
	all := fs.Bool("all", false, "전량 재처리")
	tenant := fs.String("tenant", "", "테넌트 필터(--all과 함께)")
	_ = fs.Parse(args)

	producer := libqueue.NewProducer(rdb, 0)

	sql := `SELECT tenant_id, idempotency_key, envelope FROM send_dlq WHERE idempotency_key = $1`
	sqlArgs := []any{}
	if *all {
		sql = `SELECT tenant_id, idempotency_key, envelope FROM send_dlq
		        WHERE replayed_at IS NULL AND ($1 = '' OR tenant_id = $1::uuid)`
		sqlArgs = []any{*tenant}
	} else {
		if fs.NArg() < 1 {
			usage()
		}
		sqlArgs = []any{fs.Arg(0)}
	}
	rows, err := pg.Query(ctx, sql, sqlArgs...)
	if err != nil {
		log.Fatalf("조회: %v", err)
	}
	type item struct {
		tenant, idem string
		env          []byte
	}
	var items []item
	for rows.Next() {
		var it item
		if err = rows.Scan(&it.tenant, &it.idem, &it.env); err != nil {
			rows.Close()
			log.Fatalf("scan: %v", err)
		}
		items = append(items, it)
	}
	rows.Close()

	replayed := 0
	for _, it := range items {
		var env libqueue.Envelope
		if err := json.Unmarshal(it.env, &env); err != nil {
			log.Printf("skip %s: envelope 파싱 실패: %v", it.idem, err)
			continue
		}
		// 멱등 상태 제거 → 채널 워커가 재처리하도록.
		rdb.Del(ctx, "send:idem:"+it.tenant+":"+it.idem,
			"send:attempts:"+it.tenant+":"+it.idem, "send:retryat:"+it.tenant+":"+it.idem)
		if _, err := producer.Publish(ctx, libqueue.StreamSendPush, &env); err != nil {
			log.Printf("재발행 실패 %s: %v", it.idem, err)
			continue
		}
		if _, err := pg.Exec(ctx, `UPDATE send_dlq SET replayed_at = now() WHERE tenant_id=$1 AND idempotency_key=$2`,
			it.tenant, it.idem); err != nil {
			log.Printf("replayed_at 기록 실패 %s: %v", it.idem, err)
		}
		replayed++
	}
	fmt.Printf("재처리 %d건 발행\n", replayed)
}
