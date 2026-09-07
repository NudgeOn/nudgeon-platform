package main

import (
	"context"
	"fmt"
	"log/slog"
	"os/signal"
	"syscall"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/clock"
	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/config"
	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/metrics"
	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/ops"
	libqueue "github.com/nudgeon/nudgeon-platform/packages/libqueue-go"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/redis/go-redis/v9"
	"golang.org/x/sync/errgroup"
)

// Unlike dlq-monitor (PG only), this opt-in role observes PG and one standalone
// Redis database. It starts no consumers, sends nothing and needs no CH/master
// key. Provision SELECT-only PG and read-only Redis ACLs; do not expose metrics
// outside the private operations network.
func runOpsMonitor(logger *slog.Logger) error {
	cfg, err := config.Load("DATABASE_URL", "REDIS_URL")
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	poolCfg, err := pgxpool.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("ops monitor database configuration invalid")
	}
	poolCfg.MaxConns, poolCfg.MinConns = 1, 0
	poolCfg.ConnConfig.ConnectTimeout = metrics.DLQQueryTimeout
	poolCfg.ConnConfig.RuntimeParams["default_transaction_read_only"] = "on"
	poolCfg.ConnConfig.RuntimeParams["statement_timeout"] = "2000"
	poolCfg.ConnConfig.RuntimeParams["application_name"] = "nudgeon-ops-monitor"
	pg, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		return fmt.Errorf("ops monitor database pool unavailable")
	}
	defer pg.Close()
	opts, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		return fmt.Errorf("ops monitor Redis configuration invalid")
	}
	opts.PoolSize, opts.MaxActiveConns, opts.MinIdleConns = 2, 2, 0
	opts.MaxRetries = -1
	opts.ContextTimeoutEnabled = true
	opts.DialTimeout, opts.ReadTimeout, opts.WriteTimeout, opts.PoolTimeout = metrics.DLQQueryTimeout, metrics.DLQQueryTimeout, metrics.DLQQueryTimeout, metrics.DLQQueryTimeout
	rdb := redis.NewClient(opts)
	defer rdb.Close()
	clk := clock.Real{}
	collectors := map[string]*metrics.SnapshotCollector{
		"postgres": metrics.NewSnapshotCollector("postgres", clk, ops.PostgresDefinitions, func(ctx context.Context) (map[string]float64, error) { return ops.PostgresSnapshot(ctx, pg) }),
		"pending":  metrics.NewSnapshotCollector("pending", clk, ops.PendingDefinitions, func(ctx context.Context) (map[string]float64, error) { return ops.PendingSnapshot(ctx, rdb) }),
		"redis":    metrics.NewSnapshotCollector("redis", clk, ops.RedisDefinitions, func(ctx context.Context) (map[string]float64, error) { return ops.RedisSnapshot(ctx, rdb) }),
	}
	// 스트림 트림 유실 관측. backlog 경보는 "밀림"을 보지만 이건 "이미 잘려나갔는가"를 본다.
	queue := metrics.NewQueueCollector(clk, func(ctx context.Context) ([]ops.QueueStat, error) {
		return ops.QueueSnapshot(ctx, rdb, libqueue.DefaultMaxLen)
	})
	if err := prometheus.Register(queue); err != nil {
		return err
	}
	defer prometheus.Unregister(queue)

	checks := map[string]readinessCheck{"queue_snapshot": queue.Ready}
	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() error { return queue.Run(gctx) })
	for name, collector := range collectors {
		if err := prometheus.Register(collector); err != nil {
			return err
		}
		defer prometheus.Unregister(collector)
		checks[name+"_snapshot"] = collector.Ready
	}
	for _, collector := range collectors {
		g.Go(func() error { return collector.Run(gctx) })
	}
	probe := newReadinessProbe(checks, nil)
	g.Go(func() error { return serveHealth(gctx, cfg.HealthAddr, logger, probe) })
	logger.Info("operations monitor started", "read_only", true, "pg_max_connections", 1, "redis_max_connections", 2)
	return g.Wait()
}
