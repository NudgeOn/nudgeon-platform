# API key usage contention QA — P1-2a

Repository root:

```sh
node tests/ops/api-capacity/run.mjs
```

This starts a **new disposable local Compose project** with fresh PG/CH volumes,
an internal network, and loopback ports 19500–19504. No provider sends, production
credentials, existing services or existing data are in scope. Check these ports
are free before execution. It requires Docker headroom >2.9 GiB and disk >10 GiB;
shared-host contention still makes timings environment-specific.

The runner builds one full API image and compares that exact image with
`API_KEY_USAGE_COALESCE_ENABLED=false` / `true`. An explicitly provided
`API_CAPACITY_EXISTING_IMAGE` may reuse a prior full API build only if its source
SHA label matches every current source-manifest entry. This avoids rebuilding
unchanged product code after a test-only fix. Retain its original build log.
The unchanged local worker image is pinned by ID. Every worker/shared Go/schema
input must match the recorded `nudgeon-projection-qa-42d33634/source-manifest.json`;
otherwise it stops. This local dependency means the runner is **not portable CI
yet**. For CI, build a full worker and explicitly update the verified image/source
fixture instead of silently using `latest`.

Checks:

1. Hold one synthetic API key row lock. Under the legacy setting, at least five
   shared-pool connections block on usage writes. With coalescing enabled, only
   one usage write waits and 20/20 real HTTP receipts must finish before unlock.
   Release the lock in `finally`, then reconcile exact PG/CH IDs and physical rows.
2. 100 requests/s, one new anonymous user/event per request, 10 seconds, 20 clients,
   in ABBA order (off/on/on/off). Each round gets a fresh key and API process;
   PG, CH and workers are retained. This is short M2-like calibration, **not G1**
   or a memory-leak/soak test. There is no 60-second warmup or M0/M1 dataset.
3. Keep zero drop/error, >=99% in-window completion, and end-to-end p99 <=500ms
   gates. Preserve failing results and still reconcile acknowledged IDs. Never
   count load-generator backpressure drops as successes. Ambiguous HTTP outcomes
   stop the runner and require separate durable-ledger investigation.
4. Compare actual `pg_stat_statements` calls, updated rows, execution time and WAL
   bytes. Authentication must SELECT on every started request in both modes.
   Over a 10-second round, usage updates must be N (off) versus 1 (on).
5. Run actual PG authorization/coalescing and receipt regressions without skips.

`pg_stat_activity` is sampled every ~200ms, with fixed operation/wait categories.
These are observations, not exhaustive wait duration or COMMIT p99 measurements.
API histograms include client pool/SQL round trips; `pg_stat_statements` is server
statement timing and is not transaction duration. SQL statistics aggregate all
sessions in this fixture DB, so `commit`/`other` include workers and test helpers.
Only the `key_usage`/`key_auth` categories isolate these API statements.

Evidence is in `.nudgeon/nudgeon-api-capacity-*` (mode 0700 directory, 0600 files),
including synthetic keys, source/image IDs, load journals, exact IDs, SQL deltas,
metrics, wait samples, logs and service exit state. Do not publish raw fixture
files as customer data. The runner stops only its own services, retains its
volumes/images/evidence and removes only its own now-empty networks.

`correctnessPass` covers lock isolation, authorization, accounting and update
count assertions. `capacityPass` covers only the two **enabled short load** gates;
baseline failures remain visible in `rounds`. `pass` additionally requires clean
shutdown and unchanged pre-existing containers. None qualifies sustained TPS,
managed DB recovery, alert delivery, mobile push or the complete capacity plan.

To rerun only the actual PG suites after a test-harness correction:

```sh
node tests/ops/api-capacity/pg-regressions.mjs
```

This starts only fresh PG and the Node TCP gateway. It does not start API/worker
services or select a new performance result. The gateway image is pinned to the
locally built fixture noted in the script; no application source is loaded from
that image during these tests. See the [recorded QA](../../../docs-public/API-KEY-USAGE-QA-2026-09-03.md).
