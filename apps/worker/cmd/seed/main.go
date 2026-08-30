// onda-seed — 합성 데이터 생성기 (DEV-sub-08 S7).
// 지정 테넌트·앱에 유저 N명·디바이스·이벤트 M건을 PG/CH에 벌크 삽입한다.
// G-6 세그먼트 성능·PT 부하 테스트·데모 데이터의 전제.
//
//	go run ./apps/worker/cmd/seed --tenant <uuid> --app <uuid> --users 500000 --events-per-user 10
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"math/rand/v2"
	"os"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ondahq/onda/apps/worker/internal/config"
)

func main() {
	tenant := flag.String("tenant", "", "테넌트 UUID (필수)")
	app := flag.String("app", "", "앱 UUID (필수)")
	users := flag.Int("users", 10000, "생성할 유저 수")
	eventsPer := flag.Int("events-per-user", 10, "유저당 이벤트 수")
	batchSize := flag.Int("batch", 5000, "삽입 배치 크기")
	flag.Parse()

	if *tenant == "" || *app == "" {
		log.Fatal("--tenant 와 --app 은 필수입니다")
	}

	cfg := config.Load()
	ctx := context.Background()
	pg, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("PG 연결: %v", err)
	}
	defer pg.Close()

	chOpts, _ := clickhouse.ParseDSN(cfg.ClickHouseURL)
	ch, err := clickhouse.Open(chOpts)
	if err != nil {
		log.Fatalf("CH 연결: %v", err)
	}
	defer ch.Close()

	start := time.Now()
	countries := []string{"KR", "JP", "US", "GB", "DE"}
	events := []string{"app_open", "product_viewed", "add_to_cart", "purchase", "letter_opened"}

	// 결정적 난수 (재현 가능) — 시드는 유저 수 기반
	rng := rand.New(rand.NewPCG(uint64(*users), 42))

	userIDs := make([]string, 0, *batchSize)
	inserted := 0

	flushUsers := func() error {
		if len(userIDs) == 0 {
			return nil
		}
		batch := &pgx.Batch{}
		now := time.Now()
		for i, uid := range userIDs {
			country := countries[rng.IntN(len(countries))]
			vip := rng.IntN(6)
			ext := fmt.Sprintf("seed-%s-%d", (*app)[:8], inserted+i)
			batch.Queue(`
				INSERT INTO users (id, tenant_id, app_id, external_id, status, std_attrs, custom_attrs, subscriptions, last_seen_at)
				VALUES ($1, $2, $3, $4, 'active', $5, $6, '{"push":"opted_in"}', $7)
				ON CONFLICT DO NOTHING`,
				uid, *tenant, *app, ext,
				fmt.Sprintf(`{"country":"%s"}`, country),
				fmt.Sprintf(`{"vip_level":%d}`, vip), now)
			// 디바이스 1대
			batch.Queue(`
				INSERT INTO devices (id, tenant_id, app_id, user_id, platform, push_token, token_status, os_permission, last_active_at)
				VALUES ($1, $2, $3, $4, 'android', $5, 'active', 'granted', $6)
				ON CONFLICT DO NOTHING`,
				uuid.NewString(), *tenant, *app, uid, "seedtok-"+uid, now)
		}
		br := pg.SendBatch(ctx, batch)
		for range userIDs {
			if _, err := br.Exec(); err != nil {
				br.Close()
				return err
			}
			if _, err := br.Exec(); err != nil {
				br.Close()
				return err
			}
		}
		br.Close()
		return nil
	}

	for i := 0; i < *users; i++ {
		userIDs = append(userIDs, uuid.NewString())
		if len(userIDs) >= *batchSize {
			if err := flushUsers(); err != nil {
				log.Fatalf("유저 삽입: %v", err)
			}
			// 이벤트 CH 벌크
			if err := seedEvents(ctx, ch, *tenant, *app, userIDs, *eventsPer, events, rng); err != nil {
				log.Fatalf("이벤트 삽입: %v", err)
			}
			inserted += len(userIDs)
			fmt.Fprintf(os.Stderr, "\r진행: %d/%d 유저 (%s)", inserted, *users, time.Since(start).Round(time.Second))
			userIDs = userIDs[:0]
		}
	}
	if err := flushUsers(); err != nil {
		log.Fatalf("유저 삽입(마지막): %v", err)
	}
	if err := seedEvents(ctx, ch, *tenant, *app, userIDs, *eventsPer, events, rng); err != nil {
		log.Fatalf("이벤트 삽입(마지막): %v", err)
	}
	inserted += len(userIDs)

	fmt.Fprintf(os.Stderr, "\n완료: 유저 %d명, 이벤트 ~%d건, 소요 %s\n",
		inserted, inserted**eventsPer, time.Since(start).Round(time.Second))
}

func seedEvents(ctx context.Context, ch driver.Conn, tenant, app string, userIDs []string, perUser int, events []string, rng *rand.Rand) error {
	batch, err := ch.PrepareBatch(ctx, `INSERT INTO events
		(tenant_id, app_id, event_name, user_id, device_id, properties, client_ts, server_ts, insert_id)`)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	for _, uid := range userIDs {
		for j := 0; j < perUser; j++ {
			ts := now.Add(-time.Duration(rng.IntN(30*24)) * time.Hour)
			if err := batch.Append(
				tenant, app, events[rng.IntN(len(events))], uid,
				"00000000-0000-0000-0000-000000000000", "{}", ts, ts, uuid.NewString(),
			); err != nil {
				return err
			}
		}
	}
	return batch.Send()
}
