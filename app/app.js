/* BBC 轻松英语 · 离线学习 PWA（零依赖） */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const LS = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 隐私模式忽略 */ } },
};
const KEY_PROGRESS = 'ble.progress';
const KEY_VOCAB = 'ble.vocab';
const KEY_FONT = 'ble.font';

let DATA = null;
let curSeries = null;
let curEp = null;
let audioObjUrl = null;

const audioEl = new Audio();
audioEl.preload = 'auto';
const videoEl = document.getElementById('pl-video');
// 当前活跃的媒体元素：有视频用 <video>，没有用 <audio>，两者共用同一套控件
let player = audioEl;

function useAudio() {
  if (player !== audioEl) { try { videoEl && videoEl.pause(); } catch { /* 忽略 */ } }
  player = audioEl;
  if (videoEl) videoEl.hidden = true;
}
function useVideo() {
  if (player !== videoEl) { try { audioEl.pause(); } catch { /* 忽略 */ } }
  player = videoEl;
  if (videoEl) videoEl.hidden = false;
}

let loopA = null, loopB = null, sleepTimer = null, follow = false;
const SPEEDS = [0.6, 0.8, 1.0, 1.25, 1.5, 2.0];
let speedIdx = 2;

/* ---------------- 工具 ---------------- */
const fmtTime = (s) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
};
const epKey = (s, e) => `${s.id}/${e.id || e.title}`;
const epAudioUrl = (e) => (e.audioFile ? `content/${e.audioFile}` : e.audioUrl);
const clean = (w) => w.replace(/^[^\p{L}\p{N}'’-]+|[^\p{L}\p{N}'’-]+$/gu, '');

/* ---------------- 导航 ---------------- */
const VIEWS = ['home', 'series', 'player', 'vocab', 'settings', 'download'];
let stack = [];

function show(view, { push = true, tab = false } = {}) {
  if (tab) stack = [view];
  else if (push && stack[stack.length - 1] !== view) stack.push(view);
  for (const v of VIEWS) $(`#view-${v}`).hidden = v !== view;
  $('#btn-back').hidden = !(stack.length > 1 && view !== 'home' && view !== 'vocab' && view !== 'settings');
  $('#topbar').style.display = view === 'home' ? '' : '';
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  if (view === 'download') renderDownload();
  window.scrollTo(0, 0);
}

$('#btn-back').onclick = () => {
  stack.pop();
  show(stack[stack.length - 1] || 'home', { push: false });
};
$$('.tab').forEach((t) => (t.onclick = () => show(t.dataset.view, { tab: true })));
$('#btn-menu').onclick = () => show('settings');

/* ---------------- 首页 ---------------- */
async function boot() {
  const fs = LS.get(KEY_FONT, 16);
  document.documentElement.style.setProperty('--fs', fs + 'px');
  try {
    const res = await fetch('content/index.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    DATA = await res.json();
  } catch (err) {
    $('#home-levels').innerHTML =
      `<div class="banner">还没有学习包。请在电脑上运行 <b>npm run build</b> 抓取课程，再执行 <b>npm run dist</b> 生成离线包。（${err.message}）</div>`;
    return;
  }
  await whenNet();
  mergeLibrary();
  renderHome();
}

// 等下载模块注入 window.BBCNet；它是普通脚本，通常已就绪，这里最多等 3 秒兜底
function whenNet() {
  if (window.BBCNet) return Promise.resolve();
  return Promise.race([
    new Promise((r) => window.addEventListener('bbcnet:ready', r, { once: true })),
    new Promise((r) => setTimeout(r, 3000)),
  ]);
}

// 把“已下载”库里的单集并入 DATA，让它们在「课程」里也能看到、播放
let libMerged = false;
function mergeLibrary() {
  if (libMerged) return;
  libMerged = true;
  if (!window.BBCNet || !DATA || !Array.isArray(DATA.courses)) return;
  const lib = window.BBCNet.getLibrary();
  for (const ep of Object.values(lib.episodes || {})) if (ep.localPath || ep.localVideoPath) addLocalEpisode(ep);
}
function ensureLocalCourse() {
  let c = DATA.courses.find((x) => x.id === 'local');
  if (!c) { c = { id: 'local', title: '我的下载', level: '已下载', series: [] }; DATA.courses.push(c); }
  return c;
}
function addLocalEpisode(ep) {
  const c = ensureLocalCourse();
  let s = c.series.find((x) => x.id === ep.seriesId);
  if (!s) { s = { id: ep.seriesId, title: ep.seriesTitle || ep.seriesId, level: '已下载', episodes: [] }; c.series.push(s); }
  if (!s.episodes.some((x) => x.id === ep.id)) {
    s.episodes.push({
      id: ep.id, title: ep.title, date: ep.date, url: ep.url,
      audioUrl: ep.audioUrl, videoUrl: ep.videoUrl || null,
      transcript: ep.transcript,
      localPath: ep.localPath || null,
      localVideoPath: ep.localVideoPath || null,
    });
  }
}

function allSeries() {
  return (DATA?.courses || []).flatMap((c) => c.series || []);
}
function allEpisodes() {
  return allSeries().flatMap((s) => s.episodes || []);
}

function renderHome() {
  const series = allSeries();
  const eps = allEpisodes();
  const downloaded = eps.filter((e) => e.audioFile).length;
  const progress = LS.get(KEY_PROGRESS, {});
  const listened = Object.values(progress).filter((p) => p && p.done).length;

  $('#home-summary').innerHTML =
    `<div>共 <b>${series.length}</b> 个节目 · <b>${eps.length}</b> 集</div>` +
    `<div class="muted small">已下载音频 ${downloaded} 集 · 已听完 ${listened} 集 · 生词 ${LS.get(KEY_VOCAB, []).length} 个</div>`;

  // 课程数据是空的（典型情况：APK 里没打包内容）
  if (!eps.length) {
    $('#home-levels').innerHTML =
      `<div class="banner">这个 App 里还没有课程内容。</div>` +
      `<div class="summary">
         <div>① <b>直接在 App 里下载</b>：底部切到「下载」→ 选栏目 → 点单集「下载」，音频和文稿会存进手机，断网也能听（仅安卓 App 内可用）。</div>
         <div style="margin-top:.5rem">② 电脑上跑 <b>npm start</b>，手机连同一个 WiFi 打开提示的地址，内容自动带过来。</div>
         <div class="muted small" style="margin-top:.5rem">音频和文稿版权归 BBC，不会随安装包一起分发，需自行获取后用于个人离线学习。</div>
       </div>`;
    return;
  }

  const groups = new Map();
  for (const s of series) {
    const k = s.level || '其他';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }

  $('#home-levels').innerHTML = [...groups.entries()]
    .map(([level, list]) => {
      const cards = list
        .map((s) => {
          const n = (s.episodes || []).length;
          const done = Object.keys(progress).filter((k) => k.startsWith(s.id + '/') && progress[k]?.done).length;
          const pct = n ? Math.round((done / n) * 100) : 0;
          return `<div class="card" data-series="${s.id}">
            <div class="t">${escapeHtml(s.title || s.id)}</div>
            <div class="m">${n} 集 · 完成 ${done}</div>
            <div class="bar"><i style="width:${pct}%"></i></div>
          </div>`;
        })
        .join('');
      return `<div class="level-title">${escapeHtml(level)}</div><div class="grid">${cards}</div>`;
    })
    .join('');

  $$('#home-levels .card').forEach((c) => (c.onclick = () => openSeries(c.dataset.series)));
}

function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- 节目页 ---------------- */
function openSeries(id) {
  curSeries = allSeries().find((s) => s.id === id);
  if (!curSeries) return;
  $('#series-title').textContent = curSeries.title || id;
  const n = (curSeries.episodes || []).length;
  $('#series-meta').textContent = `${curSeries.level || ''} ${n} 集`.trim() + (curSeries.rss ? ' · 有 RSS' : '');

  const progress = LS.get(KEY_PROGRESS, {});
  $('#episode-list').innerHTML = (curSeries.episodes || [])
    .map((e, i) => {
      const p = progress[epKey(curSeries, e)];
      const has = !!(e.audioFile || e.localPath);
      const pct = p && p.dur ? Math.min(100, Math.round((p.pos / p.dur) * 100)) : 0;
      const vid = hasVideo(e) ? ' · 视频' : '';
      return `<div class="row" data-i="${i}">
        <div class="ep">
          <div class="n">${i + 1}</div>
          <div class="body">
            <div class="t">${escapeHtml(e.title || e.id || 'Untitled')}</div>
            <div class="m">${escapeHtml(e.date || '')}${e.duration ? ` · ${fmtTime(e.duration)}` : ''}${vid}${pct ? ` · 已听 ${pct}%` : ''}</div>
          </div>
          <div class="dot ${has ? 'ok' : ''}">${has ? '离线' : '在线'}</div>
        </div>
      </div>`;
    })
    .join('');

  $$('#episode-list .row').forEach((r) => (r.onclick = () => openEpisode(Number(r.dataset.i))));
  show('series');
}

/* ---------------- 播放页 ---------------- */
async function openEpisode(i) {
  curEp = curSeries.episodes[i];
  curEp.__index = i;
  $('#pl-title').textContent = curEp.title || curEp.id || 'Untitled';
  $('#pl-meta').textContent = [
    curEp.date,
    hasVideo(curEp) ? '视频' : '',
    curEp.duration ? fmtTime(curEp.duration) : '',
    curEp.audioBytes ? `${(curEp.audioBytes / 1048576).toFixed(1)}MB` : '',
  ].filter(Boolean).join(' · ');
  $('#pl-errmsg').hidden = true;
  loopA = loopB = null;
  updateAbInfo();

  renderTranscript();
  if (curEp.url) {
    const a = $('#pl-source');
    a.href = curEp.url; a.hidden = false;
  } else $('#pl-source').hidden = true;

  show('player');

  try {
    await loadMedia(curEp);
  } catch (err) {
    $('#pl-errmsg').hidden = false;
    $('#pl-errmsg').textContent = `加载失败：${err.message}`;
  }
}

// 浏览器兜底：直接 fetch（App 内不会走到这里，浏览器里 BBC 也可能被 CORS 拦）
async function fetchAudioBlobWeb(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.blob();
}

const hasVideo = (e) => !!(e && (e.videoFile || e.localVideoPath || e.videoUrl));

async function loadMedia(e) {
  const net = window.BBCNet;
  const native = !!(net && net.isNative && net.isNative());
  try { audioEl.pause(); } catch { /* 忽略 */ }
  if (videoEl) { try { videoEl.pause(); } catch { /* 忽略 */ } }

  // 1) 有视频就优先播视频（本地文件优先，其次远程直链）
  if (hasVideo(e)) {
    let vsrc = null;
    if (e.localVideoPath && native) {
      try { vsrc = await net.localSrc(e.localVideoPath); } catch (err) { console.warn('本地视频解析失败', err); }
    }
    if (!vsrc && e.videoFile) vsrc = `content/${e.videoFile}`;
    if (!vsrc && e.videoUrl) vsrc = net && net.secureUrl ? net.secureUrl(e.videoUrl) : e.videoUrl;
    if (vsrc && videoEl) {
      useVideo();
      videoEl.src = vsrc;
      videoEl.load();
      resetProgressUI(e);
      return;
    }
  }

  // 2) 音频
  useAudio();
  let src = null;
  // 已下载到手机本地的音频：用原生文件地址直接播放（离线可用）
  if (e.localPath && native) {
    try { src = await net.localSrc(e.localPath); } catch (err) { console.warn('本地音频解析失败', err); }
  }
  if (!src) {
    const url = epAudioUrl(e);
    if (!url) throw new Error('本集没有音频地址');
    // App 内必须走原生请求：WebView 的 fetch 抓 BBC 会被 CORS 拦掉
    const blob = native ? await net.fetchAudioBlob(url) : await fetchAudioBlobWeb(url);
    if (audioObjUrl) URL.revokeObjectURL(audioObjUrl);
    audioObjUrl = URL.createObjectURL(blob);
    src = audioObjUrl;
  }
  audioEl.src = src;
  audioEl.load();
  resetProgressUI(e);
}

function resetProgressUI(e) {
  const p = LS.get(KEY_PROGRESS, {})[epKey(curSeries, e)];
  const resume = p && p.pos > 1 && p.pos < (p.dur || Infinity) - 2 ? p.pos : 0;
  if (resume) {
    // 元数据就绪后才能定位，否则 iOS/Safari 会报 InvalidStateError
    player.addEventListener('loadedmetadata', function seekOnce() {
      player.removeEventListener('loadedmetadata', seekOnce);
      try { player.currentTime = resume; } catch { /* 忽略 */ }
    });
  }
  player.playbackRate = SPEEDS[speedIdx];
  $('#btn-speed').textContent = SPEEDS[speedIdx].toFixed(1).replace(/0$/, '') + '×';
  $('#pl-dur').textContent = '0:00';
  $('#pl-cur').textContent = '0:00';
  seek.value = 0;
}

function renderTranscript() {
  const box = $('#transcript');
  const sents = curEp.transcript || [];
  $('#no-transcript').hidden = sents.length > 0;
  box.innerHTML = sents
    .map(
      (s, i) =>
        `<div class="sent" data-i="${i}">${String(s)
          .split(/(\s+)/)
          .map((tk) => (/^\s+$/.test(tk) ? tk : `<span class="w">${escapeHtml(tk)}</span>`))
          .join('')}</div>`
    )
    .join('');

  $$('#transcript .w').forEach((w) => {
    w.onclick = (ev) => {
      ev.stopPropagation();
      openSheet(w.textContent, w.parentElement);
    };
  });
  $$('#transcript .sent').forEach((s) => {
    s.onclick = () => {
      $$('#transcript .sent').forEach((x) => x.classList.remove('cur'));
      s.classList.add('cur');
    };
  });
}

/* ---------------- 播放器控制 ---------------- */
$('#btn-play').onclick = () => (player.paused ? player.play().catch(() => {}) : player.pause());
$('#btn-back5').onclick = () => (player.currentTime = Math.max(0, player.currentTime - 5));
$('#btn-fwd5').onclick = () => (player.currentTime = Math.min(player.duration || 0, player.currentTime + 5));

$('#btn-speed').onclick = () => {
  speedIdx = (speedIdx + 1) % SPEEDS.length;
  player.playbackRate = SPEEDS[speedIdx];
  $('#btn-speed').textContent = SPEEDS[speedIdx].toFixed(1).replace(/0$/, '') + '×';
  $('#btn-speed').classList.toggle('on', speedIdx !== 2);
};

$('#btn-a').onclick = () => { loopA = player.currentTime; loopB = null; updateAbInfo(); };
$('#btn-b').onclick = () => { loopB = player.currentTime; updateAbInfo(); };
$('#btn-ab-clear').onclick = () => { loopA = loopB = null; updateAbInfo(); };
function updateAbInfo() {
  const on = loopA !== null || loopB !== null;
  $('#ab-info').hidden = !on;
  $('#ab-info').textContent = on ? `循环区间 ${fmtTime(loopA ?? 0)} → ${fmtTime(loopB ?? player.duration ?? 0)}` : '';
  $('#btn-a').classList.toggle('on', loopA !== null);
  $('#btn-b').classList.toggle('on', loopB !== null);
}

const SLEEPS = [0, 15, 30, 60];
let sleepIdx = 0;
$('#btn-sleep').onclick = () => {
  sleepIdx = (sleepIdx + 1) % SLEEPS.length;
  const v = SLEEPS[sleepIdx];
  $('#btn-sleep').textContent = v ? `定时 ${v}分` : '定时 关';
  $('#btn-sleep').classList.toggle('on', v !== 0);
  clearTimeout(sleepTimer);
  if (v) sleepTimer = setTimeout(() => player.pause(), v * 60000);
};

$('#btn-follow').onclick = () => {
  follow = !follow;
  $('#btn-follow').textContent = `跟随 ${follow ? '开' : '关'}`;
  $('#btn-follow').classList.toggle('on', follow);
};

const seek = $('#pl-seek');
let seeking = false;
seek.oninput = () => { seeking = true; $('#pl-cur').textContent = fmtTime((seek.value / 1000) * (player.duration || 0)); };
seek.onchange = () => { if (player.duration) player.currentTime = (seek.value / 1000) * player.duration; seeking = false; };

function bindMedia(el) {
  el.addEventListener('timeupdate', () => {
    if (el !== player || !player.duration || seeking) return;
    seek.value = Math.round((player.currentTime / player.duration) * 1000);
    $('#pl-cur').textContent = fmtTime(player.currentTime);
    if (loopB !== null && player.currentTime >= loopB && loopA !== null) player.currentTime = loopA;
    if (follow) autoFollow();
    saveProgress();
  });
  el.addEventListener('loadedmetadata', () => {
    if (el === player) $('#pl-dur').textContent = fmtTime(player.duration);
  });
  el.addEventListener('play', () => {
    if (el === player) $('#btn-play').textContent = '❙❙';
  });
  el.addEventListener('pause', () => {
    if (el !== player) return;
    $('#btn-play').textContent = '▶';
    saveProgress();
  });
  el.addEventListener('ended', () => {
    if (el !== player) return;
    saveProgress(true);
    autoNext();
  });
}
bindMedia(audioEl);

if (videoEl) {
  bindMedia(videoEl);
  // 视频直链失效（403/过期）时自动退回音频，别让用户卡住
  videoEl.addEventListener('error', () => {
    if (videoEl !== player || !curEp) return;
    const hasAudio = !!(curEp.audioUrl || curEp.localPath || curEp.audioFile);
    if (!hasAudio) {
      $('#pl-errmsg').hidden = false;
      $('#pl-errmsg').textContent = '视频加载失败：直链可能已失效或被限制。';
      return;
    }
    $('#pl-errmsg').hidden = false;
    $('#pl-errmsg').textContent = '视频加载失败，已自动切换为音频。';
    loadMedia({ ...curEp, videoUrl: null, localVideoPath: null, videoFile: null }).catch(() => {});
  });
}

let lastSave = 0;
function saveProgress(done = false) {
  if (!curSeries || !curEp) return;
  const now = Date.now();
  if (!done && now - lastSave < 2000) return;
  lastSave = now;
  const all = LS.get(KEY_PROGRESS, {});
  const k = epKey(curSeries, curEp);
  all[k] = {
    pos: player.currentTime,
    dur: player.duration || 0,
    done: done || (all[k]?.done ?? false) || (player.duration && player.currentTime / player.duration > 0.95),
    at: new Date().toISOString(),
  };
  LS.set(KEY_PROGRESS, all);
}

function autoFollow() {
  const sents = $$('#transcript .sent');
  if (!sents.length || !player.duration) return;
  const i = Math.min(sents.length - 1, Math.floor((player.currentTime / player.duration) * sents.length));
  const s = sents[i];
  if (!s.classList.contains('cur')) {
    $$('#transcript .sent').forEach((x) => x.classList.remove('cur'));
    s.classList.add('cur');
    s.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function autoNext() {
  if (!curSeries) return;
  const next = curSeries.episodes[curEp.__index + 1];
  if (next) openEpisode(curEp.__index + 1);
}

/* ---------------- 点词面板 ---------------- */
let sheetCtx = { word: '', sent: '' };
function openSheet(rawWord, sentEl) {
  const word = clean(rawWord);
  if (!word) return;
  sheetCtx = { word, sent: sentEl ? sentEl.textContent.trim() : word };
  $('#sheet-word').textContent = word;
  $('#sheet').hidden = false;
}
$('#sheet-close').onclick = () => ($('#sheet').hidden = true);
$('#sheet').onclick = (e) => { if (e.target.id === 'sheet') $('#sheet').hidden = true; };
$('#sheet-add').onclick = () => {
  const list = LS.get(KEY_VOCAB, []);
  if (!list.some((v) => v.word === sheetCtx.word)) {
    list.unshift({ word: sheetCtx.word, sent: sheetCtx.sent, from: curEp?.title || '', at: new Date().toISOString() });
    LS.set(KEY_VOCAB, list);
  }
  $('#sheet').hidden = true;
  renderVocab();
};
$('#sheet-speak').onclick = () => {
  try {
    const u = new SpeechSynthesisUtterance(sheetCtx.sent);
    u.lang = 'en-GB';
    u.rate = 0.9;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch { /* 不支持则忽略 */ }
  $('#sheet').hidden = true;
};
$('#sheet-copy').onclick = async () => {
  try { await navigator.clipboard.writeText(sheetCtx.sent); } catch { /* noop */ }
  $('#sheet').hidden = true;
};

/* ---------------- 生词本 ---------------- */
function renderVocab() {
  const list = LS.get(KEY_VOCAB, []);
  $('#vocab-meta').textContent = `${list.length} 个生词`;
  $('#vocab-list').innerHTML = list.length
    ? list
        .map(
          (v, i) => `<div class="row">
            <div class="ep"><div class="body">
              <div class="t">${escapeHtml(v.word)}</div>
              <div class="m">${escapeHtml(v.sent || '')}</div>
              <div class="m">${escapeHtml(v.from || '')}</div>
            </div></div>
            <button class="chip" data-del="${i}">删除</button>
          </div>`
        )
        .join('')
    : '<p class="muted">还没有生词。在文稿里点任意单词即可加入。</p>';
  $$('#vocab-list [data-del]').forEach((b) => {
    b.onclick = () => {
      const l = LS.get(KEY_VOCAB, []);
      l.splice(Number(b.dataset.del), 1);
      LS.set(KEY_VOCAB, l);
      renderVocab();
    };
  });
}
$('#btn-vocab-export').onclick = () => {
  const list = LS.get(KEY_VOCAB, []);
  const csv = '﻿' + [['word', 'sentence', 'from'], ...list.map((v) => [v.word, v.sent, v.from])]
    .map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = '生词本.csv';
  a.click();
};
$('#btn-vocab-clear').onclick = () => {
  if (confirm('确定清空生词本？')) { LS.set(KEY_VOCAB, []); renderVocab(); }
};

/* ---------------- 设置 ---------------- */
$('#btn-cache-all').onclick = async () => {
  const btn = $('#btn-cache-all');
  btn.disabled = true;
  const urls = allEpisodes().map(epAudioUrl).filter(Boolean);
  let ok = 0, bad = 0;
  try {
    const cache = await caches.open('ble-content-v1');
    for (const u of urls) {
      try { await cache.add(new Request(u, { cache: 'reload' })); ok++; } catch { bad++; }
      if ((ok + bad) % 5 === 0) btn.textContent = `${ok + bad}/${urls.length}`;
    }
  } catch { /* 无 Cache API */ }
  btn.disabled = false;
  btn.textContent = '开始';
  alert(`缓存完成：成功 ${ok}，失败 ${bad}`);
  updateCacheStat();
};
$('#btn-cache-clear').onclick = async () => {
  const keys = await caches.keys();
  await Promise.all(keys.map((k) => caches.delete(k)));
  updateCacheStat();
  alert('已清除离线缓存');
};
$('#btn-font-sm').onclick = () => setFont(-2);
$('#btn-font-lg').onclick = () => setFont(2);
function setFont(d) {
  const fs = Math.min(24, Math.max(12, LS.get(KEY_FONT, 16) + d));
  LS.set(KEY_FONT, fs);
  document.documentElement.style.setProperty('--fs', fs + 'px');
}
async function updateCacheStat() {
  let stat = '';
  if (navigator.storage?.estimate) {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    stat = `已占用 ${(usage / 1048576).toFixed(1)} MB / 可用 ${(quota / 1048576).toFixed(0)} MB`;
  }
  $('#cache-stat').textContent = stat;
}

/* ---------------- 在线下载 ---------------- */
let dlState = { level: null, series: null };

// 把网络错误翻译成用户能照着做的建议
function hintForNetError(msg) {
  const s = String(msg || '');
  if (!s) return '';
  if (/Failed to connect|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|No route to host/i.test(s)) {
    return '连不上 BBC 服务器。如果你正在用代理，多半是这个 App 的流量没走代理（常见于“分应用代理 / 应用分流”白名单模式，或代理只对浏览器生效）。请把「BBC 轻松英语」加入代理的应用列表，或改用全局 / TUN（VPN）模式，然后点「刷新目录」。';
  }
  if (/UnknownHost|Unable to resolve host|No address associated/i.test(s)) {
    return '域名解析失败。代理的 DNS 没返回可用地址（fake-ip 模式下很常见），建议把代理的 DNS 改成 redir-host / 真实 IP 模式后再试。';
  }
  if (/timed out|timeout|Read timed out/i.test(s)) {
    return '连接超时。检查代理节点是否可用，或换一个网络（Wi-Fi / 移动数据）再试。';
  }
  if (/Cleartext|not permitted/i.test(s)) {
    return '这一集用的是 http 明文链接，被安卓系统拦下了。新版已改成 https 优先并放开明文访问，更新到最新版即可。';
  }
  if (/SSL|Certificate|handshake|CertPathValidator/i.test(s)) {
    return 'TLS 握手失败，可能被代理的证书拦截了。关掉代理的 HTTPS 解密（MITM）后重试。';
  }
  return '';
}

async function runDiag() {
  const box = $('#dl-diag');
  if (!box) return;
  box.innerHTML = '<div class="muted small">正在自检：DNS → 系统代理 → HTTPS…</div>';
  try {
    const r = await window.BBCNet.diag();
    const parts = [];
    parts.push('DNS：' + ((r.dns && r.dns.length) ? r.dns.join(' , ') : (r.dnsError || '解析失败')));
    parts.push('系统代理：' + (r.proxy || '未设置（直连）'));
    if (r.ok) parts.push(`HTTPS：成功 HTTP ${r.status} · ${r.ms}ms`);
    else parts.push('HTTPS：失败 ' + (r.error || '未知') + ` · ${r.ms}ms`);

    const tip = r.ok ? '' : hintForNetError(r.error || r.dnsError);
    box.innerHTML =
      '<div class="summary"><div class="small">' + parts.map((x) => escapeHtml(x)).join('<br>') + '</div>' +
      (tip ? '<div class="muted small" style="margin-top:.45rem">' + escapeHtml(tip) + '</div>' : '') +
      (r.ok ? '<div class="small" style="margin-top:.45rem">网络是通的，点「刷新目录」重新抓一次即可。</div>' : '') +
      '</div>';
  } catch (e) {
    box.innerHTML = '<div class="banner">自检失败：' + escapeHtml(String((e && e.message) || e)) + '</div>';
  }
}

function renderDownload() {
  const body = $('#dl-body');
  const levels = $('#dl-levels');
  const dbox = $('#dl-diag');
  if (dbox) dbox.innerHTML = '';

  // 1) 下载模块没加载出来（安装包里文件缺失、或被系统拦截）
  if (!window.BBCNet) {
    levels.innerHTML = '';
    body.innerHTML =
      '<div class="banner">下载模块没有加载成功。请确认装的是最新版 APK；如果刚覆盖安装过，先把旧版卸载再重装。</div>' +
      '<div class="tool-row"><button class="chip" id="dl-retry">重新检查</button></div>';
    const r1 = $('#dl-retry');
    if (r1) r1.onclick = () => renderDownload();
    return;
  }
  // 2) 模块在，但不是原生 App（浏览器/PWA）
  if (!window.BBCNet.isNative()) {
    levels.innerHTML = '';
    const plat = window.Capacitor?.getPlatform?.() || '无';
    body.innerHTML =
      '<div class="banner">下载要在安卓 App（APK）里用。你现在是用浏览器打开，只能浏览、不能下载音频。</div>' +
      `<div class="muted small">诊断：Capacitor=${!!window.Capacitor} · 平台=${escapeHtml(String(plat))} · 下载模块=是</div>` +
      '<div class="tool-row"><button class="chip" id="dl-retry">重新检查</button></div>';
    const r2 = $('#dl-retry');
    if (r2) r2.onclick = () => renderDownload();
    return;
  }

  const cat = window.BBCNet.getCatalog();
  levels.innerHTML =
    window.BBCNet.ENTRY_URLS.map(
      (e) => `<button class="chip ${dlState.level === e.id ? 'active' : ''}" data-level="${e.id}">${e.label}</button>`
    ).join('') +
    '<button class="chip" id="dl-refresh">刷新目录</button>' +
    '<button class="chip" id="dl-check">网络自检</button>';
  $$('#dl-levels [data-level]').forEach((b) => (b.onclick = () => { dlState.level = b.dataset.level; dlState.series = null; renderDownload(); }));
  $('#dl-check').onclick = () => runDiag();
  $('#dl-refresh').onclick = async () => {
    dlState.level = dlState.level || null;
    body.innerHTML = '<p class="muted">正在刷新目录…</p>';
    await window.BBCNet.fetchCatalog();
    renderDownload();
  };

  if (!dlState.level) { body.innerHTML = '<p class="muted">选择一个栏目开始。</p>'; return; }
  if (!cat) { body.innerHTML = '<p class="muted">正在加载目录…</p>'; window.BBCNet.fetchCatalog().then(renderDownload); return; }

  // 上次成功、这次没抓到：保留旧数据并说明原因
  const stale = cat.stale
    ? '<div class="banner">这次刷新没抓到最新目录，先显示上次成功获取的内容。' +
      (hintForNetError(cat.lastError) ? '<div class="small" style="margin-top:.4rem">' + escapeHtml(hintForNetError(cat.lastError)) + '</div>' : '') +
      '</div>'
    : '';

  const course = cat.courses.find((c) => c.id === dlState.level);
  if (!course) { body.innerHTML = stale + '<p class="muted">该栏目暂无内容。</p>'; return; }
  if (!course.series.length) {
    const hint = hintForNetError(course.error);
    body.innerHTML =
      stale +
      '<div class="banner">没有解析到系列：' + escapeHtml(course.error || '未知错误') + '</div>' +
      (hint ? '<div class="summary"><div class="small">' + escapeHtml(hint) + '</div></div>' : '') +
      '<div class="tool-row"><button class="chip" id="dl-check2">网络自检</button><button class="chip" id="dl-retry2">重试</button></div>';
    const b1 = $('#dl-check2');
    if (b1) b1.onclick = () => runDiag();
    const b2 = $('#dl-retry2');
    if (b2) b2.onclick = async () => {
      body.innerHTML = '<p class="muted">正在重新抓取…</p>';
      await window.BBCNet.fetchCatalog();
      renderDownload();
    };
    return;
  }

  body.innerHTML =
    stale +
    '<div class="grid">' +
    course.series
      .map((s) => `<div class="card" data-series="${encodeURIComponent(s.id)}"><div class="t">${escapeHtml(s.title)}</div><div class="m">${escapeHtml(s.url)}</div></div>`)
      .join('') +
    '</div>';
  $$('#dl-body .card').forEach((c) => (c.onclick = () => openDlSeries(decodeURIComponent(c.dataset.series))));
}

async function openDlSeries(seriesId) {
  const body = $('#dl-body');
  body.innerHTML = '<p class="muted">正在获取单集列表…</p>';
  const cat = window.BBCNet.getCatalog();
  const course = cat.courses.find((c) => c.id === dlState.level);
  const series = course.series.find((s) => s.id === seriesId);
  let data;
  try { data = await window.BBCNet.fetchSeries(series); }
  catch (e) {
    const hint = hintForNetError(e.message || e);
    body.innerHTML =
      `<div class="banner">获取失败：${escapeHtml(e.message || e)}</div>` +
      (hint ? `<div class="summary"><div class="small">${escapeHtml(hint)}</div></div>` : '') +
      '<div class="tool-row"><button class="chip" id="dl-check3">网络自检</button><button class="chip" id="dl-back2">返回</button></div>';
    const b1 = $('#dl-check3');
    if (b1) b1.onclick = () => runDiag();
    const b2 = $('#dl-back2');
    if (b2) b2.onclick = () => renderDownload();
    return;
  }
  dlState.series = data;
  renderDlEpisodes();
}

function renderDlEpisodes() {
  const s = dlState.series;
  const body = $('#dl-body');
  const done = s.episodes.filter((e) => window.BBCNet.getStored(s.id, e.id)).length;
  body.innerHTML =
    `<div class="series-head"><h1>${escapeHtml(s.title)}</h1><p class="muted">共 ${s.episodes.length} 集 · 已下载 ${done} 集</p></div>` +
    '<div class="tool-row"><button class="chip" id="dl-all">下载全部</button><button class="chip" id="dl-back">返回栏目</button></div>' +
    '<div class="list">' +
    s.episodes
      .map((e, i) => {
        const st = window.BBCNet.getStored(s.id, e.id);
        const actions = st
          ? `<button class="chip dl-play" data-i="${i}">播放</button><button class="chip ghost dl-del" data-i="${i}">删除</button>`
          : `<button class="chip dl-btn" data-i="${i}">下载</button>`;
        return `<div class="row" data-i="${i}"><div class="ep"><div class="body"><div class="t">${escapeHtml(e.title || e.id)}</div><div class="m">${escapeHtml(e.date || '')}</div></div></div><div class="dl-actions">${actions}</div></div>`;
      })
      .join('') +
    '</div><div id="dl-progress" class="muted small"></div>';

  $('#dl-all').onclick = () => downloadAll(s);
  $('#dl-back').onclick = () => renderDownload();
  $$('#dl-body .dl-btn').forEach((b) => {
    const i = Number(b.dataset.i);
    b.onclick = (ev) => { ev.stopPropagation(); downloadOne(s, i); };
  });
  $$('#dl-body .dl-play').forEach((b) => {
    const i = Number(b.dataset.i);
    b.onclick = (ev) => { ev.stopPropagation(); openLocalEpisode(window.BBCNet.getStored(s.id, s.episodes[i].id)); };
  });
  $$('#dl-body .dl-del').forEach((b) => {
    const i = Number(b.dataset.i);
    b.onclick = async (ev) => {
      ev.stopPropagation();
      if (!confirm('删除这一集的离线音频？')) return;
      await window.BBCNet.removeFromLibrary(s.id, s.episodes[i].id);
      renderDlEpisodes();
    };
  });
}

async function downloadOne(s, i) {
  const e = s.episodes[i];
  const btn = $(`#dl-body .row[data-i="${i}"] .dl-btn`);
  if (btn) { btn.disabled = true; btn.textContent = '下载中…'; }
  const prog = $('#dl-progress');
  try {
    const r = await window.BBCNet.downloadEpisode(e);
    addLocalEpisode(r.ep);
    renderDlEpisodes();
    const p2 = $('#dl-progress');
    if (p2) {
      const extra = r.ep.localVideoPath ? '（视频 + 音频）' : (r.ep.videoError ? '（只有音频，视频没下来）' : '');
      p2.textContent = `已下载：${r.ep.title}${extra}`;
    }
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = '重试'; }
    const hint = hintForNetError(err.message || err);
    if (prog) prog.textContent = `下载失败：${err.message || err}` + (hint ? `　${hint}` : '');
  }
}

async function downloadAll(s) {
  for (let i = 0; i < s.episodes.length; i++) {
    if (window.BBCNet.getStored(s.id, s.episodes[i].id)) continue;
    await downloadOne(s, i);
  }
}

function openLocalEpisode(st) {
  const c = DATA?.courses?.find((x) => x.id === 'local');
  if (!c) return;
  curSeries = c.series.find((x) => x.id === st.seriesId);
  if (!curSeries) return;
  const i = curSeries.episodes.findIndex((x) => x.id === st.id);
  if (i >= 0) openEpisode(i);
}

/* ---------------- 启动 ---------------- */
renderVocab();
updateCacheStat();
boot();
