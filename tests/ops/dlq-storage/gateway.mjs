import net from 'node:net';

// Loopback-only published ports, fixed internal destinations, no general proxy.
const sockets = new Set();
const track = s => { sockets.add(s); s.once('close', () => sockets.delete(s)); return s; };
const servers = [['postgres', 5432], ['redis', 6379]].map(([host, port]) => net.createServer(client => {
  track(client);
  const upstream = track(net.connect(port, host));
  client.pipe(upstream).pipe(client);
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
  client.on('close', () => upstream.destroy());
  upstream.on('close', () => client.destroy());
}).listen(port, '0.0.0.0'));
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  for (const server of servers) server.close();
  for (const socket of sockets) socket.destroy();
  setTimeout(() => process.exit(1), 2000).unref();
});
