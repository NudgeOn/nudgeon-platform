# Bounded generator validation

Build `go build -o /tmp/nudgeon-loadgen ./apps/worker/cmd/loadgen`, then:

```sh
node tests/ops/generator-validation/run.mjs /tmp/nudgeon-loadgen /tmp/new-generator-run 7500 60
```

This target is always a fresh loopback HTTP responder owned by the runner. There
is no remote URL or real key option. It uses a synthetic key, one M0 event/request
with exactly 1024 property bytes and a named fixture identity pool. It never
connects to NudgeOn, Docker, PG/CH, APNs/FCM or physical devices.

The receiver independently checks every sequence once, body size and property
size, then acknowledges the exact batch. It keeps a bounded sequence bitmap
(maximum 6 MB for 10,000 requests/s × 600 seconds). That responder allocation is
separate from the generator's measured RSS. Request data is otherwise discarded.
This does not prove PG identity seeding, payload projection or capacity.

The rate is bounded to 1..10,000 and duration to 1..600 seconds. Before starting,
reserve 20 GiB plus evidence forecast. While running, sample generator and
responder RSS once per second using `ps`, and stop the child on a 512 MiB process
budget breach, disk reserve breach, sampling failure or duration watchdog.
Only the child process is signaled. GOMAXPROCS=2 keeps its parallelism bounded.
The current script supports macOS/Linux `ps` RSS in KiB; it does not qualify CPU
headroom or container resource profiles.

Evidence is private, exclusive-create, and includes binary SHA-256, generator
manifest/journal/summary, independent receiver counts and resource time series.
`PASS_GENERATOR` requires zero duplicates/invalid bodies, all expected requests,
zero loadgen errors/drops and its normal acceptance/latency gates. Other results
are `INVALID_GENERATOR` or `ABORTED_RESOURCE`. They are never platform capacity
or 24-hour soak certification.

2026-09-18 local exploration retained a failed 7,500 rps/60 s run (one transport
error), a passing 1,000 rps/60 s run and a passing 7,500 rps/60 s diagnostic run.
The original failure's root cause is not established. Loadgen now reports only
sanitized bounded error categories (EOF/reset/refused/timeout/DNS/TLS/etc.) so
future errors can be investigated without publishing URLs or credentials.
A later pass does not erase the failed run or prove sustained production capacity.
