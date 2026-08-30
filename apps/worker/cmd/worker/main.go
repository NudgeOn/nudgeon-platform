// onda-worker — Go 단일 바이너리 + --role 플래그 (PRD-08 2장).
// roles: ingest-consumer | scheduler | trigger-matcher | segment | channel | all
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"golang.org/x/sync/errgroup"

	"github.com/ondahq/onda/apps/worker/internal/channel"
	"github.com/ondahq/onda/apps/worker/internal/clock"
	"github.com/ondahq/onda/apps/worker/internal/config"
	"github.com/ondahq/onda/apps/worker/internal/ingest"
	"github.com/ondahq/onda/apps/worker/internal/journey"
	"github.com/ondahq/onda/apps/worker/internal/trigger"
	libqueue "github.com/ondahq/onda/packages/libqueue-go"
)

var validRoles = map[string]bool{
	"ingest-consumer": true, "scheduler": true, "trigger-matcher": true,
	"segment": true, "channel": true, "all": true,
}

func main() {
	role := flag.String("role", "all", "worker 역할: ingest-consumer|scheduler|trigger-matcher|segment|channel|all")
	flag.Parse()

	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("role", *role)
	if !validRoles[*role] {
		logger.Error("알 수 없는 role", "role", *role)
		os.Exit(2)
	}

	if err := run(*role, logger); err != nil && err != context.Canceled {
		logger.Error("worker 종료", "err", err)
		os.Exit(1)
	}
}

func run(role string, logger *slog.Logger) error {
	cfg := config.Load()
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// --- 인프라 연결 (조립 지점 — Real clock은 여기서만) ---
	clk := clock.Real{}

	redisOpts, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		return fmt.Errorf("REDIS_URL 파싱: %w", err)
	}
	rdb := redis.NewClient(redisOpts)
	defer rdb.Close()

	pg, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("PG 연결: %w", err)
	}
	defer pg.Close()

	chOpts, err := clickhouse.ParseDSN(cfg.ClickHouseURL)
	if err != nil {
		return fmt.Errorf("CLICKHOUSE_URL 파싱: %w", err)
	}
	ch, err := clickhouse.Open(chOpts)
	if err != nil {
		return fmt.Errorf("ClickHouse 연결: %w", err)
	}
	defer ch.Close()

	g, gctx := errgroup.WithContext(ctx)

	// --- 헬스 엔드포인트 ---
	g.Go(func() error { return serveHealth(gctx, cfg.HealthAddr, logger) })

	has := func(r string) bool { return role == "all" || role == r }

	hostname, _ := os.Hostname()

	if has("ingest-consumer") {
		consumer := ingest.NewConsumer(
			libqueue.NewConsumer(rdb, libqueue.StreamIngest, libqueue.GroupIngest, "ingest-"+hostname),
			libqueue.NewProducer(rdb, 0),
			ingest.NewDeduper(rdb),
			pg, ch, clk, logger.With("component", "ingest-consumer"),
		)
		g.Go(func() error { return consumer.Run(gctx) })
	}

	if has("channel") {
		masterKey, err := channel.LoadMasterKey()
		if err != nil {
			if role == "channel" {
				return fmt.Errorf("channel 역할은 마스터키 필수: %w", err)
			}
			logger.Warn("마스터키 미설정 — channel 역할 비활성 (ONDA_MASTER_KEY 설정 필요)", "err", err)
		} else {
			plugin := channel.NewPushPlugin(clk)
			verifier := channel.NewVerifier(pg, plugin, masterKey, logger.With("component", "credential-verifier"))
			worker := channel.NewWorker(
				libqueue.NewConsumer(rdb, libqueue.StreamSendPush, libqueue.GroupChannel, "channel-"+hostname),
				rdb, pg, ch, plugin, masterKey, clk, logger.With("component", "channel"),
			)
			g.Go(func() error { return verifier.Run(gctx) })
			g.Go(func() error { return worker.Run(gctx) })
		}
	}

	if has("scheduler") {
		sched := journey.NewScheduler(
			libqueue.NewConsumer(rdb, libqueue.StreamJourneyEntry, libqueue.GroupScheduler, "sched-"+hostname),
			libqueue.NewProducer(rdb, 0),
			pg, ch, clk, "sched-"+hostname, logger.With("component", "scheduler"),
		)
		g.Go(func() error { return sched.RunEntryConsumer(gctx) })
		g.Go(func() error { return sched.RunTick(gctx) })
		g.Go(func() error { return sched.RunRelay(gctx) })
		g.Go(func() error { return sched.RunReaper(gctx) })
	}

	if has("trigger-matcher") {
		matcher := trigger.NewMatcher(
			libqueue.NewConsumer(rdb, libqueue.StreamEvents, libqueue.GroupTriggerMatcher, "trig-"+hostname),
			libqueue.NewProducer(rdb, 0),
			rdb, pg, clk, logger.With("component", "trigger-matcher"),
		)
		g.Go(func() error { return matcher.Run(gctx) })
	}

	for _, stub := range []string{"segment"} {
		if has(stub) && role != "all" {
			logger.Warn("role 미구현 — 야간 대사 잡은 S4+ 예정", "role", stub)
		}
	}

	logger.Info("onda-worker 기동", "roles", roleList(role))
	return g.Wait()
}

func roleList(role string) string {
	if role == "all" {
		return strings.Join([]string{"ingest-consumer", "channel", "scheduler", "trigger-matcher"}, ",") + " (+미구현 stub 생략)"
	}
	return role
}

func serveHealth(ctx context.Context, addr string, logger *slog.Logger) error {
	r := chi.NewRouter()
	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	srv := &http.Server{Addr: addr, Handler: r}
	go func() {
		<-ctx.Done()
		_ = srv.Shutdown(context.Background())
	}()
	logger.Info("health 리슨", "addr", addr)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}
