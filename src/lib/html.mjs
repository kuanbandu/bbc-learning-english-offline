// 极简 HTML 工具（零依赖，正则实现，够用即可）

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', mdash: '—', ndash: '–',
};

export function decodeEntities(s = '') {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in NAMED ? NAMED[n.toLowerCase()] : m));
}

export function attr(tag, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = tag.match(re);
  if (!m) return null;
  return decodeEntities(m[1] ?? m[2] ?? m[3] ?? '');
}

export function stripTags(html = '') {
  return decodeEntities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function absUrl(base, href) {
  if (!href) return null;
  try {
    const u = new URL(href.trim(), base);
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

/** 提取所有 <a> 的 { href(绝对), text } */
export function anchors(html, base) {
  const out = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = absUrl(base, attr(m[1], 'href'));
    if (!href) continue;
    const text = stripTags(m[2]).replace(/\s+/g, ' ').trim();
    out.push({ href, text, tag: m[1] });
  }
  return out;
}

export function metaContent(html, key) {
  const re = new RegExp(
    `<meta\\b[^>]*(?:property|name|itemprop)\\s*=\\s*["']?${key}["']?[^>]*>`,
    'i'
  );
  const m = html.match(re);
  if (!m) return null;
  const c = attr(m[0], 'content');
  return c ? decodeEntities(c) : null;
}

export function tagBlocks(html, name) {
  const re = new RegExp(`<${name}\\b([^>]*)>([\\s\\S]*?)<\\/${name}>`, 'gi');
  return [...html.matchAll(re)].map((m) => ({ attrs: m[1], inner: m[2], full: m[0] }));
}

export function textToSentences(text) {
  return text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap((p) =>
      p
        .replace(/([.!?])\s+(?=[A-Z"'“])/g, '$1\u0000')
        .split('\u0000')
        .map((s) => s.trim())
        .filter(Boolean)
    );
}

/** 从 startIdx 处（一个 <div ...> 标签）找到配对的 </div> 结束位置 */
function blockEnd(html, startIdx) {
  const re = /<div\b[^>]*>|<\/div\s*>/gi;
  re.lastIndex = startIdx;
  let depth = 0;
  let m;
  while ((m = re.exec(html))) {
    if (m[0][1] === '/') {
      depth--;
      if (depth === 0) return m.index + m[0].length;
    } else depth++;
  }
  return html.length;
}

/**
 * 站点级区块编号（BBC 用 ≥1000 标记全站通用的页脚/导航挂件，
 * 如 "Find Everything" 全站菜单），正文内容挂件编号都是个位数。
 */
function stripSiteBlocks(html, min = 1000) {
  const re = /<div class="widget ([^"]*)"(?:\s+data-widget-index="(\d+)")?[^>]*>/gi;
  const targets = [];
  let m;
  while ((m = re.exec(html))) {
    const idxAttr = m[2];
    const tail = m[1].match(/\s(\d{3,})\s*$/);
    const n = idxAttr ? Number(idxAttr) : tail ? Number(tail[1]) : 0;
    if (n >= min) targets.push(m.index);
  }
  let out = html;
  for (const i of targets.reverse()) {
    const end = blockEnd(out, i);
    out = out.slice(0, i) + out.slice(end);
  }
  return out;
}

/**
 * 剥离 BBC 站点外壳，只留正文：
 * 1. 取 #bbcle-content 区块（页面正文，已不含站内导航）
 * 2. 去掉编号 ≥1000 的全站通用挂件（页脚菜单、相关链接等）
 */
export function extractMainHtml(html) {
  let out = html;
  const cm = out.match(/<div\s+id=["']bbcle-content["'][^>]*>/i);
  if (cm) {
    out = out.slice(cm.index, blockEnd(out, cm.index));
  } else {
    const hm = out.match(/<div\s+id=["']bbcle-header["'][^>]*>/i);
    if (hm) {
      const end = blockEnd(out, hm.index);
      out = out.slice(0, hm.index) + out.slice(end);
    }
    const fm = out.search(/<div\s+id=["']orb-footer["']/i);
    if (fm > 0) out = out.slice(0, fm);
  }
  out = stripSiteBlocks(out, 1000);
  return out
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
}

export function slugify(s = '') {
  return (
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'untitled'
  );
}
