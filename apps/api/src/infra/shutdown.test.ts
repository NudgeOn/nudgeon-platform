import "reflect-metadata";
import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import { Logger, type INestApplication } from "@nestjs/common";
import type { Request, Response } from "express";
import type { Pool } from "pg";
import type Redis from "ioredis";
import type { ClickHouseClient } from "@clickhouse/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InfraModule } from "./infra.module";
import { ShutdownState } from "./shutdown-state";
import { bounded, drainApplication, installShutdown, SHUTDOWN_BUDGET } from "./shutdown";

function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function response() {
  return Object.assign(new EventEmitter(), { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() });
}
function request(state: ShutdownState) {
  const res = response(), next = vi.fn();
  state.middleware({} as Request, res as unknown as Response, next);
  return { res, next };
}
function appMock() {
  const calls: string[] = [];
  const server = { close: vi.fn(callback => { calls.push("http_close"); callback(); }), closeAllConnections: vi.fn(() => calls.push("http_connections_closed")) };
  const app = { getHttpServer: () => server as unknown as Server, close: vi.fn(async () => { calls.push("clients_close"); }) };
  return { app, server, calls };
}
const smallBudget = { requestsMs: 20, backgroundMs: 10, clientsMs: 10, hardMs: 100 };

describe("bounded API shutdown", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it("rejects new work before guards/body parsing with readiness 503 and connection close", () => {
    const state = new ShutdownState(); state.beginDrain();
    const { res, next } = request(state);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ ok: false, code: "shutting_down" });
    expect(res.setHeader).toHaveBeenCalledWith("Connection", "close");
    expect(res.setHeader).toHaveBeenCalledWith("Retry-After", "1");
    expect(state.activeRequests).toBe(0);
  });

  it("counts finish/close once, including disconnected peers", async () => {
    const state = new ShutdownState(), { res, next } = request(state);
    expect(next).toHaveBeenCalledOnce(); expect(state.activeRequests).toBe(1);
    const drained = state.waitForRequests(20);
    res.emit("close"); res.emit("finish");
    expect(await drained).toBe(true); expect(state.activeRequests).toBe(0);
  });

  it("drains existing responses and raw work before closing dependencies", async () => {
    const state = new ShutdownState(), { res } = request(state), raw = deferred();
    state.runBackground("raw_ingestions", () => raw.promise);
    const { app, calls } = appMock();
    const drained = drainApplication(app, state, vi.fn(), smallBudget);
    expect(state.draining).toBe(true); expect(calls).toEqual([]);
    res.emit("finish"); await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(["http_close", "http_connections_closed"]);
    raw.resolve();
    expect(await drained).toBe(true);
    expect(calls).toEqual(["http_close", "http_connections_closed", "clients_close"]);
    expect(state.snapshot().background.raw_ingestions).toBe(0);
  });

  it("request timeout closes sockets but is not reported as a clean shutdown", async () => {
    const state = new ShutdownState(); request(state);
    const { app, server } = appMock(), log = vi.fn();
    const drained = drainApplication(app, state, log, smallBudget);
    await vi.advanceTimersByTimeAsync(25);
    expect(await drained).toBe(false);
    expect(server.closeAllConnections).toHaveBeenCalledOnce();
    expect(app.close).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "shutdown_complete", complete: false }));
  });

  it("background timeout reports remaining raw work without hanging client cleanup", async () => {
    const state = new ShutdownState(); state.runBackground("raw_ingestions", () => new Promise(() => undefined));
    const { app } = appMock(), log = vi.fn();
    const drained = drainApplication(app, state, log, smallBudget);
    await vi.advanceTimersByTimeAsync(15);
    expect(await drained).toBe(false); expect(app.close).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "shutdown_background_drained", complete: false, background: { raw_ingestions: 1, api_key_last_used: 0 } }));
  });

  it("does not leak driver errors or reject a best-effort task into the process", async () => {
    const state = new ShutdownState(), log = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    state.runBackground("api_key_last_used", async () => { throw new Error("secret DSN"); });
    expect(await state.waitForBackground(20)).toBe(true);
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
  });

  it("retains a rejection handler after a deadline", async () => {
    const work = deferred(), outcome = bounded(work.promise, 10);
    await vi.advanceTimersByTimeAsync(11); expect(await outcome).toBe(false);
    work.reject(new Error("late failure")); await vi.advanceTimersByTimeAsync(1);
  });

  it("client cleanup rejection is a failed shutdown", async () => {
    const { app } = appMock(); app.close.mockRejectedValue(new Error("driver"));
    expect(await drainApplication(app, new ShutdownState(), vi.fn(), smallBudget)).toBe(false);
  });

  it("closes all clients once even if one fails", async () => {
    const pg = { end: vi.fn().mockRejectedValue(new Error("db")) };
    const redis = { quit: vi.fn().mockResolvedValue("OK"), disconnect: vi.fn() };
    const ch = { close: vi.fn().mockResolvedValue(undefined) };
    const infra = new InfraModule(pg as unknown as Pool, redis as unknown as Redis, ch as unknown as ClickHouseClient);
    const first = infra.onApplicationShutdown();
    expect(infra.onApplicationShutdown()).toBe(first);
    await expect(first).rejects.toThrow("Infrastructure shutdown incomplete");
    expect(pg.end).toHaveBeenCalledOnce(); expect(redis.quit).toHaveBeenCalledOnce(); expect(ch.close).toHaveBeenCalledOnce();
    expect(redis.disconnect).toHaveBeenCalled();
  });

  it("disconnects Redis when graceful QUIT never responds", async () => {
    const redis = { quit: vi.fn(() => new Promise(() => undefined)), disconnect: vi.fn() };
    const infra = new InfraModule({ end: vi.fn().mockResolvedValue(undefined) } as unknown as Pool, redis as unknown as Redis, { close: vi.fn().mockResolvedValue(undefined) } as unknown as ClickHouseClient);
    const outcome = infra.onApplicationShutdown().catch(error => error);
    await vi.advanceTimersByTimeAsync(SHUTDOWN_BUDGET.clientsMs);
    expect(await outcome).toBeInstanceOf(Error); expect(redis.disconnect).toHaveBeenCalled();
  });

  it("ignores a second signal and reports a stuck shutdown as exit 1", async () => {
    const callbacks = new Map<string, () => void>();
    vi.spyOn(process, "on").mockImplementation(((signal: string, fn: () => void) => { callbacks.set(signal, fn); return process; }) as typeof process.on);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const { app } = appMock(); app.close.mockImplementation(() => new Promise(() => undefined));
    const oldCode = process.exitCode;
    try {
      installShutdown(app as unknown as INestApplication, new ShutdownState());
      callbacks.get("SIGTERM")!(); callbacks.get("SIGINT")!();
      await vi.advanceTimersByTimeAsync(SHUTDOWN_BUDGET.hardMs);
      expect(app.close).toHaveBeenCalledOnce(); expect(exit).toHaveBeenCalledWith(1);
    } finally { process.exitCode = oldCode; }
  });
});
