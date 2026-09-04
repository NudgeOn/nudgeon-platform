import net from 'node:net';

// Fixed destinations only; all host bindings are loopback in Compose.
const sockets = new Set(), servers = [];
for (const [port, host] of [[8080, 'api'], [5432, 'postgres'], [8123, 'clickhouse']]) {
  const server = net.createServer(client => {
    const upstream = net.connect(port, host);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {client.destroy(); upstream.destroy();});
    }
    client.pipe(upstream).pipe(client);
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
  }).listen(port, '0.0.0.0');
  servers.push(server);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  for (const server of servers) server.close();
  for (const socket of sockets) socket.destroy();
});
