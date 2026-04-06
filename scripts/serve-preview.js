// Minimal static file server for preview
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';

const PORT = 3456;
const ROOT = join(fileURLToPath(import.meta.url), '../../public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

createServer((req, res) => {
  let path = req.url.split('?')[0];
  if (path === '/') path = '/index.html';
  const file = join(ROOT, path);
  if (existsSync(file)) {
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'text/plain' });
    res.end(readFileSync(file));
  } else {
    res.writeHead(404); res.end('Not found');
  }
}).listen(PORT, () => console.log(`serving http://localhost:${PORT}`));
