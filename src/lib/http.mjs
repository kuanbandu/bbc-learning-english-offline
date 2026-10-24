import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const CACHE_DIR = '.cache/http';

class Semaphore {
  constructor(max) {
    this.max = Math.max(1, max | 0);
    this.active = 0;
    this.queue = [];
  }
  async run(fn) {
    if (this.active >= this.max) await new Promise((res) => this.queue.push(res));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

export function createHttp(cfg) {
  // 代理由入口脚本在进程启动前通过 NODE_USE_ENV_PROXY 注入，这里不再处理
  const sem = new Semaphore(cfg.concurrency || 3);
  const minDelay = cfg.minDelayMs ?? 0;
  let lastAt = 0;
  let chain = Promise.resolve();

  async function throttle() {
    // 串行化节流计算，保证并发下也遵守最小间隔
    chain = chain.then(async () => {
      const wait = lastAt + minDelay - Date.now();
      if (wait > 0) await sleep(wait);
      lastAt = Date.now();
    });
    return chain;
  }

  function cachePath(url) {
    const key = crypto.createHash('sha1').update(url).digest('hex');
    return path.join(CACHE_DIR, key.slice(0, 2), `${key}.bin`);
  }

  function readCache(url) {
    if (!cfg.cacheHtml) return null;
    const p = cachePath(url);
    try {
      if (!fs.existsSync(p)) return null;
      return fs.readFileSync(p);
    } catch {
      return null;
    }
  }

  function writeCache(url, buf) {
    if (!cfg.cacheHtml) return;
    const p = cachePath(url);
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, buf);
    } catch {
      /* 缓存失败不影响主流程 */
    }
  }

  async function request(url, { binary = false, timeoutMs, retries, label } = {}) {
    const attempts = (retries ?? cfg.retries ?? 3) + 1;
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      await throttle();
      try {
        const res = await sem.run(() =>
          fetch(url, {
            redirect: 'follow',
            signal: AbortSignal.timeout(timeoutMs ?? cfg.timeoutMs ?? 30000),
            headers: {
              'user-agent': cfg.userAgent,
              accept: binary ? '*/*' : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
            },
          })
        );
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (!binary) writeCache(url, buf);
        return { buffer: buf, text: () => buf.toString('utf8'), url, finalUrl: res.url };
      } catch (err) {
        lastErr = err;
        const cached = readCache(url);
        if (cached && !binary) {
          return { buffer: cached, text: () => cached.toString('utf8'), url, fromCache: true, finalUrl: url };
        }
        if (i < attempts - 1) await sleep(600 * Math.pow(2, i));
      }
    }
    throw new Error(`请求失败${label ? ` [${label}]` : ''}: ${url} -> ${lastErr?.message}`);
  }

  return {
    getText: async (url, opts) => {
      const r = await request(url, opts);
      return r.text();
    },
    // BBC 会按地区重定向（如 /english/... → /persian/...），解析基准必须用最终 URL
    getPage: async (url, opts) => {
      const r = await request(url, opts);
      return { text: r.text(), url: r.finalUrl || url };
    },
    getBuffer: async (url, opts) => (await request(url, { ...opts, binary: true })).buffer,

    /**
     * 流式下载到磁盘。BBC 的单集音频约 10-15MB，走代理可能只有 100KB/s，
     * 因此超时要给足，并支持断点续传（写入 .part，中断后从断点继续）。
     */
    downloadTo: async (url, dest, { timeoutMs = 600000, label } = {}) => {
      const tmp = `${dest}.part`;
      let started = 0;
      try { started = fs.statSync(tmp).size; } catch { /* 没有断点 */ }

      await throttle();
      const res = await sem.run(() =>
        fetch(url, {
          redirect: 'follow',
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            'user-agent': cfg.userAgent,
            accept: '*/*',
            ...(started ? { range: `bytes=${started}-` } : {}),
          },
        })
      );

      // 服务端不支持续传时从头重下
      const append = res.status === 206 && started > 0;
      if (!res.ok && res.status !== 206) throw new Error(`${label || 'download'} HTTP ${res.status}`);
      if (!append && started) { await fsp.rm(tmp, { force: true }); started = 0; }

      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const total = Number(res.headers.get('content-length') || 0) + started;
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp, { flags: append ? 'a' : 'w' }));
      await fsp.rename(tmp, dest);
      return { bytes: fs.statSync(dest).size, resumed: append, total };
    },

    clearCache() {
      fs.rmSync(CACHE_DIR, { recursive: true, force: true });
    },
  };
}
