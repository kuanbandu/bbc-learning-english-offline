import { attr, metaContent, absUrl } from './html.mjs';
import { findPids } from './audio.mjs';

const VIDEO_EXT = /\.(mp4|m4v|webm|mov)(\?|#|$)/i;

// 统一升到 https：安卓 9+ 默认拦截明文 http
const httpsify = (u) => (typeof u === 'string' && /^http:/i.test(u) ? u.replace(/^http:/i, 'https:') : u);

/** 从 HTML 里直接挖视频直链（优先 progressive mp4；hls/dash 不处理） */
function directVideoFromHtml(html, base) {
  // 1. og:video / twitter 系列
  for (const k of ['og:video:secure_url', 'og:video:url', 'og:video', 'twitter:player:stream']) {
    const v = metaContent(html, k);
    if (v && /^https?:/i.test(v) && VIDEO_EXT.test(v)) return { url: httpsify(v), how: `meta:${k}` };
  }

  // 2. <video> 标签及其 <source>
  for (const b of html.matchAll(/<video\b([^>]*)>([\s\S]*?)<\/video>/gi)) {
    for (const name of ['src', 'data-src', 'data-video-src', 'data-media-src']) {
      const u = attr(b[1], name);
      if (u && VIDEO_EXT.test(u)) return { url: httpsify(absUrl(base, u)), how: 'video:' + name };
    }
    for (const s of b[2].matchAll(/<source\b([^>]*)>/gi)) {
      const u = attr(s[1], 'src');
      if (u && VIDEO_EXT.test(u)) return { url: httpsify(absUrl(base, u)), how: 'video:source' };
    }
  }

  // 3. 页面里任何指向 mp4 的链接
  const linkRe = /(?:href|src|data-[a-z-]*(?:video|media|asset|file)[a-z-]*)\s*=\s*["']([^"']+\.(?:mp4|m4v|webm|mov)(?:\?[^"']*)?)["']/gi;
  for (const m of html.matchAll(linkRe)) {
    const u = absUrl(base, m[1]);
    if (u) return { url: httpsify(u), how: 'link:video-ext' };
  }

  // 4. 内联 JSON / 脚本里出现的 mp4
  for (const m of html.matchAll(/https?:[^"'\\\s]*?\.(?:mp4|m4v)(?:\?[^"'\\\s]*)?/gi)) {
    const u = m[0].replace(/\\u002f/gi, '/').replace(/\\\//g, '/');
    if (VIDEO_EXT.test(u)) return { url: httpsify(u), how: 'inline-json' };
  }

  return null;
}

/** 从 mediaselector 的 JSON 里挑一个可下载的 progressive 视频 */
function pickVideoConnection(json) {
  const cands = [];
  for (const m of (json && json.media) || []) {
    const kind = String(m.kind || '').toLowerCase();
    if (kind && kind !== 'video') continue;
    for (const c of m.connection || []) {
      const href = c.href || c.hrefSecure;
      if (!href || !/^https?:/i.test(href)) continue;
      const proto = String(c.protocol || '').toLowerCase();
      const tf = String(c.transferFormat || '').toLowerCase();
      if (tf === 'hls' || tf === 'dash') continue;      // 分段流不处理
      const isMp4 = /\.mp4|\.m4v/i.test(href);
      const progressive = tf === 'progressive' || isMp4;
      if (!progressive) continue;
      cands.push({
        href: proto === 'https' ? href : href.replace(/^http:/i, 'https:'),
        raw: href,
        bitrate: Number(c.bitrate || m.bitrate || 0),
        width: Number(c.width || c.horizontalResolution || 0),
        score: (isMp4 ? 20 : 0) + (proto === 'https' ? 10 : 0),
      });
    }
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.score - a.score || b.width - a.width || b.bitrate - a.bitrate);
  return cands[0];
}

async function fromMediaSelector(http, pid) {
  const sets = ['iptv-all', 'pc', 'tablet', 'default', 'http'];
  for (const set of sets) {
    const url = `https://open.live.bbc.co.uk/mediaselector/6/select/version/2.0/mediaset/${set}/vpid/${pid}/format/json/`;
    try {
      const text = await http.getText(url, { retries: 1, timeoutMs: 20000, label: 'mediaselector-video' });
      const best = pickVideoConnection(JSON.parse(text));
      if (best) return { url: best.href, how: `mediaselector:${set}`, bitrate: best.bitrate, width: best.width };
    } catch { /* 换下一个 mediaset */ }
  }
  return null;
}

/** 主入口：尽最大努力拿到视频直链（拿不到就返回 null，不影响音频） */
export async function resolveVideo(http, html, base, { allowMediaSelector = true } = {}) {
  const direct = directVideoFromHtml(html, base);
  if (direct) return direct;

  if (allowMediaSelector) {
    for (const pid of findPids(html).slice(0, 4)) {
      const via = await fromMediaSelector(http, pid);
      if (via) return { ...via, pid };
    }
  }
  return null;
}
