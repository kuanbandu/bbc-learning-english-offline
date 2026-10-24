// app/net.js —— 在线下载客户端（ES 模块）
//
// 设计要点：
// 1. 直接复用 src/lib 里的解析逻辑（html.mjs / audio.mjs / parse.mjs），
//    这样手机里解析 BBC 页面用的代码和电脑上抓取用的是同一份，不会出现两套逻辑漂移。
// 2. 用 @capacitor/http 发原生请求，绕过浏览器的 CORS 限制（只有装成 App 才有这个能力，
//    普通浏览器里打开 PWA 只能浏览目录、不能下载音频）。
// 3. 音频下载后存进 @capacitor/filesystem 的 DATA 目录，断网也能听；
//    文稿则存进 localStorage 的“已下载”索引里。

import { parseCoursePage, parseSeriesPage, parseEpisodePage } from './lib/parse.mjs';

const Cap = window.Capacitor;
const NATIVE = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
// 不依赖插件的 JS 包，用 registerPlugin 直接走原生桥（标准插件都支持）
const Http = NATIVE
  ? (Cap.Plugins?.CapacitorHttp || Cap.registerPlugin('CapacitorHttp'))
  : null;
const FS = NATIVE
  ? (Cap.Plugins?.Filesystem || Cap.registerPlugin('Filesystem'))
  : null;

const UA =
  'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
};

// 与 config.json 的 startUrls 保持一致
const ENTRY_URLS = [
  { id: 'home', label: '首页精选', url: 'https://www.bbc.co.uk/learningenglish' },
  { id: 'easy', label: '入门', url: 'https://www.bbc.co.uk/learningenglish/chinese/easy_course' },
  { id: 'medium', label: '中级', url: 'https://www.bbc.co.uk/learningenglish/medium_course' },
  { id: 'hard', label: '高级', url: 'https://www.bbc.co.uk/learningenglish/hard_course' },
];

const safeName = (s) => String(s || 'x').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60);

/* ---------------- HTTP 适配层：给解析器用的 getText ---------------- */
async function getText(url) {
  if (Http) {
    const r = await Http.get({ url, headers: HEADERS });
    return typeof r.data === 'string' ? r.data : '';
  }
  // 浏览器兜底（抓 BBC 会被 CORS 拦，仅用于本地调试）
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return await res.text();
}
const httpAdapter = { getText };

/* ---------------- 目录（课程 -> 系列）缓存 ---------------- */
const KEY_CATALOG = 'ble.catalog';
function getCatalog() {
  try { return JSON.parse(localStorage.getItem(KEY_CATALOG) || 'null'); } catch { return null; }
}
function setCatalog(c) {
  localStorage.setItem(KEY_CATALOG, JSON.stringify(c));
}

async function fetchCatalog() {
  const courses = [];
  for (const entry of ENTRY_URLS) {
    let course = { id: entry.id, label: entry.label, url: entry.url, series: [] };
    try {
      const html = await getText(entry.url);
      const c = parseCoursePage(html, entry.url);
      course.series = (c.series || []).map((s) => ({
        id: safeName(s.url),
        title: s.text || s.url,
        url: s.url,
        level: entry.label,
      }));
    } catch (e) {
      course.error = String(e.message || e);
    }
    courses.push(course);
  }
  const out = { at: Date.now(), courses };
  setCatalog(out);
  return out;
}

async function fetchSeries(series) {
  const html = await getText(series.url);
  const s = await parseSeriesPage(httpAdapter, html, series.url);
  return {
    id: series.id,
    title: s.title || series.title,
    url: series.url,
    episodes: (s.episodes || []).map((e) => ({
      id: e.id || safeName(e.url),
      title: e.title,
      url: e.url,
      date: e.date,
      audioUrl: e.audioUrl || null,
      source: e.source,
      seriesId: series.id,
      seriesTitle: s.title || series.title,
      level: series.level,
    })),
  };
}

// 单集：音频地址或文稿缺失时，抓单集页补全
async function fetchEpisode(ep) {
  if (ep.audioUrl && Array.isArray(ep.transcript) && ep.transcript.length) return ep;
  try {
    const html = await getText(ep.url);
    const p = await parseEpisodePage(httpAdapter, html, ep.url);
    return {
      ...ep,
      title: p.title || ep.title,
      date: p.date || ep.date,
      audioUrl: p.audioUrl || ep.audioUrl,
      transcript: p.transcript || [],
      transcriptFile: p.transcriptFile || null,
    };
  } catch (e) {
    return { ...ep, fetchError: String(e.message || e) };
  }
}

/* ---------------- 下载 ---------------- */
function abToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// 返回 { ok, ep } 或抛错
async function downloadAudio(ep) {
  const full = await fetchEpisode(ep);
  if (!full.audioUrl) throw new Error('本集没有可下载的音频地址');
  const res = await Http.get({
    url: full.audioUrl,
    headers: { 'User-Agent': UA, Accept: '*/*' },
    responseType: 'arraybuffer',
  });
  const b64 = typeof res.data === 'string' ? res.data : abToB64(res.data);
  const path = `downloads/${safeName(full.seriesId)}/${safeName(full.id)}.mp3`;
  await FS.writeFile({ path, data: b64, directory: 'DATA', recursive: true });

  const stored = {
    seriesId: full.seriesId,
    seriesTitle: full.seriesTitle,
    id: full.id,
    title: full.title,
    date: full.date,
    url: full.url,
    audioUrl: full.audioUrl,
    transcript: full.transcript || [],
    localPath: path,
    level: full.level,
    at: Date.now(),
  };
  addToLibrary(stored);
  return { ok: true, ep: stored };
}

/* ---------------- 已下载索引（localStorage） ---------------- */
const KEY_LIB = 'ble.library';
function getLibrary() {
  try { return JSON.parse(localStorage.getItem(KEY_LIB) || '{"episodes":{}}'); } catch { return { episodes: {} }; }
}
function saveLibrary(lib) {
  try { localStorage.setItem(KEY_LIB, JSON.stringify(lib)); } catch { /* 隐私模式忽略 */ }
}
const libKey = (seriesId, epId) => seriesId + '/' + epId;
function addToLibrary(ep) {
  const lib = getLibrary();
  lib.episodes[libKey(ep.seriesId, ep.id)] = ep;
  saveLibrary(lib);
}
function getStored(seriesId, epId) {
  return getLibrary().episodes[libKey(seriesId, epId)] || null;
}
async function removeFromLibrary(seriesId, epId) {
  const lib = getLibrary();
  delete lib.episodes[libKey(seriesId, epId)];
  saveLibrary(lib);
  if (FS) {
    try {
      await FS.deleteFile({ path: `downloads/${safeName(seriesId)}/${safeName(epId)}.mp3`, directory: 'DATA' });
    } catch { /* 文件可能不存在 */ }
  }
}
async function localSrc(localPath) {
  if (!FS) return null;
  const { uri } = await FS.getUri({ path: localPath, directory: 'DATA' });
  return Cap.convertFileSrc(uri);
}

/* ---------------- 导出 ---------------- */
const API = {
  NATIVE,
  ENTRY_URLS,
  getCatalog,
  fetchCatalog,
  fetchSeries,
  fetchEpisode,
  downloadAudio,
  getLibrary,
  getStored,
  removeFromLibrary,
  localSrc,
};
window.BBCNet = API;
window.dispatchEvent(new Event('bbcnet:ready'));
