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

// 运行环境检测放到“调用时”求值，而不是模块加载时：
// Capacitor 的原生桥是页面加载过程中注入的，模块顶层取值可能过早。
function isNative() {
  const c = window.Capacitor;
  if (!c) return false;
  try {
    if (typeof c.isNativePlatform === 'function' && c.isNativePlatform()) return true;
    if (typeof c.getPlatform === 'function' && c.getPlatform() !== 'web') return true;
  } catch { /* ignore */ }
  // 最后兜底：Android 原生桥注入的全局对象
  return typeof window.androidBridge !== 'undefined';
}

let _http = null;
let _fs = null;
// 不依赖插件的 JS 包，用 registerPlugin 直接走原生桥（标准插件都支持）
function getHttp() {
  if (_http) return _http;
  const c = window.Capacitor;
  if (!c) return null;
  _http = c.Plugins?.HttpBridge || c.registerPlugin('HttpBridge');
  return _http;
}
function getFS() {
  if (_fs) return _fs;
  const c = window.Capacitor;
  if (!c) return null;
  _fs = c.Plugins?.Filesystem || c.registerPlugin('Filesystem');
  return _fs;
}

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
  const http = getHttp();
  if (http) {
    // 明确超时：默认读超时是 10 分钟，网络不通时会让人以为“卡死”
    const r = await http.get({
      url,
      headers: HEADERS,
      connectTimeout: 20000,
      readTimeout: 60000,
    });
    if (r.status && r.status >= 400) throw new Error('HTTP ' + r.status);
    return typeof r.data === 'string' ? r.data : '';
  }
  // 浏览器兜底（抓 BBC 会被 CORS 拦，仅用于本地调试）
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return await res.text();
}

// 网络自检：DNS 解析 → 系统代理 → HTTPS 探测，返回每一步的结果
async function diag() {
  const http = getHttp();
  if (!http || typeof http.diag !== 'function') {
    return { ok: false, error: '当前环境不支持自检（需要安卓 App）' };
  }
  return await http.diag({
    url: 'https://www.bbc.co.uk/learningenglish',
    host: 'www.bbc.co.uk',
    timeout: 12000,
  });
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
  const prev = getCatalog();

  // 四个栏目录并发抓取：任一失败不影响其它；每个失败重试一次（网络抖动很常见）
  const courses = await Promise.all(
    ENTRY_URLS.map(async (entry) => {
      const course = { id: entry.id, label: entry.label, url: entry.url, series: [], error: '' };
      let lastErr = '';
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const html = await getText(entry.url);
          const c = parseCoursePage(html, entry.url);
          course.series = (c.series || []).map((s) => ({
            id: safeName(s.url),
            title: s.text || s.url,
            url: s.url,
            level: entry.label,
          }));
          course.error = '';
          return course;
        } catch (e) {
          lastErr = String((e && e.message) || e);
          if (attempt === 0) await new Promise((r) => setTimeout(r, 500));
        }
      }
      course.error = lastErr;
      return course;
    })
  );

  const anyOk = courses.some((c) => c.series.length);
  const prevOk = !!(prev && Array.isArray(prev.courses) && prev.courses.some((c) => c.series && c.series.length));

  // 这次全失败但有历史成功数据：保留旧目录，避免用户白屏
  if (!anyOk && prevOk) {
    const firstErr = (courses.find((c) => c.error) || {}).error || '';
    const kept = { ...prev, stale: true, lastError: firstErr };
    setCatalog(kept); // 写回，保证界面重新渲染时还能看到 stale 标记
    return kept;
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

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// 在线播放用：把远程音频拉成 Blob（App 内走原生请求，绕过 CORS）
async function fetchAudioBlob(url) {
  const http = getHttp();
  if (!http) throw new Error('当前环境不支持原生网络请求（请用安卓 App 打开）');
  const r = await http.get({
    url,
    headers: { 'User-Agent': UA, Accept: '*/*' },
    responseType: 'arraybuffer',
  });
  if (r.status && r.status >= 400) throw new Error('HTTP ' + r.status);
  const b64 = typeof r.data === 'string' ? r.data : abToB64(r.data);
  return new Blob([b64ToBytes(b64)], { type: 'audio/mpeg' });
}

// 返回 { ok, ep } 或抛错
async function downloadAudio(ep) {
  const http = getHttp();
  const fs = getFS();
  if (!http) throw new Error('当前环境不支持原生网络请求（请用安卓 App 打开）');
  if (!fs) throw new Error('当前环境不支持本地存储');
  const full = await fetchEpisode(ep);
  if (!full.audioUrl) throw new Error('本集没有可下载的音频地址');
  const res = await http.get({
    url: full.audioUrl,
    headers: { 'User-Agent': UA, Accept: '*/*' },
    responseType: 'arraybuffer',
  });
  if (res.status && res.status >= 400) throw new Error('音频下载失败 HTTP ' + res.status);
  const b64 = typeof res.data === 'string' ? res.data : abToB64(res.data);
  const path = `downloads/${safeName(full.seriesId)}/${safeName(full.id)}.mp3`;
  await fs.writeFile({ path, data: b64, directory: 'DATA', recursive: true });

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
  const fs = getFS();
  if (fs) {
    try {
      await fs.deleteFile({ path: `downloads/${safeName(seriesId)}/${safeName(epId)}.mp3`, directory: 'DATA' });
    } catch { /* 文件可能不存在 */ }
  }
}
async function localSrc(localPath) {
  const fs = getFS();
  if (!fs) return null;
  const { uri } = await fs.getUri({ path: localPath, directory: 'DATA' });
  return window.Capacitor.convertFileSrc(uri);
}

/* ---------------- 导出 ---------------- */
const API = {
  isNative,
  ENTRY_URLS,
  diag,
  getCatalog,
  fetchCatalog,
  fetchSeries,
  fetchEpisode,
  fetchAudioBlob,
  downloadAudio,
  getLibrary,
  getStored,
  removeFromLibrary,
  localSrc,
};
window.BBCNet = API;
window.dispatchEvent(new Event('bbcnet:ready'));
