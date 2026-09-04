# Isolated receipt / projection accounting regression

From the repository root:

```sh
node --test tests/ops/projection/reconcile.test.mjs
node tests/ops/projection/run.mjs
```

Requires Docker, Node 22+, Go, pnpm and installed workspace dependencies. Builds
both full application Dockerfiles under unique local tags, including API runtime
dependencies and the worker's migrate/seed/DLQ CLIs. Building may download base
images and dependencies. No image is published and no existing service is changed.

The runner reserves >2.9 GiB Docker memory headroom, starts a unique internal
network with fresh PG/Redis/CH data, and publishes a fixed gateway only on loopback
ports 19500–19504. Seven services have a total 2,464 MiB memory cap. No channel
worker or real provider credential is used. Scheduler runs only to relay receipts
from the synthetic DB; no journey is activated.

Coverage:

1. Source manifest SHA, image build labels, running image IDs and live metrics
   agree; public API `/metrics` is 404.
2. Six submitted events containing batch/replay duplicates produce two receipts
   and exactly two committed projections. Public accepted=batch size is unchanged.
3. A six-second fixture PG lock triggers a real three-second statement timeout
   and HTTP 503; no receipt counter increases. Same-ID retry produces one receipt.
4. Pause only the test CH: track still returns 202 after PG COMMIT, projection
   stays behind and a failed CH attempt is observable. Resume, reclaim and retry
   produce one committed projection. This intentional outage is outside the load window.
5. A synthetic authenticated session reads four actual user activity events.
6. 100 requests/s, single event/new anonymous user/device, ten seconds, concurrency
   20, p99 gate 500 ms. The existing loadgen requires zero drops/errors and records
   its journal, samples and acceptance window. This is NOT a capacity tier test.
7. Read acknowledged sequences from the loadgen journal and derive their UUIDs.
   Compare these IDs with PG receipts and CH IDs/physical counts. With zero drops,
   this is all 1,000 generated IDs; dropped arrivals remain failed capacity requests,
   not missing DB rows. Ambiguous HTTP outcomes fail for separate investigation.
   Normalize string order: native database UUID order is not a shared sort contract.
   Never use FINAL/OPTIMIZE/unique-only counts to conceal physical duplicates.
8. Run API receipt regressions on actual PG and Go ingest regressions with actual
   PG/CH, including cancellation after CH write but before PG COMMIT.

`window-samples.json` records non-atomic scrape timing. EPS is computed only from
samples strictly inside loadgen's input interval; subsequent drain is separate.
Server counters cannot prove events lost before reaching the API, nor observe every
COMMIT acknowledgement loss/process crash. Exact ID reconciliation is required.
No source-level timing claims exact commit-to-commit latency.

On completion/failure/interruption, resume test CH if paused, stop only the seven
owned services, and require exit 0/no OOM. Compare the prior running container set.
Keep stopped containers, local images, volumes and private `.nudgeon/<project>`
evidence. Release only the project's empty networks to avoid address-pool exhaustion.
Do not reuse a partial run as PASS. A failed capacity gate remains `pass:false`
and exit 1 even if `accountingPass:true`: the latter means accepted IDs reconciled
and functional regressions passed, NOT that the target rate/latency was met.

[Metric definitions](../../../docs-public/INGESTION-METRICS.md)
