import { Logger, type INestApplication } from "@nestjs/common";
import type { Server } from "node:http";
import { ShutdownState } from "./shutdown-state";

export const SHUTDOWN_BUDGET = { requestsMs: 10_000, backgroundMs: 2_000, clientsMs: 1_500, hardMs: 14_000 } as const;
type ShutdownBudget = { [K in keyof typeof SHUTDOWN_BUDGET]: number };

/** Resolve on timeout but keep a rejection handler attached to late work. */
export async function bounded(work: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(() => true, () => false),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

export async function drainApplication(
  app: Pick<INestApplication, "close" | "getHttpServer">,
  state: ShutdownState,
  log: (event: Record<string, unknown>) => void,
  budget: ShutdownBudget = SHUTDOWN_BUDGET,
): Promise<boolean> {
  state.beginDrain();
  log({ event: "shutdown_drain_started", ...state.snapshot() });
  const requestsDrained = await state.waitForRequests(budget.requestsMs);
  log({ event: "shutdown_requests_drained", complete: requestsDrained, ...state.snapshot() });

  // The gate already rejects new work. Stop TCP admission before closing sockets,
  // including peers that never finished HTTP headers and never reached middleware.
  const server = app.getHttpServer() as Server;
  const httpClosed = new Promise<void>((resolve, reject) => server.close(error => {
    if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
    else resolve();
  }));
  server.closeAllConnections();
  const httpDrained = await bounded(httpClosed, budget.clientsMs);
  const backgroundDrained = await state.waitForBackground(budget.backgroundMs);
  log({ event: "shutdown_background_drained", complete: backgroundDrained, ...state.snapshot() });
  // app.close still invokes Nest lifecycle hooks after the HTTP listener closes.
  // InfraModule owns pg.end / redis.quit / clickhouse.close, including deadlines.
  const clientsClosed = await bounded(app.close(), budget.clientsMs);
  const complete = requestsDrained && httpDrained && backgroundDrained && clientsClosed;
  log({ event: "shutdown_complete", complete, ...state.snapshot() });
  return complete;
}

/** Own signal handling instead of re-signalling PID 1 after Nest hooks return. */
export function installShutdown(app: INestApplication, state: ShutdownState) {
  const logger = new Logger("Shutdown");
  let started = false;
  const stop = (signal: string) => {
    if (started) return;
    started = true;
    state.beginDrain(); // synchronous: no request admitted after signal handling
    const startedAt = performance.now();
    const log = (event: Record<string, unknown>) => logger.log(JSON.stringify({ ...event, signal, elapsed_ms: Math.round(performance.now() - startedAt) }));
    const watchdog = setTimeout(() => {
      log({ event: "shutdown_deadline_exceeded", ...state.snapshot() });
      process.exit(1); // a forced shutdown must never masquerade as a clean exit
    }, SHUTDOWN_BUDGET.hardMs);
    void drainApplication(app, state, log).then(complete => {
      if (!complete) { process.exitCode = 1; return; }
      process.exitCode = 0;
      // Natural exit proves handles were closed. Keep a non-blocking watchdog:
      // an unexpected live socket/timer will fail at the hard deadline, not hang.
      watchdog.unref();
    }).catch(() => {
      process.exitCode = 1;
      log({ event: "shutdown_failed", ...state.snapshot() });
    });
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => stop(signal));
}
