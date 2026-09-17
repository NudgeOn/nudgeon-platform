# Capacity resource preflight

This read-only tool forecasts the resources required by a phase in
`docs-public/capacity/test-plan.json`. It never starts a load, changes Docker
limits, stops services, provisions cloud resources, or sends provider messages.

```sh
node --test tests/ops/capacity-preflight/preflight.test.mjs
node tests/ops/capacity-preflight/preflight.mjs --phase G1 --output /tmp/new-preflight.json
```

Without `--environment FILE`, it reads the current filesystem's available bytes,
Docker VM memory and aggregate running-container memory using `docker info` and
`docker stats`. Run from the volume that will store the evidence/data. For remote
staging, supply a JSON file with `observed_at`, `free_disk_bytes`,
`vm_memory_bytes`, and `existing_memory_bytes` collected on that target. The tool
does not connect to remote servers. It does not validate who supplied the file.

Supply `--measurements FILE` with actual G0 results (all sizes are bytes):

- `measured_at`: ISO timestamp, at most 24 hours before the inventory snapshot.
- `isolated_target`: true only for an isolated, authorized test environment.
- `candidate_memory_bytes`: total proposed limits for the test stack.
- `measured_peak_memory_bytes`: observed stack peak at the intended resource profile.
- `generator_memory_bytes`: separately measured generator memory budget.
- `measured_storage_bytes_per_event`: measured combined PG/CH/Redis growth.
- `backup_restore_sort_bytes`: space reserved for backup, recovery and CH sorts.
- `sample_events`, `sample_duration_seconds`: measurement scope, not a capacity claim.
- `generator_validated_rps`: independently verified generator request rate.

Missing, negative, nonfinite, stale or overflowing values fail closed. The tool
includes all consecutive runs and extra workloads without state reset, warmup,
1.5 times measured storage growth, backup/sort space, evidence and the 20 GiB
safety reserve. Memory includes existing services and the generator while
preserving 20% VM headroom. Input credentials and unknown fields are not copied
to output; existing evidence files cannot be overwritten.

Exit codes: 0 = `RESOURCE_PREFLIGHT_READY`, 2 = `NO_GO_PREFLIGHT`, 1 = invalid
arguments/input/probe/output. A ready resource forecast is **not G0 or a capacity
PASS**. It does not replace per-container RSS/limit measurements, CPU/disk I/O
trends, schema isolation, image/source hashes, payload reconciliation, completed
prerequisite phases or the full-duration soak. Both outcomes set
`capacity_qualified: false` and `load_started: false`.

The 2026-09-18 local inventory is deliberately `NO_GO_PREFLIGHT`: no managed
staging target or measured growth profile was supplied, and local disk space was
below the reserve. The existing user stack was left running. A fresh inventory
is required after resource availability changes.
