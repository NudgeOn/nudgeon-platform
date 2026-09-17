# Reproducible single-tenant workloads

The default `M2` keeps the existing all-new-identity single-event payload. Optional
profiles implement the payload shapes needed before capacity testing:

| Profile | Requests | Identities | Properties |
| --- | --- | --- | --- |
| `seed` | one event each | repeat a named pool | exactly 1024 JSON bytes |
| `M0` | one event each | returning pool | exactly 1024 JSON bytes |
| `M1` | one event each | every 100th request new (1%) | exactly 1024 JSON bytes |
| `M4` | ten events each | one returning identity/device per request | exactly 1024 JSON bytes per event |

These profiles cycle through ten event names. `--identity-seed` and
`--identity-count` must match between the seed and measured runs; use a distinct
`--run-id` and new `--output-dir` for every run. Pool IDs use UUID v5 with namespace
`nudgeon-loadgen:v1:identity-pool:<identity-seed>`, then `anon:<pool-index>` and
`device:<pool-index>`, where pool-index is request-sequence modulo identity-count.
New M1 IDs use the measured run namespace and request-sequence.

For example, on an **isolated authorized staging target**, after resource/G0
checks, populate 10,000 users at 100 requests/s for 100 seconds:

```sh
nudgeon-loadgen --url https://isolated-staging.example.com --key-file /private/sdk-key \
  --workload seed --identity-seed qa-pool --identity-count 10000 \
  --rate 100 --dur 100s --run-id seed-unique --output-dir /private/evidence/seed-unique
```

Before M0/M1/M4, verify all seed HTTP acknowledgments **and PG/CH projection and
identity existence**. The generator cannot attest to this and records
`returning_identities_verified: false`. A failed or undersized seed run must not
be called a returning-user capacity test. The seed is a write workload; running
it twice creates new events but reuses the named identities. No seed command
runs automatically.

For a returning-user run, keep the pool flags and change `--workload M0`, run ID,
and evidence path. Normal M0/M1/M4 runs have no automatic retry. For M4, `--rate`
continues to mean HTTP requests/s: 500 requests/s produces 5,000 events/s, which
is not 5,000 HTTP requests/s. An acknowledgment must equal the batch size exactly;
partial/malformed/oversized acknowledgments are errors.

The journal remains request-based (`kind`, request sequence, request count).
For a batch, each event sequence is `request_sequence * batch_size + item_index`;
its insert ID is `event:<event-sequence>` in the run namespace. Summary `counters`
and `expected` remain requests for compatibility; the new `events` object records
event counts separately. Failed events include generator drops. The manifest
records workload, batch size, expected events, pool and single-tenant scope.

Tests: `go test -race ./apps/worker/cmd/loadgen`, then build the CLI and run
`node tests/ops/loadgen-smoke.mjs /absolute/path/to/loadgen`. The loopback smoke
checks seed reuse, M1's exact 1% mix, byte size, full M4 acknowledgments, and
reconstructs all 2,000 batched event IDs from the journal. No provider or live DB
is called. Memory is independent of request count outside this bounded test.

Remaining before full planned capacity gates: multiple tenants/keys with per-
tenant reconciliation, M3 retry/fault workload, PG/CH payload and identity proof,
projection/canary/backlog timing, resource measurements and full-duration runs.
A generator HTTP PASS alone is never a platform capacity or soak PASS.
