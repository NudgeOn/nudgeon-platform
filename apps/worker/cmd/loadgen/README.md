# Track HTTP load generator

Measures **single-event HTTP acceptance**, not PostgreSQL/ClickHouse correctness,
Journey execution, provider delivery or production capacity. Defaults fail on
any dropped request or HTTP/network/response error. Database reconciliation is
still a separate requirement.

## Run

Run from the repository root, using an existing private SDK-key file:

```sh
go run ./apps/worker/cmd/loadgen \
  --url http://127.0.0.1:8080 \
  --key-file /private/path/to/sdk-key \
  --rate 100 --dur 30s --concurrency 32 --request-timeout 3s \
  --max-p99 500ms --output-dir .nudgeon/loadgen/a-new-unique-directory
```

`--key-file -` reads stdin; `/dev/fd/N` can also be used where supported.
The old `--key` flag remains compatible but exposes its value in process argv.
Keys, response bodies and raw network-error text are not written into evidence.
Redirects are not followed. Output directories are exclusive: an existing path
fails **before any request**, rather than overwriting an earlier run.

Without `--output-dir`, the console explicitly reports that no ID evidence was
recorded. Do not use that mode to qualify a capacity phase.

Each run must have a **new run ID**, generated automatically unless `--run-id`
is supplied. This version still creates a new anonymous user/device per event;
it does not implement the returning-user M0/M1, multi-tenant or batch-10 profiles
in the [capacity plan](../../../../docs-public/CAPACITY-PLAN.md).

## Correctness and throughput

- `failed_total = expected - accepted`, including generator drops. HTTP timeouts
  may already have committed in the API; they remain failed acknowledgements,
  not proof of lost data.
- `accepted_in_window` includes only valid responses fully read before the
  fixed load deadline. `--min-rate-ratio` (default 0.99) uses this count, not
  successful completions during drain. A run can have zero failed requests
  and still fail the throughput gate because responses arrived too late.
- Scheduled, enqueued, dropped, started and completed counters must balance.
  Missing arrivals at the deadline are recorded as drops, not replayed in a
  catch-up burst after the measurement window.
- A 202 must contain JSON `accepted: 1`. Empty, malformed, incomplete or oversized
  responses fail. Body reading is bounded at 64 KiB and covered by the request
  timeout. Responses are consumed before closing for connection reuse, following
  the [Go HTTP response contract](https://pkg.go.dev/net/http#Response).
- Successful TCP dials, acquired connections and reuse are measured separately
  via [Go HTTP tracing](https://pkg.go.dev/net/http/httptrace#ClientTrace).
  A TCP dial is not the same as a logical request, especially with HTTP/2.
- SIGINT/SIGTERM cancels active requests, counts unscheduled arrivals as drops,
  and retains an `ABORTED` result when evidence can be finalized.

## Bounded memory and artifacts

Three fixed histograms replace per-request latency arrays. Together their
bucket arrays occupy **442,368 bytes (432 KiB)**, independent of run length.
The range is 0–60 seconds; microseconds are rounded upward, and buckets above
2,048 µs have at most 0.1% width. Quantiles are conservative bucket upper bounds
(capped by the exact maximum). Any overflow fails the gate, even if p99 itself
is below the threshold. This is not an entire-process RSS limit.

The ID journal uses a 64 KiB write buffer. This deliberately uses more disk
than a bitmap to avoid RAM proportional to the number of requests. It is flushed
approximately every second and synced at normal completion. I/O failure stops
generation with `INVALID_GENERATOR`; incomplete evidence cannot qualify a run.

| File | Contents |
| --- | --- |
| `manifest.json` | Run ID, scheduled start/rate, expected count, workload and binary format; no key |
| `events.bin` | Append-only request sequence/state records |
| `samples.jsonl` | Approximately 1-second cumulative counters and sparse histograms, plus final sample |
| `summary.json` | Final counters, latency, failures, gate violations and `PASS`/`FAIL`/`ABORTED` |

`events.bin` consists of 17-byte records: kind (uint8), starting sequence
(uint64 little-endian), count (uint64 little-endian). Kinds are 1=attempt started,
2=accepted, 3=dropped, 4=HTTP error, 5=network error, 6=response contract error.
A dropped range may have count >1; other records have count 1. Starts represent
client attempts, not proof that bytes reached the server. Use the final journal
and summary together; live counter snapshots are not transactionally atomic.

For sequence `s`, UUID-v5 namespace is `UUIDv5(URL_NAMESPACE,
"nudgeon-loadgen:v1:" + run_id)` and the name is `"event:" + s`. Names `"anon:"`
and `"device:"` derive the synthetic identities. Scheduled timestamp is
`started_at + floor(s / rate) seconds + floor((s % rate) × 1e9 / rate) ns`.
These fields reconstruct the exact single-event request independently of worker
assignment. Preserve timestamp as well as ID when deliberately replaying a job.
The normal runner performs no application retries and disables body replay.

At 5,000 requests/s for 24 hours, two journal records per successful event alone
require **14.688 GB / about 13.68 GiB**, plus samples and all server data. The local
operations runner still gathers database IDs in memory and has no long-run
resource preflight. **Do not infer 24-hour readiness from bounded histograms.**

## Verification without databases or providers

```sh
go test -race ./apps/worker/cmd/loadgen -count=3
go test ./apps/worker/cmd/loadgen -run '^$' -bench BenchmarkLatencyRecord -benchmem
go build -o /tmp/nudgeon-loadgen ./apps/worker/cmd/loadgen
node tests/ops/loadgen-smoke.mjs /tmp/nudgeon-loadgen
```

The tests need permission to bind loopback ports. The smoke test verifies the
built CLI, stdin key transport, exact ID reconstruction, late/invalid responses,
exclusive evidence directories and cancellation. Its 200 requests go only to
a synthetic local HTTP responder; the result is not platform TPS evidence.
