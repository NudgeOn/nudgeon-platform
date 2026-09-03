import { Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { Counter, Gauge, Histogram, Registry } from "@prometheus-io/client";
import { createServer, type Server } from "node:http";
import { performance } from "node:perf_hooks";
import type { RequestHandler } from "express";
import type { Pool } from "pg";
import type { ReceiptObserver, ReceiptStage } from "../ingestion/receipt-observer";

const buckets = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10];

/** Private, opt-in listener. Scrapes read in-memory state only, never query DBs.
 * No identity, URL, SQL text, payload or exception is used as a metric label. */
@Injectable()
export class CapacityMetrics implements ReceiptObserver, OnApplicationBootstrap, OnApplicationShutdown {
  readonly registry = new Registry();
  private readonly started = new Counter({ name: "nudgeon_api_track_started_total", help: "Track HTTP requests reaching the API, before parsing and admission", registers: [this.registry] });
  private readonly completed = new Counter({ name: "nudgeon_api_track_completed_total", help: "Track responses finished at the server, not proof of client receipt", labelNames: ["status_class"], registers: [this.registry] });
  private readonly aborted = new Counter({ name: "nudgeon_api_track_aborted_total", help: "Track responses closed before finish; may still commit", registers: [this.registry] });
  private readonly inflight = new Gauge({ name: "nudgeon_api_track_inflight", help: "Track responses not yet finished or closed", registers: [this.registry] });
  private readonly httpDuration = new Histogram({ name: "nudgeon_api_track_duration_seconds", help: "Server track request lifetime through finish or abort", labelNames: ["outcome"], buckets, registers: [this.registry] });
  private readonly admitted = new Counter({ name: "nudgeon_api_receipts_committed_total", help: "New unique receipts with successful PG COMMIT acknowledgement, excluding replays", registers: [this.registry] });
  private readonly duplicates = new Counter({ name: "nudgeon_api_receipt_duplicates_total", help: "Submitted events omitted as duplicates in successful transactions", registers: [this.registry] });
  private readonly retries = new Counter({ name: "nudgeon_api_receipt_retries_total", help: "Retried receipt transactions, not unique events", registers: [this.registry] });
  private readonly stages = new Histogram({ name: "nudgeon_api_receipt_stage_seconds", help: "Receipt operation attempts including network and server wait; SQL stages are not pure lock wait", labelNames: ["stage", "outcome"], buckets, registers: [this.registry] });
  private server?: Server;
  private readonly keyUsage = new Counter({ name: "nudgeon_api_key_usage_total", help: "Best-effort last_used_at decisions and write outcomes; not authorization or event counts", labelNames: ["outcome"], registers: [this.registry] });
  private readonly keyUsagePending = new Gauge({ name: "nudgeon_api_key_usage_pending", help: "Pending last_used_at writes, including pool acquisition", registers: [this.registry] });
  private readonly keyUsageDuration = new Histogram({ name: "nudgeon_api_key_usage_write_seconds", help: "last_used_at pool acquisition plus SQL/autocommit attempt latency", labelNames: ["outcome"], buckets, registers: [this.registry] });

  keyUsageOutcome(outcome: "recent" | "coalesced" | "budget") { this.keyUsage.inc({ outcome }); }
  keyUsageStarted() { this.keyUsage.inc({ outcome: "scheduled" }); this.keyUsagePending.inc(); }
  keyUsageFinished(outcome: "updated" | "noop" | "error", seconds: number) {
    this.keyUsage.inc({ outcome }); this.keyUsagePending.dec(); this.keyUsageDuration.observe({ outcome }, seconds);
  }

  readonly middleware: RequestHandler = (req, res, next) => {
    if (req.method !== "POST" || !/^\/v1\/track\/?$/i.test(req.path)) { next(); return; }
    const start = performance.now();
    this.started.inc(); this.inflight.inc();
    let done = false;
    const finish = () => end(true);
    const close = () => end(false);
    const end = (finished: boolean) => {
      if (done) return;
      done = true;
      res.off("finish", finish); res.off("close", close);
      this.inflight.dec();
      if (finished) {
        const status = Math.floor(res.statusCode / 100);
        this.completed.inc({ status_class: status >= 1 && status <= 5 ? `${status}xx` : "other" });
      } else this.aborted.inc();
      this.httpDuration.observe({ outcome: finished ? "finished" : "aborted" }, (performance.now() - start) / 1000);
    };
    res.once("finish", finish); res.once("close", close);
    next();
  };

  committed(unique: number, submitted: number) { this.admitted.inc(unique); this.duplicates.inc(submitted - unique); }
  retry() { this.retries.inc(); }
  async measure<T>(stage: ReceiptStage, work: () => Promise<T>): Promise<T> {
    const start = performance.now();
    let outcome = "error";
    try { const value = await work(); outcome = "success"; return value; }
    finally { this.stages.observe({ stage, outcome }, (performance.now() - start) / 1000); }
  }

  registerPool(pg: Pool) {
    new Gauge({ name: "nudgeon_api_pg_pool_connections", help: "API PG pool snapshot (no query)", labelNames: ["state"], registers: [this.registry],
      collect() { this.set({ state: "total" }, pg.totalCount); this.set({ state: "idle" }, pg.idleCount); this.set({ state: "waiting" }, pg.waitingCount); },
    });
  }

  async onApplicationBootstrap() {
    const raw = process.env.METRICS_PORT;
    if (raw === undefined) return;
    const port = Number(raw);
    if (!/^\d+$/.test(raw) || port < 1 || port > 65535) throw new Error("METRICS_PORT must be 1..65535");
    new Gauge({ name: "nudgeon_api_build_info", help: "Runtime build identity; unknown is not verified source evidence", labelNames: ["revision", "source_sha256"], registers: [this.registry] })
      .set({ revision: process.env.BUILD_REVISION ?? "unknown", source_sha256: process.env.BUILD_SOURCE_SHA256 ?? "unknown" }, 1);
    const server = this.server = createServer((req, res) => {
      if (req.method !== "GET" || req.url !== "/metrics") { res.writeHead(404).end(); return; }
      void this.registry.metrics().then(text => {
        if (!res.destroyed) res.writeHead(200, { "Content-Type": this.registry.contentType }).end(text);
      }, () => { if (!res.destroyed) res.writeHead(500).end(); });
    });
    server.requestTimeout = 5000; server.headersTimeout = 5000; server.timeout = 5000;
    server.maxConnections = 16;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, process.env.METRICS_HOST ?? "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
  }
  async onApplicationShutdown() {
    if (!this.server?.listening) return;
    const server = this.server;
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}
