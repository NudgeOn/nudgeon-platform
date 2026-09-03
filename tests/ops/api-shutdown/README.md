# Isolated API shutdown regression

From the platform repository root:

```sh
pnpm --filter @nudgeon/api... build
node tests/ops/api-shutdown/run.mjs
```

Requires Docker, Node, pnpm dependencies, and cached `nudgeon-api:latest`,
`postgres:16`, `redis:7`, and `clickhouse/clickhouse-server:24.8` images.
The runner snapshots the newly compiled API `dist/` and mounts that snapshot
read-only over the cached runtime image's `/app/dist`. This is execution of the
current API build, not a newly published production image. Runtime dependency
versions, source/build fingerprints, and raw logs are recorded separately.

After changing runtime dependencies (including P0-4b's Prometheus client), first
build a fresh API image and set `SHUTDOWN_API_IMAGE` to that local tag when running
this test. Mounting a new `dist/` over an older image does not install dependencies.
The [projection regression](../projection/README.md) builds a full compatible image
and records its exact local tag and ID. The default cached tag remains available
for historical `--baseline` testing; it is not proof of current source execution.

## Coverage

1. Send 40 synthetic track requests, nominally 20 requests/s for two seconds,
   while another actual request waits on a fixture-owned PG advisory lock.
   Send SIGTERM; require `/readyz` and a new track request to return 503, release
   the lock, and require the in-flight request to return 202 and the API to exit 0.
2. Restart the same API against retained stores. Retry the accepted insert IDs;
   require unchanged PG receipt timestamps/sequences and one outbox entry each.
3. Hold another request beyond the ten-second drain deadline. Require exit 1,
   no 202, and no receipt. Release the fixture lock, confirm the disconnected PG
   session disappears, restart, and verify same-ID retry creates one receipt.
   SIGINT during an ongoing SIGTERM shutdown must not start a second shutdown.
4. Pause only the test ClickHouse container. A track response must still follow
   PG commit, while pending best-effort raw work makes shutdown incomplete.
   Require exit 1, reported remaining raw work, and preserved accepted receipt.
5. Resume CH and restart API. Open keep-alive and incomplete HTTP-header sockets;
   SIGINT must exit 0 with no abandoned sockets holding the process alive.
6. Run the seven actual PostgreSQL receipt regressions with no skips.

The four shutdown cases have expected exit codes `0, 1, 1, 0`. A test of the
failure path passing does NOT mean the application shut down cleanly in that
case. Each case requires process exit within 15 seconds and no OOM/SIGKILL.
Dispatch-to-container-FinishedAt is measured separately from Docker wait/inspect
round-trip time; a startup clock check bounds VM/host clock mismatch.

## Contract and limits

The production signal gate rejects new work before JSON parsing and guards.
It waits up to 10 seconds for HTTP responses, stops the listener, closes remaining
HTTP sockets, and gives tracked best-effort jobs up to 2 seconds. Nest lifecycle
then explicitly closes PG/Redis/CH clients with bounded parallel waits. A 14-second
watchdog exits 1 if shutdown is incomplete or live resources remain; normal exit
is natural exit 0. Compose grants 20 seconds before an external kill.

A disconnected HTTP response does not prove its handler stopped. Checked-out PG
transactions remain the storage boundary, and client outcomes without 202 are
ambiguous: retry the same insert ID. In the forced test, a PG session can remain
waiting on a lock after the API exits, until the DB notices disconnection when
the lock is released. Operational DB lock/statement budgets are still required.
The test does not prove cancellation of every arbitrary DB operation or a hard
deadline when the Node event loop or OS itself is blocked.

Best-effort raw-task completion means the client request finished, not durable CH
materialization: `wait_for_async_insert=0` remains unchanged. The final data proof
is PG receipt/outbox only. No worker, Journey, provider, device, analytics, maximum
TPS, managed-DB failover, backup/restore, or soak proof is implied.

## Isolation and recovery

- New random Compose project, fresh PG/CH volumes, synthetic development seed
  identities and test-only credentials. No real API key or provider token is used.
- PG/Redis/CH/API stay on an internal network. A fixed TCP gateway publishes only
  `127.0.0.1:19480` (API), `:19495` (PG), and `:19483` (CH).
- Memory limits total 2,208 MiB. Preflight requires at least 2.6 GiB reported Docker
  headroom. This is a small functional test, not a capacity resource allocation.
- Only the random project's API is signalled/restarted and its CH paused. Cleanup
  resumes the test CH if needed, stops its five services, checks exit codes, and
  compares pre-existing running container sets. No existing service is restarted.
- Evidence and stopped test containers/volumes remain in place. Results and the
  exact compiled snapshot are under ignored `.nudgeon/<project>/`; incomplete runs
  are failures, not successful reports.

`--baseline` is for a **pre-fix compiled snapshot** only. It instruments HTTP/Nest
shutdown boundaries without intercepting signals or closing resources, then
requires the historical 20-second SIGKILL/137 failure. Do not expect this mode to
pass against the fixed build. The normal regression leaves this probe disabled.
