import { createServer, type Socket } from "node:net";
import type { ConnectionOptions, PeerCertificate } from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPostgresPool } from "./postgres";

afterEach(() => vi.restoreAllMocks());

describe("Postgres connection recovery", () => {
  it("checks IP DSNs against IP SANs instead of Node's localhost fallback", async () => {
    const pool = createPostgresPool({ databaseUrl: "postgres://fixture@127.0.0.1/db?sslmode=verify-full" });
    try {
      const verify = (pool.options.ssl as ConnectionOptions).checkServerIdentity!;
      expect(verify("localhost", { subjectaltname: "DNS:localhost" } as PeerCertificate)).toBeInstanceOf(Error);
      expect(verify("localhost", { subjectaltname: "IP Address:127.0.0.1" } as PeerCertificate)).toBeUndefined();
    } finally { await pool.end(); }
  });

  it("handles idle connection failure without throwing or exposing driver details", async () => {
    const report = vi.fn();
    const pool = createPostgresPool({ databaseUrl: "postgres://fixture" }, report);
    try {
      expect(() => pool.emit("error", new Error("postgres://user:secret@private-host SQL payload"))).not.toThrow();
      expect(report.mock.calls).toEqual([[JSON.stringify({ event: "postgres_idle_connection_lost" })]]);
    } finally { await pool.end(); }
  });

  it("bounds a connection to a server that accepts TCP but never answers", async () => {
    const sockets = new Set<Socket>();
    const server = createServer(socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture listener");
    const pool = createPostgresPool({ databaseUrl: `postgres://fixture@127.0.0.1:${address.port}/fixture`, pgConnectTimeoutMs: 50 }, vi.fn());
    try {
      await expect(pool.query("SELECT 1")).rejects.toThrow(/timeout/i);
      expect(pool.totalCount).toBe(0);
    } finally {
      await pool.end();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
