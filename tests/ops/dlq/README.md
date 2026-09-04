# Isolated DLQ alert regression

This bounded local test uses PostgreSQL → a freshly compiled `dlq-monitor` →
Prometheus → Alertmanager → a local HTTP receiver. No provider is contacted.
The first synthetic DLQ row exists before the monitor starts. This is an
observer/state test, not a new end-to-end provider-failure or replay-delivery test.

## Run

From the platform repository root, with the required images already cached:

```sh
dlq_build_dir=$(mktemp -d /tmp/nudgeon-dlq-build.XXXXXX)
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 GOCACHE=/tmp/nudgeon-go-build-cache \
  go build -o "$dlq_build_dir/nudgeon-worker" ./apps/worker/cmd/worker
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 GOCACHE=/tmp/nudgeon-go-build-cache \
  go build -o "$dlq_build_dir/nudgeon-dlq" ./apps/worker/cmd/dlq
DLQ_WORKER_BIN="$dlq_build_dir/nudgeon-worker" \
DLQ_CLI_BIN="$dlq_build_dir/nudgeon-dlq" node tests/ops/dlq/run.mjs
```

The commands target Apple Silicon Docker; use `GOARCH=amd64` for an x86-64
Docker server. Cached `nudgeon-worker:latest`/`nudgeon-api:latest` images supply
the runtime only: the observer/CLI entrypoints are the mounted fresh binaries,
and the gateway runs the mounted Node script. No existing tags are rebuilt.
Other images: `postgres:16`, `prom/prometheus:v3.5.0`,
`prom/alertmanager:v0.28.1`. The runner uses `--pull never`.

## Checks

- Real-PG temporary-table regression: upgrade applied twice, first failure,
  replay still unresolved, tenant/stale-resolution rejection, verified
  resolution, same-key new failure reopening, bounded unknown labels.
  The runner requires PASS and does not accept the Go test's no-DB skip.
- First pre-existing item → actual firing webhook within 30 seconds.
- Replay marker, observer restart, SELECT revocation/recovery, observer outage.
- After **330 seconds** without another failure, backlog still 1, alert still
  firing, and no false resolved webhook.
- Explicit verified synthetic disposition through the new CLI → backlog 0 →
  resolved webhook after the one-minute alert hold. No delivery is performed.

Prometheus rule tests are separate and run without a network:

```sh
docker run --rm --network none --entrypoint /bin/promtool \
  -v "$PWD/deploy/observability:/rules:ro" -w /rules \
  prom/prometheus:v3.5.0 test rules alerts.test.yml
```

## Safety and evidence

- Each run selects a fresh `nudgeon-dlq-qa-<random>` Compose project and DB volume.
  It records the pre-existing running containers and checks they remain running.
- Only fixed-target gateway ports `127.0.0.1:19294` (HTTP) and `:19295` (PG)
  are published. The other services have an internal-only network. Gateway
  joins a host-access network but cannot proxy a user-selected external host.
- Passwords and tenant/app IDs are synthetic, scoped to this isolated DB.
  The monitor's login has SELECT only; runtime additionally enforces read-only
  transactions, one connection, and a two-second query timeout.
- Limits total 640 MiB for the five persistent test containers, plus 96 MiB
  for the short-lived resolver. This is not an overall Docker VM limit or a
  resource-stress test. Check host headroom before starting; fixed ports must be free.
- The runner captures notifications, integration output, and container logs in
  ignored `.nudgeon/<project>/`, then stops only its own project. It retains
  stopped containers/volumes and does not delete existing data or images.
- `result.json` records binary hashes, scenario outcomes, and before/after
  container sets. Every test container must be stopped with exit 0. The gateway
  handles SIGTERM and closes HTTP/PG sockets explicitly, including when Node is
  container PID 1. Failed checks or failed cleanup exit nonzero. Treat an
  interrupted run without complete evidence as incomplete, not PASS.

See [the DLQ runbook](../../../docs-public/DLQ-RUNBOOK.md) for rollout order,
long-observer-outage caveats, and limitations of the existing replay command.
