import type { PoolClient } from "pg";

export type ReceiptStage = "pool_acquire" | "begin" | "advisory_lock" | "cursor_lock" | "profile_lock" | "sql" | "commit" | "rollback";
export interface ReceiptObserver {
  measure<T>(stage: ReceiptStage, work: () => Promise<T>): Promise<T>;
  committed(unique: number, submitted: number): void;
  retry(): void;
}
const noop: ReceiptObserver = { measure: (_stage, work) => work(), committed() {}, retry() {} };
export const noReceiptObserver = noop;

/** Local proxy only; never mutate a pooled client's methods across requests. */
export function observedClient(client: PoolClient, observer: ReceiptObserver): PoolClient {
  return new Proxy(client, {
    get(target, key) {
      if (key === "query") return (sql: string, values?: unknown[]) => {
        let stage: ReceiptStage = "sql";
        if (sql === "BEGIN") stage = "begin";
        else if (sql === "COMMIT") stage = "commit";
        else if (sql === "ROLLBACK") stage = "rollback";
        else if (sql.includes("pg_advisory_xact_lock")) stage = "advisory_lock";
        else if (sql.includes("FOR UPDATE")) stage = sql.includes("event_customer_cursors") ? "cursor_lock" : "profile_lock";
        return observer.measure(stage, () => target.query(sql, values));
      };
      const value = target[key as keyof PoolClient];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
