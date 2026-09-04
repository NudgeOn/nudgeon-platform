# DLQ persistence failure regression

Run from the platform repository root:

```sh
node tests/ops/dlq-storage/run.mjs
```

Requires Docker, Go, and cached `postgres:16`, `redis:7`, `nudgeon-api:latest`.
The API image only supplies Node for a mounted fixed-destination TCP gateway;
the API application is not started. No existing image tag is overwritten.

## What is real

The runner creates a random `nudgeon-dlq-storage-<id>` project with fresh PG and
Redis volumes. Go race-enabled integration tests execute current source code:

- Actual Redis Streams publish/fetch/reclaim/ACK, through `libqueue`.
- Actual Redis Lua pending/terminal state transitions.
- Actual PG schema, restricted writer login, INSERT permission revocation and
  restoration, and idempotent same-failure-cycle SQL writes.
- The same `processSendBatch` gate called by the running push worker and generic
  send loop. Only terminal rows can proceed to log flush and ACK.
- The actual message worker's DLQ method propagates PG permission errors.
- Migration 0006 is applied twice against a temporary old-shape table. PG
  state/migration tests roll back their temporary tables.

For push and the generic send loop, each test seeds four previous attempts and
executes the final retryable failure. It verifies retained pending work through
repeated INSERT denial, reconstructed workers/new consumers, and recovery with
one DLQ row and no additional provider calls. A second case commits in PG and
then injects a client-side error to model a lost database reply; the retry keeps
the same failure ID, creation time, and any verified operator resolution.

## Boundaries

The provider is a test plugin, and the log sink is an in-memory callback, not
ClickHouse. Consumer replacement reconstructs objects; it is not a daemon crash
or container restart. `Reclaim` uses min-idle 0 to accelerate the regression,
not the production 30-second timing. The reply-loss case is injected after a
real commit, not by cutting packets. This is not provider/device delivery,
analytics reconciliation, throughput, or soak proof.

The broader unit suite additionally checks nil stores, active/unknown leases,
exhausted counters, Redis finalization failure, stale-owner rejection, two
concurrent finalizers, persistent-marker TTL, and log-sink/ACK gating.

## Isolation and evidence

- Only `127.0.0.1:19395` (PG tunnel) and `:19379` (Redis tunnel) are published.
  PG/Redis have an internal-only network. The gateway reaches only these fixed
  internal destinations. All identities and credentials are synthetic.
- Containers are bounded to 416 MiB in total; this is not a Docker VM memory
  limit. Ensure headroom and free ports before running. No cloud resources,
  external sends, global Redis flushes, or existing DB migrations are used.
- The tests verify the isolated PG fixture name and Redis project marker before
  fault injection. Do not point the test URLs at another database or Redis.
- A complete run requires all four named integration tests to PASS with no
  skips. Normal `go test` skips real-DB tests when the fixture environment is absent.
- The runner compares existing running container sets, stops only its own three
  containers, and requires exit 0 for each. Volumes and evidence are retained.
- Logs and result JSON live in ignored `.nudgeon/<project>/`. Interrupted or
  incomplete evidence is not a successful run.

See [the runbook](../../../docs-public/DLQ-RUNBOOK.md) for mandatory migration,
coordinated worker rollout, Redis retention, and no-replay-during-pending rules.
