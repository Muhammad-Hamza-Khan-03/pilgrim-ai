// Local-only entrypoint: binds loopback, no outbound calls. Usage: node dist/server.js [port]
import { createServer } from 'node:http';
import { createDemoApp } from './app.js';

const port = Number(process.argv[2] ?? 8788);
const app = createDemoApp();
const host = '127.0.0.1';

createServer(async (req, res) => {
  const h = req.headers.host ?? '';
  if (h !== `${host}:${port}` && h !== `localhost:${port}`) { res.writeHead(403).end('forbidden host'); return; } // blocks DNS rebinding
  let body = '';
  for await (const c of req) { body += c; if (body.length > 4096) { res.writeHead(413).end('too large'); return; } }
  try {
    const r = await app(req.method ?? 'GET', req.url ?? '/', body);
    res.writeHead(r.status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }).end(r.html);
  } catch {
    res.writeHead(500).end('demo error');
  }
}).listen(port, host, () => console.log(`Pilgrim AI DEMO on http://${host}:${port}/ (local fixture only)`));
