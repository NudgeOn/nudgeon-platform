import { Logger } from "@nestjs/common";
import { Pool } from "pg";
import { parseIntoClientConfig } from "pg-connection-string";
import { checkServerIdentity } from "node:tls";
import type { AppConfig } from "../config";

/** A managed database may disconnect idle sessions during failover/maintenance.
 * pg removes the failed client itself; an unhandled pool error would crash Node.
 * Never log the driver error: it may contain credentials, SQL or server details. */
export function createPostgresPool(
  cfg: Pick<AppConfig, "databaseUrl" | "pgConnectTimeoutMs">,
  report: (event: string) => void = event => new Logger("PostgresPool").warn(event),
): Pool {
  const connection = parseIntoClientConfig(cfg.databaseUrl);
  // pg sets TLS servername only for DNS hosts. When wrapping an existing socket,
  // Node otherwise falls back to "localhost" for identity checks on an IP DSN.
  // Validate the actual configured host, including IP SANs, while retaining an
  // explicitly selected verify-ca/no-verify policy from pg's DSN parser.
  const ssl = connection.ssl;
  if (ssl && (ssl === true || (ssl.rejectUnauthorized !== false && !ssl.checkServerIdentity))) {
    const host = connection.host || process.env.PGHOST || "localhost";
    connection.ssl = {
      ...(ssl === true ? {} : ssl),
      checkServerIdentity: (_servername, certificate) => checkServerIdentity(host, certificate),
    };
  }
  const pool = new Pool({
    ...connection,
    max: 10,
    connectionTimeoutMillis: cfg.pgConnectTimeoutMs ?? 5_000,
  });
  pool.on("error", () => {
    report(JSON.stringify({ event: "postgres_idle_connection_lost" }));
  });
  return pool;
}
