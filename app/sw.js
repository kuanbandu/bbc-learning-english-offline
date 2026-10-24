const SHELL_CACHE = 'ble-shell-v1';
const CONTENT_CACHE = 'ble-content-v1';

const SHELL = [
  './', './index.html', './style.css', './app.js',
  './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    (async () => {
      const c = await caches.open(SHELL_CACHE);
      await Promise.allSettled(SHELL.map((u) => c.add(u)));
      self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== CONTENT_CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 学习包数据：优先缓存，后台更新（stale-while-revalidate）
  if (url.pathname.endsWith('/content/index.json')) {
    e.respondWith((async () => {
      const c = await caches.open(CONTENT_CACHE);
      const cached = await c.match(req);
      const net = fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => null);
      return cached || (await net) || new Response('{}', { status: 504 });
    })());
    return;
  }

  // 音频等资源：缓存优先
  if (url.pathname.includes('/content/')) {
    e.respondWith((async () => {
      const c = await caches.open(CONTENT_CACHE);
      const cached = await c.match(req);
      if (cached) return cached;
      try {
        const r = await fetch(req);
        if (r.ok) c.put(req, r.clone());
        return r;
      } catch (err) {
        return new Response('离线且未缓存', { status: 504, statusText: 'offline' });
      }
    })());
    return;
  }

  // 应用外壳：缓存优先，缺失再联网
  e.respondWith((async () => {
    const c = await caches.open(SHELL_CACHE);
    const cached = await c.match(req);
    if (cached) return cached;
    try {
      const r = await fetch(req);
      if (r.ok && req.destination !== 'document') c.put(req, r.clone());
      return r;
    } catch {
      return (await c.match('./index.html')) || new Response('离线', { status: 504 });
    }
  })());
});
