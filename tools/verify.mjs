import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 自检：不用打开浏览器，就能确认"抓到的内容是否真的可用"。
 * 检查项：目录数据 → 单集字段 → 音频文件是否真实可播 → 离线包是否最新 → 失败/半截文件
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT = path.join(ROOT, 'content');
const DIST = path.join(ROOT, 'dist');
const INDEX = path.join(CONTENT, 'index.json');
const STATE = path.join(CONTENT, 'state.json');
const AUDIO = path.join(CONTENT, 'audio');

const problems = [];
const warns = [];

const ok = (s) => `  [OK] ${s}`;
const bad = (s) => { problems.push(s); return `  [!!] ${s}`; };
const warn = (s) => { warns.push(s); return `  [~ ] ${s}`; };

function bar() { console.log('-'.repeat(64)); }
function head(t) { console.log(''); bar(); console.log(t); bar(); }

/** MP3 文件头校验：ID3 标签 或 帧同步字 0xFFEx */
function isMp3(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    if (buf.slice(0, 3).toString('latin1') === 'ID3') return true;
    return buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
  } catch {
    return false;
  }
}

function collectFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectFiles(p, out);
    else out.push(p);
  }
  return out;
}

/* ---------------- 0. 环境 ---------------- */
head('0. 环境');
let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
} catch {
  console.log(bad('config.json 读不到或格式错误'));
}
console.log(`  Node ${process.version}`);
console.log(`  代理 ${cfg.proxy || '（未配置，直连）'}`);
if (!cfg.proxy) console.log(warn('国内直连 bbc.co.uk 通常不通，需要填 config.json 的 proxy'));
const cacheDir = path.join(ROOT, '.cache', 'http');
if (fs.existsSync(cacheDir)) {
  const cf = collectFiles(cacheDir);
  console.log(`  HTML 缓存 ${cf.length} 个文件（删掉可强制重新抓取：npm run clear-cache）`);
}

/* ---------------- 1. 数据文件 ---------------- */
head('1. 抓取数据');

if (!fs.existsSync(INDEX)) {
  console.log(bad('content/index.json 不存在 —— 先跑 npm run courses && npm run crawl'));
  report();
}
const index = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
const courses = index.courses || [];
if (!courses.length) console.log(bad('index.json 里没有任何课程'));

const allSeries = courses.flatMap((c) => (c.series || []).map((s) => ({ course: c, s })));
const seriesWithEps = allSeries.filter((x) => (x.s.episodes || []).length);
const allEps = allSeries.flatMap((x) => (x.s.episodes || []).map((e) => ({ series: x.s, e })));

console.log(`  课程目录 ${courses.length} 个 / 节目 ${allSeries.length} 个 / 已抓单集 ${allEps.length} 集`);
for (const c of courses) {
  const n = (c.series || []).reduce((a, s) => a + (s.episodes || []).length, 0);
  console.log(`    · ${c.title}：${(c.series || []).length} 节目 / ${n} 集`);
}
if (!allEps.length) console.log(bad('没有抓到任何单集'));

/* ---------------- 2. 单集字段完整性 ---------------- */
head('2. 单集字段');

const noTitle = allEps.filter((x) => !x.e.title);
const noAudio = allEps.filter((x) => !x.e.audioUrl);
const noTrans = allEps.filter((x) => !(x.e.transcript || []).length);
const withAudio = allEps.filter((x) => x.e.audioUrl);
const withTrans = allEps.filter((x) => (x.e.transcript || []).length);

console.log(`  有音频直链 ${withAudio.length} / ${allEps.length}`);
console.log(`  有文稿     ${withTrans.length} / ${allEps.length}`);
if (noTitle.length) console.log(warn(`${noTitle.length} 集缺标题`));
if (noTrans.length) {
  console.log(warn(`${noTrans.length} 集没抓到文稿（视频类节目 BBC 可能真的没提供）`));
  const bySeries = new Map();
  for (const { series } of noTrans) bySeries.set(series.title, (bySeries.get(series.title) || 0) + 1);
  for (const [k, v] of [...bySeries].slice(0, 8)) console.log(`        ${k}: ${v} 集`);
}

// 节目级概览：哪些节目值得抓（有音频）、哪些只有文字
head('3. 各节目可用性');
for (const { s } of seriesWithEps) {
  const eps = s.episodes || [];
  const a = eps.filter((e) => e.audioUrl).length;
  const t = eps.filter((e) => (e.transcript || []).length).length;
  const flag =
    a === eps.length && t === eps.length ? '完整（音频+文稿）'
    : a === eps.length ? '有音频，缺文稿'
    : a > 0 ? '部分有音频'
    : t > 0 ? '仅文字（BBC 没给音频）'
    : '空（换一集/换节目）';
  console.log(`    ${s.title}  (${eps.length} 集)  音频 ${a} · 文稿 ${t}  → ${flag}`);
}

/* ---------------- 4. 音频文件真实性 ---------------- */
head('4. 音频文件');
const files = collectFiles(AUDIO);
const parts = files.filter((f) => f.endsWith('.part'));
const audioFiles = files.filter((f) => !f.endsWith('.part'));
let totalBytes = 0;
let badHeader = 0;
for (const f of audioFiles) {
  const sz = fs.statSync(f).size;
  totalBytes += sz;
  if (sz < 1024) { console.log(bad(`音频过小 ${path.relative(ROOT, f)} (${sz}B)`)); continue; }
  if (!isMp3(f)) { badHeader++; console.log(bad(`不是有效 MP3 ${path.relative(ROOT, f)}`)); }
}
console.log(`  磁盘音频 ${audioFiles.length} 个，合计 ${(totalBytes / 1048576).toFixed(1)} MB`);
if (audioFiles.length) {
  const avg = totalBytes / audioFiles.length / 1048576;
  console.log(`  平均单集 ${avg.toFixed(1)} MB`);
  if (avg < 0.5) console.log(warn('平均体积偏小，可能抓到的不是完整音频'));
}
if (parts.length) console.log(warn(`${parts.length} 个未下完的 .part 文件（重跑 npm run download 会续传）`));

// index 里声明已下载、但磁盘上没有的
const declared = allEps.filter((x) => x.e.audioFile);
const missing = declared.filter((x) => !fs.existsSync(path.join(CONTENT, x.e.audioFile)));
console.log(`  index 标记已下载 ${declared.length} 集，磁盘缺失 ${missing.length} 集`);
for (const { e } of missing.slice(0, 5)) console.log(bad(`缺失音频 ${e.audioFile}`));
const pending = withAudio.filter((x) => !x.e.audioFile);
if (pending.length) console.log(`  待下载 ${pending.length} 集（跑 npm run download）`);

/* ---------------- 5. 失败记录 ---------------- */
head('5. 失败记录');
if (fs.existsSync(STATE)) {
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  const failed = Object.entries(st.failed || {});
  console.log(`  state.json：失败记录 ${failed.length} 条（下载成功是记在 index.json 的 audioFile 字段）`);
  for (const [k, v] of failed.slice(0, 8)) console.log(warn(`${k} → ${v}`));
  if (failed.length) console.log('  重跑 npm run download 会重试这些');
} else {
  console.log('  无 state.json（还没下载过）');
}

/* ---------------- 6. 离线包 ---------------- */
head('6. 离线包 dist');
if (!fs.existsSync(DIST)) {
  console.log(bad('dist/ 不存在 —— 跑 npm run dist'));
} else {
  const distIndex = path.join(DIST, 'content', 'index.json');
  if (!fs.existsSync(distIndex)) {
    console.log(bad('dist/content/index.json 缺失'));
  } else {
    const di = JSON.parse(fs.readFileSync(distIndex, 'utf8'));
    const dn = (di.courses || []).flatMap((c) => (c.series || []).flatMap((s) => s.episodes || [])).length;
    const stale = dn !== allEps.length;
    console.log(`  dist 内含 ${dn} 集（content 内 ${allEps.length} 集）`);
    if (stale) console.log(warn('dist 已过期，重新打包：npm run dist'));
  }
  for (const f of ['index.html', 'app.js', 'style.css', 'sw.js', 'manifest.webmanifest']) {
    if (!fs.existsSync(path.join(DIST, f))) console.log(bad(`dist/${f} 缺失`));
  }
  const icons = collectFiles(DIST).filter((f) => /icon-\d+\.png$/.test(f));
  console.log(`  图标 ${icons.length} 个${icons.length ? '' : '（缺失！）'}`);
  if (!icons.length) console.log(bad('缺少 PNG 图标，PWA 无法安装到主屏幕'));
}

/* ---------------- 结论 ---------------- */
function report() {
  bar();
  if (!problems.length && !warns.length) {
    console.log('结论：全部通过 ✅');
  } else {
    if (problems.length) console.log(`结论：${problems.length} 个问题需要修 ❌`);
    if (warns.length) console.log(`      ${warns.length} 个提示（不阻塞使用）`);
  }
  bar();
  process.exit(problems.length ? 1 : 0);
}
report();
