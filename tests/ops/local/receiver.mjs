import http from 'node:http';

// Deliberately local-only. No Slack/email credentials and no forwarding.
const notifications = [];
http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/alerts') {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1024 * 1024) { res.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    try {
      notifications.push({ received_at: new Date().toISOString(), body: JSON.parse(Buffer.concat(chunks)) });
      res.writeHead(200).end('ok');
    } catch { res.writeHead(400).end('invalid JSON'); }
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(notifications));
}).listen(9194, '0.0.0.0');
