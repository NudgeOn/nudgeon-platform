import { Injectable, Logger } from "@nestjs/common";
import type { RequestHandler } from "express";

type BackgroundKind = "raw_ingestions" | "api_key_last_used";

/** One process-wide admission gate, installed BEFORE JSON parsing and guards. */
@Injectable()
export class ShutdownState {
  private readonly logger = new Logger(ShutdownState.name);
  private readonly changed = new Set<() => void>();
  private readonly background: Record<BackgroundKind, number> = { raw_ingestions: 0, api_key_last_used: 0 };
  draining = false;
  activeRequests = 0;

  readonly middleware: RequestHandler = (_req, res, next) => {
    if (this.draining) {
      res.setHeader("Connection", "close");
      res.setHeader("Retry-After", "1");
      res.status(503).json({ ok: false, code: "shutting_down" });
      return;
    }
    this.activeRequests++;
    let finished = false;
    const release = () => {
      if (finished) return;
      finished = true;
      this.activeRequests--;
      res.off("finish", release);
      res.off("close", release);
      this.notify();
    };
    res.once("finish", release);
    res.once("close", release);
    next();
  };

  beginDrain() { this.draining = true; }

  snapshot() { return { active_requests: this.activeRequests, background: { ...this.background } }; }

  /** Track best-effort work without changing the endpoint's receipt contract. */
  runBackground(kind: BackgroundKind, work: () => Promise<unknown>) {
    this.background[kind]++;
    void Promise.resolve().then(work).catch(() => {
      // Do not log payloads, DSNs, keys, or raw driver errors.
      this.logger.warn(JSON.stringify({ event: "background_failed", kind }));
    }).finally(() => { this.background[kind]--; this.notify(); });
  }

  waitForRequests(timeoutMs: number) { return this.waitUntil(() => this.activeRequests === 0, timeoutMs); }
  waitForBackground(timeoutMs: number) {
    return this.waitUntil(() => Object.values(this.background).every(count => count === 0), timeoutMs);
  }

  private notify() { for (const listener of this.changed) listener(); }

  private waitUntil(done: () => boolean, timeoutMs: number): Promise<boolean> {
    if (done()) return Promise.resolve(true);
    return new Promise(resolve => {
      const finish = (ok: boolean) => { clearTimeout(timer); this.changed.delete(check); resolve(ok); };
      const check = () => { if (done()) finish(true); };
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.changed.add(check);
    });
  }
}
