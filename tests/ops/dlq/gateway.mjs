import http from 'node:http';
import net from 'node:net';

// Only these fixed destinations are reachable. This is not a general proxy.
const notifications = [];
const sockets = new Set();
const track = socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); return socket; };
const httpServer = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/alerts') {
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1024 * 1024) { res.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    try {
      if (notifications.length >= 1000) { res.writeHead(507).end(); return; }
      notifications.push({ received_at: new Date().toISOString(), body: JSON.parse(Buffer.concat(chunks)) });
      res.writeHead(200).end('ok');
    } catch { res.writeHead(400).end(); }
    return;
  }
  if (req.method === 'GET' && req.url === '/notifications') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(notifications)); return;
  }
  const target = req.url.startsWith('/monitor/') ? ['monitor', 9090, req.url.slice(8)] :
    req.url.startsWith('/prometheus/') ? ['prometheus', 9090, req.url.slice(11)] : null;
  if (req.method !== 'GET' || !target) { res.writeHead(404).end(); return; }
  const upstream = http.request({ hostname: target[0], port: target[1], path: target[2], method: 'GET', timeout: 5000 }, response => {
    res.writeHead(response.statusCode, response.headers); response.pipe(res);
  });
  upstream.on('timeout', () => upstream.destroy());
  upstream.on('socket', track);
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.on('aborted', () => upstream.destroy());
  upstream.end();
}).listen(9194, '0.0.0.0');
httpServer.on('connection', track);

// Loopback-published PG tunnel is for the transaction-only integration test.
const pgServer = net.createServer(client => {
  track(client);
  const upstream = track(net.connect(5432, 'postgres'));
  client.pipe(upstream).pipe(client);
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
  client.on('close', () => upstream.destroy());
  upstream.on('close', () => client.destroy());
}).listen(5432, '0.0.0.0');

// Node runs as container PID 1. Handle termination explicitly; keep-alive and
// PG tunnel sockets must not turn a test cleanup into Docker's SIGKILL/137.
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  httpServer.close();
  pgServer.close();
  for (const socket of sockets) socket.destroy();
  setTimeout(() => process.exit(1), 2000).unref();
});
