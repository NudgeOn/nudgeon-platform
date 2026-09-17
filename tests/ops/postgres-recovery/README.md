# PostgreSQL TLS and idle connection recovery

```sh
node tests/ops/postgres-recovery/run.mjs
pnpm --filter @nudgeon/api exec vitest run src/infra/postgres.test.ts src/config.test.ts
```

Requires installed workspace dependencies, Node 22+, Docker with `postgres:16`,
and OpenSSL. The runner creates one uniquely named PostgreSQL container capped
at 256 MiB / 1 CPU, a random loopback port, a one-day local CA, and synthetic
credentials. It never uses the host's database URLs or existing application DBs.
It terminates only the backend PID returned by its own child client.

Assertions:

1. The old pool configuration crashes a separate Node process when its idle PG
   backend is terminated. No test-runner exception handler conceals the crash.
2. The API's actual `createPostgresPool` catches the idle error, removes the dead
   connection through pg's own lifecycle and queries again in the same process.
   Both connections report TLS enabled and their backend PIDs differ.
3. An untrusted certificate, trusted certificate with wrong hostname, and invalid
   password all reject the connection.
4. Holding all ten connections causes the eleventh acquisition to time out;
   returning the held connections lets a subsequent query succeed.
5. Graceful pool shutdown exits 0. The owned container is removed with its fresh
   anonymous volume, no OOM is observed, and unrelated running containers remain.

The separate unit regression uses a real TCP listener that never answers the PG
handshake to prove connection establishment has a deadline. `PG_CONNECT_TIMEOUT_MS`
defaults to 5,000 ms and also bounds waiting for a pooled connection. It does not
set SQL execution deadlines or retry failed transactions.

Evidence is written under a private `.nudgeon/nudgeon-pg-recovery-*/result.json`.
Raw driver errors/DSNs are not recorded. The local certificate private keys are
removed after execution. This is **local driver/TLS recovery evidence**, not
managed RDS failover, DNS refresh, Redis/ClickHouse recovery, or production capacity
certification. Those require the actual target environment.

The behavior follows the [node-postgres pool error contract](https://node-postgres.com/apis/pool#events):
pg removes the failed idle client; the application must handle the pool's error
event to avoid an uncaught exception.
