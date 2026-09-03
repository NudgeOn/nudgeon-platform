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
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/config"
	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/dlq"
	libqueue "github.com/nudgeon/nudgeon-platform/packages/libqueue-go"
)

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	required := []string{"DATABASE_URL"}
	if os.Args[1] == "replay" {
		required = append(required, "REDIS_URL")
	}
	cfg, err := config.Load(required...)
	if err != nil {
		log.Fatalf("설정 로드: %v", err)
	}
	ctx := context.Background()
	pg, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("PG 연결: %v", err)
	}
	defer pg.Close()
	var rdb *redis.Client
	if os.Args[1] == "replay" {
		ropts, err := redis.ParseURL(cfg.RedisURL)
		if err != nil {
			log.Fatalf("REDIS_URL 파싱: %v", err)
		}
		rdb = redis.NewClient(ropts)
		defer rdb.Close()
	}

	switch os.Args[1] {
	case "list":
		listDLQ(ctx, pg, os.Args[2:])
	case "replay":
		replayDLQ(ctx, pg, rdb, os.Args[2:])
	case "resolve":
		if err := resolveDLQ(ctx, pg, os.Args[2:]); err != nil {
			log.Fatalf("resolve: %v", err)
		}
	default:
		usage()
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: dlq list [--tenant <uuid>] [--limit N] | dlq replay <idempotency_key> | dlq replay --all [--tenant <uuid>] | dlq resolve --tenant <uuid> --id <uuid> --created-at <RFC3339> --note <incident-reference> --verified")
	os.Exit(2)
}

func listDLQ(ctx context.Context, pg *pgxpool.Pool, args []string) {
	fs := flag.NewFlagSet("list", flag.ExitOnError)
	tenant := fs.String("tenant", "", "테넌트 필터")
	limit := fs.Int("limit", 100, "최대 건수")
	_ = fs.Parse(args)

	rows, err := pg.Query(ctx, `
		SELECT id, tenant_id, app_id, idempotency_key, COALESCE(message_id::text,''),
		       failure_class, attempts, created_at, replayed_at, resolved_at
		  FROM send_dlq
		 WHERE ($1 = '' OR tenant_id = $1::uuid)
		 ORDER BY created_at DESC LIMIT $2`, *tenant, *limit)
	if err != nil {
		log.Fatalf("조회: %v", err)
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var id, tid, aid, idem, mid, class string
		var attempts int
		var created time.Time
		var replayed, resolved any
		if err := rows.Scan(&id, &tid, &aid, &idem, &mid, &class, &attempts, &created, &replayed, &resolved); err != nil {
			log.Fatalf("scan: %v", err)
		}
		fmt.Printf("id=%s tenant=%s app=%s idem=%s msg=%s class=%s attempts=%d created=%s replayed=%v resolved=%v\n",
			id, tid, aid, idem, mid, class, attempts, created.UTC().Format(time.RFC3339Nano), replayed, resolved)
		n++
	}
	fmt.Printf("총 %d건\n", n)
}

func resolveDLQ(ctx context.Context, pg dlq.Execer, args []string) error {
	fs := flag.NewFlagSet("resolve", flag.ContinueOnError)
	tenant := fs.String("tenant", "", "대상 tenant UUID")
	id := fs.String("id", "", "대상 DLQ row UUID")
	created := fs.String("created-at", "", "조회한 실패 created_at (RFC3339Nano)")
	note := fs.String("note", "", "검증/승인 근거 (비밀 없는 incident 참조)")
	verified := fs.Bool("verified", false, "공급자·message_log 결과 또는 승인된 폐기 근거를 확인함")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if !*verified || fs.NArg() != 0 {
		return fmt.Errorf("--verified 확인 및 정확한 대상 플래그가 필요합니다; 재발행만으로 완료 처리하지 마세요")
	}
	observed, err := time.Parse(time.RFC3339Nano, *created)
	if err != nil {
		return fmt.Errorf("--created-at RFC3339 timestamp required")
	}
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := dlq.Resolve(queryCtx, pg, *tenant, *id, observed, *note); err != nil {
		return err
	}
	fmt.Println("DLQ 항목 1건에 운영자 확인 완료를 기록했습니다. 실제 발송은 실행하지 않았습니다.")
	return nil
}

func replayDLQ(ctx context.Context, pg *pgxpool.Pool, rdb *redis.Client, args []string) {
	fs := flag.NewFlagSet("replay", flag.ExitOnError)
	all := fs.Bool("all", false, "전량 재처리")
	tenant := fs.String("tenant", "", "테넌트 필터(--all과 함께)")
	_ = fs.Parse(args)

	producer := libqueue.NewProducer(rdb, 0)

	sql := `SELECT tenant_id, idempotency_key, envelope FROM send_dlq WHERE idempotency_key = $1 AND resolved_at IS NULL`
	sqlArgs := []any{}
	if *all {
		sql = `SELECT tenant_id, idempotency_key, envelope FROM send_dlq
		        WHERE replayed_at IS NULL AND resolved_at IS NULL AND ($1 = '' OR tenant_id = $1::uuid)`
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
