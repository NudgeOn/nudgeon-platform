import http from 'node:http';

// Only fixed local test services are reachable; this is not an open proxy.
const routes = { 8180: 'api:8080', 8181: 'api-restored:8080', 9190: 'worker:9090', 9191: 'prometheus:9090', 9193: 'alertmanager:9093', 9194: 'receiver:9194' };
for (const [port, target] of Object.entries(routes)) {
  http.createServer((request, response) => {
    const [hostname, targetPort] = target.split(':');
    const upstream = http.request({ hostname, port: targetPort, path: request.url, method: request.method, headers: request.headers }, result => {
      response.writeHead(result.statusCode, result.headers);
      result.pipe(response);
    });
    upstream.setTimeout(15000, () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end('Local test upstream unavailable'); });
    request.on('aborted', () => upstream.destroy());
    request.pipe(upstream);
  }).listen(Number(port), '0.0.0.0');
}
