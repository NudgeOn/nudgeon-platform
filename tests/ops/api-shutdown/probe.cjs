// Read-only lifecycle instrumentation for the pre-fix reproduction only.
// No extra referenced handles and no signal interception or connection closing.
if (process.env.SHUTDOWN_QA_PROBE === 'true') {
  const {createRequire} = require('node:module');
  const req = createRequire('/app/package.json');
  const report = event => console.log(JSON.stringify({qa_probe: event, at: Date.now()}));
  const {Server} = require('node:http');
  const close = Server.prototype.close;
  Server.prototype.close = function(callback) {
    report('http_close_begin');
    return close.call(this, (...args) => {report('http_close_end'); callback?.(...args);});
  };
  const {InfraModule} = require('/app/dist/infra/infra.module.js');
  const shutdown = InfraModule.prototype.onApplicationShutdown;
  InfraModule.prototype.onApplicationShutdown = async function(...args) {
    report('infra_hook_begin');
    await shutdown.apply(this, args);
    report('infra_hook_end');
  };
  const {Pool} = req('pg');
  const end = Pool.prototype.end;
  Pool.prototype.end = function(...args) {report('pg_end'); return end.apply(this, args);};
  const kill = process.kill;
  process.kill = function(pid, signal) {
    if (pid === process.pid) {
      report(`self_signal_${signal}`);
      setTimeout(() => console.log(JSON.stringify({qa_probe:'still_alive', resources:process.getActiveResourcesInfo()})), 1000).unref();
    }
    return kill.call(process, pid, signal);
  };
}
