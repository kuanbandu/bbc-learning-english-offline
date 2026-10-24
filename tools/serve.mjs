import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = path.resolve(process.argv[2] || 'dist');
const port = Number(process.argv[3] || process.env.PORT || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
};

function safeJoin(base, target) {
  const p = path.resolve(base, '.' + path.posix.normalize('/' + target));
  return p.startsWith(base) ? p : null;
}

function lanIps() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
}

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const file = safeJoin(root, urlPath);
  if (!file) { res.writeHead(403).end('forbidden'); return; }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end('not found'); return; }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;

    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m && m[1] ? Number(m[1]) : 0;
      const end = m && m[2] ? Number(m[2]) : st.size - 1;
      if (start >= st.size || end >= st.size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end();
        return;
      }
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${st.size}`,
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
});

server.listen(port, () => {
  console.log(`\n已启动：http://localhost:${port}`);
  console.log('手机与电脑连同一个 WiFi 时，用手机浏览器打开：');
  for (const ip of lanIps()) console.log(`  http://${ip}:${port}`);
  console.log('\n打开后：Android Chrome → 菜单「添加到主屏幕」；iPhone Safari → 分享 → 「添加到主屏幕」');
  console.log('按 Ctrl+C 停止\n');
});
