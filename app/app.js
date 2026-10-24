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

const player = new Audio();
player.preload = 'auto';

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
const VIEWS = ['home', 'series', 'player', 'vocab', 'settings'];
let stack = [];

function show(view, { push = true, tab = false } = {}) {
  if (tab) stack = [view];
  else if (push && stack[stack.length - 1] !== view) stack.push(view);
  for (const v of VIEWS) $(`#view-${v}`).hidden = v !== view;
  $('#btn-back').hidden = !(stack.length > 1 && view !== 'home' && view !== 'vocab' && view !== 'settings');
  $('#topbar').style.display = view === 'home' ? '' : '';
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
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
  renderHome();
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
         <div>音频和文稿的版权归 BBC，不会跟着代码一起发布，需要在你自己的电脑上抓取后再打包进来。</div>
         <div class="muted small" style="margin-top:.5rem">最快的办法：电脑上跑 <b>npm start</b>，手机连同一个 WiFi 打开提示的地址。</div>
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
      const has = !!e.audioFile;
      const pct = p && p.dur ? Math.min(100, Math.round((p.pos / p.dur) * 100)) : 0;
      return `<div class="row" data-i="${i}">
        <div class="ep">
          <div class="n">${i + 1}</div>
          <div class="body">
            <div class="t">${escapeHtml(e.title || e.id || 'Untitled')}</div>
            <div class="m">${escapeHtml(e.date || '')}${e.duration ? ` · ${fmtTime(e.duration)}` : ''}${pct ? ` · 已听 ${pct}%` : ''}</div>
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
  $('#pl-meta').textContent = [curEp.date, curEp.duration ? fmtTime(curEp.duration) : '', curEp.audioBytes ? `${(curEp.audioBytes / 1048576).toFixed(1)}MB` : ''].filter(Boolean).join(' · ');
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
    await loadAudio(curEp);
  } catch (err) {
    $('#pl-errmsg').hidden = false;
    $('#pl-errmsg').textContent = `音频加载失败：${err.message}。若显示“在线”，说明这台设备连不上 BBC，请在能联网的环境重新运行 npm run download。`;
  }
}

async function loadAudio(e) {
  const url = epAudioUrl(e);
  if (!url) throw new Error('本集没有音频地址');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  if (audioObjUrl) URL.revokeObjectURL(audioObjUrl);
  audioObjUrl = URL.createObjectURL(blob);
  player.src = audioObjUrl;
  player.load();

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

player.addEventListener('timeupdate', () => {
  if (!player.duration || seeking) return;
  seek.value = Math.round((player.currentTime / player.duration) * 1000);
  $('#pl-cur').textContent = fmtTime(player.currentTime);
  if (loopB !== null && player.currentTime >= loopB && loopA !== null) player.currentTime = loopA;
  if (follow) autoFollow();
  saveProgress();
});
player.addEventListener('loadedmetadata', () => { $('#pl-dur').textContent = fmtTime(player.duration); });
player.addEventListener('play', () => ($('#btn-play').textContent = '❙❙'));
player.addEventListener('pause', () => { $('#btn-play').textContent = '▶'; saveProgress(); });
player.addEventListener('ended', () => { saveProgress(true); autoNext(); });

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

/* ---------------- 启动 ---------------- */
renderVocab();
updateCacheStat();
boot();
