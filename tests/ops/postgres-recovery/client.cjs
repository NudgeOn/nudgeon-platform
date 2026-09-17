// Separate process: an unhandled pg idle error must fail the regression, not be
// hidden by a test runner's uncaughtException handler. No credentials in IPC/logs.
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../../..');
const req = createRequire(path.join(root, 'apps/api/package.json'));
req('ts-node').register({ project: path.join(root, 'apps/api/tsconfig.json'), transpileOnly: true });
const { createPostgresPool } = require(path.join(root, 'apps/api/src/infra/postgres.ts'));
const { Pool } = req('pg');
const pool = process.env.RECOVERY_BASELINE === 'true'
  ? new Pool({ connectionString: process.env.DATABASE_URL, max: 10 })
  : createPostgresPool({ databaseUrl: process.env.DATABASE_URL, pgConnectTimeoutMs: 1000 }, () => process.send({ event: 'idle_error_handled' }));

process.on('message', async message => {
  try {
    if (message === 'query') {
      const { rows } = await pool.query('SELECT pg_backend_pid() AS pid, (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls');
      process.send({ event: 'query_ok', ...rows[0] });
    } else if (message === 'exhaust') {
      const held = [];
      try {
        for (let i = 0; i < 10; i++) held.push(await pool.connect());
        const started = performance.now();
        try { const extra = await pool.connect(); extra.release(); process.send({ event: 'unexpected_acquisition' }); }
        catch { process.send({ event: 'acquisition_bounded', elapsedMs: performance.now() - started }); }
      } finally { for (const client of held) client.release(); }
    } else if (message === 'close') {
      await pool.end(); process.exit(0);
    }
  } catch { process.send({ event: 'query_failed' }); }
});
process.send({ event: 'ready' });
