import { absUrl, anchors, attr, decodeEntities, extractMainHtml, metaContent, slugify, stripTags, textToSentences } from './html.mjs';
import { audioFromRssItem, resolveAudio } from './audio.mjs';
import { resolveVideo } from './video.mjs';

const LE_RE = /bbc\.co\.uk\/learningenglish\//i;

/* ---------------- 通用：带标题分组的链接收集 ---------------- */

function headings(html) {
  const out = [];
  const re = /<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/gi;
  let m;
  while ((m = re.exec(html))) out.push({ index: m.index, level: Number(m[1]), text: stripTags(m[3]) });
  return out;
}

function collectLinks(html, base) {
  const hs = headings(html);
  const items = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = absUrl(base, attr(m[1], 'href'));
    if (!href) continue;
    let url;
    try { url = new URL(href); } catch { continue; }
    if (!LE_RE.test(href)) continue;
    if (/\.(css|js|png|jpe?g|svg|ico|woff2?)$/i.test(url.pathname)) continue;
    const text = stripTags(m[2]).replace(/\s+/g, ' ').trim();
    let section = '';
    for (const h of hs) if (h.index < m.index) section = h.text; else break;
    items.push({ url: href, path: url.pathname, text, section });
  }
  // 去重（同 URL 保留文本更长的）
  const map = new Map();
  for (const it of items) {
    const key = it.url.replace(/\/$/, '');
    const prev = map.get(key);
    if (!prev || (it.text || '').length > (prev.text || '').length) map.set(key, { ...it, url: key });
  }
  return [...map.values()];
}

/** /features/<slug>  => 节目；/features/<slug>/<id> => 单集 */
function classify(link) {
  const p = link.path.replace(/\/+$/, '');
  const m = p.match(/\/features\/([^/]+)(?:\/([^/]+))?$/i);
  if (m) return m[2] ? { type: 'episode', seriesSlug: m[1], id: m[2] } : { type: 'series', seriesSlug: m[1] };
  if (/\/courses?\/[^/]+$/i.test(p)) return { type: 'series', seriesSlug: p.split('/').pop() };
  return { type: 'other' };
}

/* ---------------- 课程目录页 ---------------- */

export function parseCoursePage(rawHtml, base) {
  const html = extractMainHtml(rawHtml);
  const links = collectLinks(html, base).map((l) => ({ ...l, ...classify(l) }));
  const self = new URL(base).pathname.replace(/\/+$/, '');
  const filtered = links.filter((l) => l.path.replace(/\/+$/, '') !== self);

  const series = filtered.filter((l) => l.type === 'series');
  const episodes = filtered.filter((l) => l.type === 'episode');
  const other = filtered.filter((l) => l.type === 'other');

  return {
    title: metaContent(html, 'og:title') || (html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '').trim() || 'Easy Courses',
    url: base,
    series,
    episodes,
    other,
    rss: discoverRss(html, base),
  };
}

/* ---------------- RSS ---------------- */

export function discoverRss(html, base) {
  const found = new Set();
  for (const m of html.matchAll(/<link\b([^>]*)>/gi)) {
    const t = (attr(m[1], 'type') || '').toLowerCase();
    const href = absUrl(base, attr(m[1], 'href'));
    if (href && /rss|atom/i.test(t)) found.add(href);
  }
  for (const a of anchors(html, base)) {
    // BBC 把 RSS 放在页脚的 <a> 上，URL 以 /rss 结尾且没有扩展名
    if (/\.rss(\?|#|$)/i.test(a.href) || /\/rss(\?|#|$)/i.test(a.href)) found.add(a.href);
    if (/feeds\.bbci\.co\.uk|podcasts\.files\.bbci\.co\.uk/i.test(a.href)) found.add(a.href);
  }
  return [...found];
}

// new Date('非法值').toISOString() 会抛异常，这里统一兜底
function toIsoDate(s) {
  if (!s) return '';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

function cdata(s) {
  return decodeEntities(s.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').trim());
}

export function parseRss(xml, base) {
  const items = [];
  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const x = m[1];
    const title = cdata(x.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '');
    const link = cdata(x.match(/<link>([\s\S]*?)<\/link>/i)?.[1] || '') || attr(x.match(/<link\b([^>]*)>/i)?.[1] || '', 'href') || '';
    // 部分 BBC 源（如 Pronunciation Lounge）的 item 完全没有日期字段
    const pub = cdata(
      x.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1] ||
      x.match(/<dc:date>([\s\S]*?)<\/dc:date>/i)?.[1] || ''
    );
    const guid = cdata(x.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i)?.[1] || '');
    const descRaw = x.match(/<description>([\s\S]*?)<\/description>/i)?.[1] || '';
    const encoded = x.match(/<content:encoded>([\s\S]*?)<\/content:encoded>/i)?.[1] || '';
    const dur = cdata(x.match(/<itunes:duration>([\s\S]*?)<\/itunes:duration>/i)?.[1] || '');
    const audioUrl = audioFromRssItem(x);
    items.push({
      id: episodeIdFrom(link || guid || title),
      title,
      url: absUrl(base || link, link) || null,
      date: toIsoDate(pub),
      audioUrl: audioUrl ? absUrl(base || link, audioUrl) : null,
      description: cdata(descRaw),
      descriptionHtml: /<[a-z]/i.test(cdata(encoded || descRaw)) ? cdata(encoded || descRaw) : '',
      duration: parseDuration(dur),
    });
  }
  return items;
}

export function parseDuration(v) {
  if (!v) return 0;
  if (/^\d+$/.test(v)) return Number(v);
  const m = String(v).match(/(?:(\d+):)?(\d+):(\d+)/);
  if (m) return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return 0;
}

export function episodeIdFrom(s = '') {
  const seg = s.replace(/\/+$/, '').split('/').pop() || '';
  return seg || slugify(s);
}

/** BBC 的单集编号自带日期：261023 / ep-240126 → 2026-10-23 */
export function dateFromId(id = '') {
  const m = String(id).match(/(\d{2})(\d{2})(\d{2})(?!\d)/);
  if (!m) return '';
  const [, y, mo, d] = m;
  if (mo < '01' || mo > '12' || d < '01' || d > '31') return '';
  return `20${y}-${mo}-${d}`;
}

/* ---------------- 节目（系列）页 ---------------- */

export async function parseSeriesPage(http, html, base) {
  const rss = discoverRss(html, base);
  let episodes = [];
  let viaRss = null;

  for (const r of rss.slice(0, 3)) {
    try {
      const xml = await http.getText(r, { label: 'rss' });
      const items = parseRss(xml, r);
      if (items.length) {
        episodes = items.map((i) => ({ ...i, source: 'rss' }));
        viaRss = r;
        break;
      }
    } catch { /* 继续尝试下一个 */ }
  }

  if (!episodes.length) {
    const self = new URL(base).pathname.replace(/\/+$/, '');
    const links = collectLinks(extractMainHtml(html), base)
      .map((l) => ({ ...l, ...classify(l) }))
      .filter((l) => l.type === 'episode' && l.path.replace(/\/+$/, '').startsWith(self + '/'));
    episodes = links.map((l) => ({
      id: l.path.replace(/\/+$/, '').split('/').pop(),
      title: l.text,
      url: l.url,
      date: '',
      audioUrl: null,
      description: '',
      duration: 0,
      source: 'html',
    }));
  }

  return {
    title: metaContent(html, 'og:title') || (html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '').trim() || 'Series',
    url: base,
    rss: viaRss || rss[0] || null,
    episodes,
  };
}

/* ---------------- 单集页 ---------------- */

const TRANSCRIPT_STOP = /\n\s*(FIND BBC LEARNING ENGLISH|MORE (?:FROM|ABOUT)|RELATED|YOU (?:MAY|MIGHT) LIKE|SUBSCRIBE|DOWNLOAD|TRY OUR|WATCH|LISTEN TO|GET OUR)/i;

// 折叠区会把 "Show transcript / Hide transcript" 按钮文字一起带出来
const TOGGLE_JUNK = /^(?:show|hide)\s+transcript$/i;

function extractTranscript(rawHtml) {
  const html = extractMainHtml(rawHtml);
  // 1. 带 transcript 标识的容器
  const containerPatterns = [
    /<([a-z0-9]+)\b[^>]*class\s*=\s*["'][^"']*(?:transcript|script-text|downloadable-text)[^"']*["'][^>]*>([\s\S]*?)<\/\1>/i,
    /<([a-z0-9]+)\b[^>]*id\s*=\s*["'][^"']*transcript[^"']*["'][^>]*>([\s\S]*?)<\/\1>/i,
    /<([a-z0-9]+)\b[^>]*data-(?:testid|component|e2e)\s*=\s*["'][^"']*transcript[^"']*["'][^>]*>([\s\S]*?)<\/\1>/i,
    // BBC 交互式课程页：文稿藏在 "Show transcript" 折叠区 widget-richtext-hideable 里
    // 注意：这里也要是 2 个捕获组，与上面的规则保持一致（第 2 组才是内容）
    /<div\b([^>]*(?:class|id)\s*=\s*["'][^"']*richtext-hideable[^"']*["'][^>]*)>([\s\S]*?)<\/div>\s*<\/div>/i,
  ];
  for (const re of containerPatterns) {
    const m = html.match(re);
    if (m) {
      const t = stripTags(m[2]);
      if (t.length > 80) return textToSentences(t).filter((s) => !TOGGLE_JUNK.test(s.trim()));
    }
  }

  // 2. 整页文本里找 Transcript 区块
  const text = stripTags(html);
  const idx = text.search(/\b(?:Transcript|TRANSCRIPT|文稿|文本)\b/);
  if (idx >= 0) {
    let rest = text.slice(idx);
    const stop = rest.slice(20).search(TRANSCRIPT_STOP);
    if (stop > 0) rest = rest.slice(0, stop + 20);
    const body = rest.replace(/^\s*(?:Transcript|TRANSCRIPT|文稿|文本)\s*[:\-]?\s*/i, '').trim();
    if (body.length > 80) return textToSentences(body).filter((s) => !TOGGLE_JUNK.test(s.trim())).slice(0, 400);
  }
  return [];
}

export async function parseEpisodePage(http, rawHtml, base) {
  const html = extractMainHtml(rawHtml);
  // 正文里通常没有 <h1>，标题信息在 <head>，所以标题要从原始 HTML 取
  const h1m = rawHtml.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const title =
    metaContent(rawHtml, 'og:title') ||
    metaContent(rawHtml, 'twitter:title') ||
    (rawHtml.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '').trim() ||
    (h1m ? stripTags(h1m[1]) : '') ||
    (html.match(/<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/i) ? stripTags(html.match(/<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/i)[1]) : '') ||
    '';

  const date =
    (html.match(/<time\b[^>]*datetime\s*=\s*["']([^"']+)["']/i)?.[1] || '').slice(0, 10) ||
    (metaContent(html, 'article:published_time') || '').slice(0, 10) ||
    (metaContent(html, 'og:pubdate') || '').slice(0, 10) ||
    dateFromId(episodeIdFrom(base)) ||
    '';

  const audio = await resolveAudio(http, html, base);
  // 视频拿不到不算错：很多系列本来就只有音频
  let video = null;
  try { video = await resolveVideo(http, html, base); } catch { video = null; }

  const pdfAnchor = anchors(html, base).find(
    (a) => /\.(pdf|txt|docx?)(\?|#|$)/i.test(a.href) || /transcript|文稿|worksheet|练习/i.test(a.text)
  );

  return {
    url: base,
    title: title.replace(/\s*\|\s*BBC.*$/i, '').trim(),
    date,
    audioUrl: audio?.url || null,
    audioHow: audio?.how || null,
    videoUrl: video?.url || null,
    videoHow: video?.how || null,
    transcript: extractTranscript(html),
    transcriptFile: pdfAnchor?.href || null,
  };
}
