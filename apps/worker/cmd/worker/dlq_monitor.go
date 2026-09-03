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
	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/dlq"
	"github.com/nudgeon/nudgeon-platform/apps/worker/internal/metrics"
	"github.com/prometheus/client_golang/prometheus"
	"golang.org/x/sync/errgroup"
)

func runDLQMonitor(logger *slog.Logger) error {
	cfg, err := config.Load("DATABASE_URL")
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	poolCfg, err := pgxpool.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("DLQ monitor database configuration invalid")
	}
	poolCfg.MaxConns = 1
	poolCfg.MinConns = 0
	poolCfg.ConnConfig.ConnectTimeout = metrics.DLQQueryTimeout
	poolCfg.ConnConfig.RuntimeParams["default_transaction_read_only"] = "on"
	poolCfg.ConnConfig.RuntimeParams["statement_timeout"] = "2000"
	pg, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		return fmt.Errorf("DLQ monitor database pool unavailable")
	}
	defer pg.Close()
	collector := metrics.NewDLQCollector(clock.Real{}, func(ctx context.Context) ([]dlq.Bucket, error) { return dlq.Snapshot(ctx, pg) })
	if err := prometheus.Register(collector); err != nil {
		return err
	}
	defer prometheus.Unregister(collector)
	probe := newReadinessProbe(map[string]readinessCheck{"dlq_snapshot": collector.Ready}, nil)
	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() error { return collector.Run(gctx) })
	g.Go(func() error { return serveHealth(gctx, cfg.HealthAddr, logger, probe) })
	logger.Info("DLQ monitor started", "read_only", true, "max_connections", 1)
	return g.Wait()
}
