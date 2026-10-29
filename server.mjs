import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const target = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!target.startsWith(root + path.sep) || !['.html', '.js', '.css', '.svg'].includes(path.extname(target))) {
      res.writeHead(404).end('Not found'); return;
    }
    const data = await readFile(target);
    res.writeHead(200, { 'Content-Type': types[path.extname(target)], 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch { res.writeHead(404).end('Not found'); }
});
server.listen(Number(process.env.PORT || 3000), '127.0.0.1', () => console.log(`Нолик: http://localhost:${server.address().port}`));
