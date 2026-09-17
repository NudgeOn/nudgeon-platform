# Offline failed-request export

```sh
node tests/ops/loadgen-failures/export.mjs SOURCE_RUN_DIR NEW_OUTPUT_DIR [limit]
```

The source must contain a final matching `manifest.json`, `summary.json` and
request journal `events.bin`. The exporter streams the journal with bounded
memory and writes up to 10,000 failed requests by default (maximum 100,000).
`result.json` states whether the output was truncated. It checks journal record
bounds and failure totals against the final summary. An incomplete/corrupt run
fails; a partial file without `result.json` is not a valid export.

Each exported JSON line includes the original request sequence, failure kind,
tenant UUID (when available), and reconstructed payload fields: the same insert
IDs, identities, event properties and nanosecond client timestamps. This is field
reconstruction, not a copy of original wire bytes. Built-CLI tests compare the
reconstructed events to actual observed request events across M2, seed, M0, M1,
M4 and multi-tenant profiles, including fractional-nanosecond schedule offsets.

There is **no HTTP client, SDK key input or send action**. The output is a review
artifact. Before implementing/executing M3 retries:

1. Reconcile the original request against PG/CH. A network error or malformed
   acknowledgment does not prove the server rejected the events; HTTP errors
   can also occur after partial processing.
2. Confirm the original tenant/key ownership and target, and prove idempotency.
3. Keep the reconstructed insert IDs and payload fields. Count logical events
   separately from physical attempts and verify final unique receipts/projection.
4. Retry only in an authorized isolated fault-test environment. This exporter is
   not a production retry queue and never replays a real provider send.

Generator-dropped arrivals are counted separately and not exported as failed
sent requests. They represent missed offered load; replaying them is a different
workload. A later successful retry must not turn the original load gate into PASS.

Output is exclusive-create and private (0700 directory/0600 files), contains no
keys, and retains a SHA-256 of the source journal. Keep source evidence unchanged.
