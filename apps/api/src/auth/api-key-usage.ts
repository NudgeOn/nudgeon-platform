import type { Pool } from "pg";
import type { ResolvedApiKey } from "./api-key.service";
import type { ShutdownState } from "../infra/shutdown-state";
import type { CapacityMetrics } from "../infra/capacity-metrics";

// A display/operations hint, NOT an authorization cache or an audit log.
// Fixed budget is deliberately smaller than the shared API pool (10).
export const API_KEY_USAGE_MAX_PENDING = 2;

export class ApiKeyUsage {
  private readonly pending = new Set<string>();

  constructor(
    private readonly pg: Pool,
    private readonly shutdown: ShutdownState,
    private readonly enabled: boolean,
    private readonly metrics?: CapacityMetrics,
  ) {}

  record(key: ResolvedApiKey, due: boolean) {
    if (this.enabled) {
      if (!due) { this.metrics?.keyUsageOutcome("recent"); return; }
      if (this.pending.has(key.id)) { this.metrics?.keyUsageOutcome("coalesced"); return; }
      if (this.pending.size >= API_KEY_USAGE_MAX_PENDING) { this.metrics?.keyUsageOutcome("budget"); return; }
      // Set synchronously, before runBackground's microtask or acquiring PG.
      this.pending.add(key.id);
    }
    this.metrics?.keyUsageStarted();
    this.shutdown.runBackground("api_key_last_used", async () => {
      const started = performance.now();
      let outcome: "updated" | "noop" | "error" = "error";
      try {
        const result = await this.pg.query(
          this.enabled
            ? `UPDATE api_keys SET last_used_at = now()
                WHERE id = $1 AND tenant_id = $2 AND app_id = $3
                  AND status <> 'revoked'
                  AND (status <> 'rotating' OR grace_expires_at IS NULL OR grace_expires_at >= now())
                  AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds')`
            : `UPDATE api_keys SET last_used_at = now() WHERE id = $1 AND tenant_id = $2 AND app_id = $3`,
          [key.id, key.tenantId, key.appId],
        );
        outcome = result.rowCount ? "updated" : "noop";
      } finally {
        // Failure doesn't poison a TTL/cache entry; a subsequent valid request
        // may try again. No retry timer, raw key cache, or unbounded pending map.
        this.pending.delete(key.id);
        this.metrics?.keyUsageFinished(outcome, (performance.now() - started) / 1000);
      }
    });
  }
}
