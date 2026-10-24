import { attr, metaContent, absUrl, decodeEntities } from './html.mjs';

const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus)(\?|#|$)/i;

/** 从 HTML 里直接挖音频直链 */
function directFromHtml(html, base) {
  // 1. og:audio 系列
  for (const k of ['og:audio:secure_url', 'og:audio', 'twitter:player:stream']) {
    const v = metaContent(html, k);
    if (v && /^https?:/i.test(v)) return { url: v, how: `meta:${k}` };
  }

  // 2. <audio> / <video> 的 src 与内部 <source>
  const mediaBlocks = [...html.matchAll(/<(audio|video)\b([^>]*)>([\s\S]*?)<\/\1>/gi)];
  for (const b of mediaBlocks) {
    const src = attr(b[2], 'src');
    if (src && AUDIO_EXT.test(src)) return { url: absUrl(base, src), how: 'media-tag:src' };
    const inner = [...b[3].matchAll(/<source\b([^>]*)>/gi)];
    for (const s of inner) {
      const u = attr(s[1], 'src');
      if (u && AUDIO_EXT.test(u)) return { url: absUrl(base, u), how: 'media-tag:source' };
    }
  }

  // 3. 页面里任何指向音频文件的链接
  const links = [...html.matchAll(/(?:href|src|data-[a-z-]*(?:audio|media|asset|file)[a-z-]*)\s*=\s*["']([^"']+\.(?:mp3|m4a|aac|ogg|oga|opus)(?:\?[^"']*)?)["']/gi)];
  for (const l of links) {
    const u = absUrl(base, l[1]);
    if (u) return { url: u, how: 'link:audio-ext' };
  }

  // 4. JSON-LD
  for (const b of [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)]) {
    try {
      const json = JSON.parse(b[1].trim());
      const found = deepFindAudio(json);
      if (found) return { url: absUrl(base, found), how: 'json-ld' };
    } catch { /* 忽略坏的 JSON-LD */ }
  }

  // 5. 内联 JSON 里的 mp3（BBC 常把媒体信息塞进 data 属性或 window.__INITIAL__ 之类）
  const blobs = [...html.matchAll(/https?:[^"'\\\s]*?(?:podcasts\.files\.bbci\.co\.uk|bbci\.co\.uk\/[^"'\s]*?\.mp3|[^"'\s]*?\.mp3(?:\?[^"'\s]*)?)/gi)];
  for (const b of blobs) {
    const u = b[0].replace(/\\u002f/gi, '/').replace(/\\\//g, '/');
    if (AUDIO_EXT.test(u)) return { url: u, how: 'inline-json' };
  }

  return null;
}

function deepFindAudio(node, depth = 0) {
  if (depth > 8) return null;
  if (typeof node === 'string') return AUDIO_EXT.test(node) ? node : null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const r = deepFindAudio(n, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (node && typeof node === 'object') {
    for (const key of ['contentUrl', 'url', 'audio', 'src', 'embedUrl']) {
      if (typeof node[key] === 'string' && AUDIO_EXT.test(node[key])) return node[key];
      if (node[key] && typeof node[key] === 'object') {
        const r = deepFindAudio(node[key], depth + 1);
        if (r) return r;
      }
    }
  }
  return null;
}

/** 从 HTML 里找 BBC 的 vpid / pid */
export function findPids(html) {
  const pids = new Set();
  const patterns = [
    /(?:["']?vpid["']?\s*[:=]\s*["'])([a-z0-9]{8})["']/gi,
    /vpid=([a-z0-9]{8})/gi,
    /\/programmes\/([a-z0-9]{8})\b/gi,
    /(?:["']?pid["']?\s*[:=]\s*["'])([a-z0-9]{8})["']/gi,
    /data-(?:vpid|pid|media-id)\s*=\s*["']([a-z0-9]{8})["']/gi,
  ];
  for (const re of patterns) {
    for (const m of html.matchAll(re)) pids.add(m[1]);
  }
  return [...pids];
}

/** 通过 BBC 官方媒体选择器拿直链（依次尝试多种 mediaset） */
async function fromMediaSelector(http, vpid) {
  const sets = ['audio-nondrm-download', 'pc', 'apple-itunes-audio', 'https'];
  for (const set of sets) {
    const url = `https://open.live.bbc.co.uk/mediaselector/6/select/version/2.0/mediaset/${set}/vpid/${vpid}/format/json/`;
    try {
      const text = await http.getText(url, { retries: 1, timeoutMs: 20000, label: 'mediaselector' });
      const json = JSON.parse(text);
      const best = pickConnection(json);
      if (best) return { url: best.href, how: `mediaselector:${set}`, bitrate: best.bitrate };
    } catch { /* 换下一个 mediaset */ }
  }
  return null;
}

function pickConnection(json) {
  const media = json?.media || [];
  const cands = [];
  for (const m of media) {
    const kind = (m.kind || '').toLowerCase();
    const type = (m.type || '').toLowerCase();
    for (const c of m.connection || []) {
      const href = c.href || c.hrefSecure;
      if (!href || !/^https?:/i.test(href)) continue;
      const proto = (c.protocol || '').toLowerCase();
      const tf = (c.transferFormat || '').toLowerCase();
      const isAudio = /\.mp3|\.m4a|\.aac|\.oga|\.opus/i.test(href) || tf === 'progressive' || kind === 'audio';
      if (!isAudio) continue;
      if (tf === 'hls' && !/\.(mp3|m4a|aac)/i.test(href)) continue;
      cands.push({
        href: proto === 'https' ? href : href.replace(/^http:/i, 'https:'),
        bitrate: Number(c.bitrate || m.bitrate || 0),
        score: (tf === 'progressive' ? 100 : 0) + (/\.mp3/i.test(href) ? 20 : 0) + (proto === 'https' ? 10 : 0),
      });
    }
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.score - a.score || b.bitrate - a.bitrate);
  return cands[0];
}

/** 主入口：尽最大努力拿到音频直链 */
export async function resolveAudio(http, html, base, { allowMediaSelector = true } = {}) {
  const direct = directFromHtml(html, base);
  if (direct) return direct;

  if (allowMediaSelector) {
    for (const pid of findPids(html).slice(0, 4)) {
      const via = await fromMediaSelector(http, pid);
      if (via) return { ...via, pid };
    }
  }
  return null;
}

/** <enclosure> 之外的音频兜底：RSS 里常见的 media:content */
export function audioFromRssItem(itemXml) {
  const enc = itemXml.match(/<enclosure\b([^>]*)\/?>/i);
  if (enc) {
    const u = attr(enc[1], 'url');
    if (u) return decodeEntities(u);
  }
  const mc = itemXml.match(/<media:content\b([^>]*)\/?>/i);
  if (mc) {
    const u = attr(mc[1], 'url');
    if (u && AUDIO_EXT.test(u)) return decodeEntities(u);
  }
  const gl = itemXml.match(/<link\b([^>]*)>/i);
  if (gl) {
    const u = attr(gl[1], 'href');
    if (u && AUDIO_EXT.test(u)) return decodeEntities(u);
  }
  return null;
}
