# Local Redis TLS and reconnect regression

Run `node tests/ops/redis-recovery/run.mjs` after `pnpm install`.
Docker, OpenSSL and Redis 7 are required. The runner creates one uniquely named
64 MiB/0.5 CPU Redis container with a loopback-only ephemeral port, no persistence,
and a one-day test CA/server certificate. It never connects to the existing
application Redis and only kills a connection on its own fixture server.

The child uses the same `createRedisClient` factory as the API, including the
existing `maxRetriesPerRequest: 2` policy. This refactor does not change production
retry behavior. CA trust is added only to the child process using
`NODE_EXTRA_CA_CERTS`; TLS verification is explicitly enabled for the fixture.

Assertions:

- `rediss://` creates an encrypted, authorized connection.
- Killing the fixture's idle connection causes that same client to reconnect
  with TLS and a new server client ID; the next PING succeeds.
- An untrusted CA fails with a certificate-verification error.
- A hostname not in the certificate fails with `ERR_TLS_CERT_ALTNAME_INVALID`.
- The wrong password fails with `WRONGPASS`.

Negative checks validate the actual TLS/authentication error class; an unrelated
connection refusal cannot satisfy them. Raw driver logs and DSNs are discarded.
The result records source SHA-256, revision, Redis image ID, assertions and
before/after container names. It verifies no unrelated container was stopped,
removes its own container/anonymous volume and deletes private keys/config.
Before dropping to the Redis user, the fixture copies certificates/config from
the private read-only host mount into a Redis-owned private directory. This keeps
Linux host permissions strict without preventing the container from starting.

This is a local connection regression, not ElastiCache certification, Sentinel/
Cluster failover, managed Redis IAM auth, durability, queue reconciliation or
capacity proof. Those still require the actual isolated managed environment.
For a private CA in deployment, mount its certificate read-only and configure
`NODE_EXTRA_CA_CERTS` before starting Node; never disable TLS verification.
