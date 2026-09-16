import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { build, root } from './build.mjs';

await build();
const production = process.argv.includes('--production');
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const dist = path.join(root, 'dist');
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };
const server = http.createServer(async (req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
  try {
    const requestPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (requestPath === '/ko') { res.writeHead(308, { Location: '/ko/' }); return res.end(); }
    let file = path.resolve(dist, '.' + requestPath);
    if (!file.startsWith(dist + path.sep) && file !== dist) { res.writeHead(403); return res.end('Forbidden'); }
    if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': production ? 'public, max-age=300' : 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (error) {
    res.writeHead(error instanceof URIError ? 400 : 404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Page not found');
  }
});
server.on('error', error => { console.error(`Could not start NudgeOn preview: ${error.message}`); process.exitCode = 1; });
server.listen(port, host, () => console.log(`NudgeOn website: http://${host}:${port} / http://${host}:${port}/ko/`));
