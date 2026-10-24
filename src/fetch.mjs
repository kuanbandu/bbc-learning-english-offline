import { spawnSync } from 'node:child_process';
import { slugify } from './lib/html.mjs';
import { createHttp } from './lib/http.mjs';
import { parseCoursePage, parseEpisodePage, parseSeriesPage } from './lib/parse.mjs';
import {
  audioAbsPath, audioRelPath, downloadFile, dumpHtml, ensureDir,
  fmtBytes, loadConfig, loadIndex, loadState, saveIndex, saveState,
} from './lib/store.mjs';

const cfg = loadConfig();

// NODE_USE_ENV_PROXY 只在进程启动前生效，运行时赋值无效。
// 因此配置了 proxy 时，用带代理的环境变量重启一次自身。
if (cfg.proxy && process.env.BLE_PROXY_APPLIED !== '1') {
  const r = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: 'inherit',
    env: {
      ...process.env,
      BLE_PROXY_APPLIED: '1',
      NODE_USE_ENV_PROXY: '1',
      HTTPS_PROXY: cfg.proxy,
      HTTP_PROXY: cfg.proxy,
      https_proxy: cfg.proxy,
      http_proxy: cfg.proxy,
    },
  });
  process.exit(r.status ?? 1);
}

const http = createHttp(cfg);

/* ---------------- 参数 ---------------- */

const argv = process.argv.slice(2);
const cmd = argv[0] || 'build';
const positional = argv.slice(1).filter((a) => !a.startsWith('--'));
const flags = Object.fromEntries(
  argv.filter((a) => a.startsWith('--')).map((a) => {
    const [k, ...v] = a.slice(2).split('=');
    return [k, v.length ? v.join('=') : true];
  })
);
const num = (k, d) => (flags[k] !== undefined ? Number(flags[k]) : d);
const list = (k) => (flags[k] ? String(flags[k]).split(',').map((s) => s.trim()).filter(Boolean) : null);

const log = (...a) => console.log(...a);
const bar = () => log('-'.repeat(60));
// og:title 常带 "BBC Learning English - " 前缀，界面上太啰嗦
const stripBbc = (s) => String(s || '').replace(/^BBC Learning English\s*[-–—|:]\s*/i, '').trim();
// 链接没有文字时，把 slug 变成可读标题：6-minute-english_2026 → 6 Minute English
const prettySlug = (s = '') =>
  stripBbc(String(s).replace(/[_-]20\d{2}$/, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim())
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());

// RSS 的标题形如 "BBC Learning English - 6 Minute English / 真正的问题"
function cleanEpTitle(t, seriesTitle = '') {
  let s = stripBbc(t).replace(/^(?:course|feature|programme)\s*:\s*/i, '');
  if (seriesTitle) {
    const esc = seriesTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp(`^${esc}\\s*[\\/\\-–—:]\\s*`, 'i'), '');
  }
  return s.trim() || stripBbc(t);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = await fn(items[idx], idx);
      } catch (err) {
        out[idx] = { __error: err.message };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

/* ---------------- probe：单页诊断 ---------------- */

async function probe() {
  const url = positional[0] || cfg.startUrls[0];
  bar();
  log(`PROBE  ${url}`);
  bar();
  const { text: html, url: realUrl } = await http.getPage(url, { label: 'probe' });
  if (realUrl !== url) log(`（已重定向到 ${realUrl}）`);
  const dumpPath = dumpHtml(`probe-${slugify(new URL(url).pathname)}.html`, html);
  log(`原始 HTML 已保存: ${dumpPath}  (${fmtBytes(html.length)})`);
  log('');

  const course = parseCoursePage(html, realUrl);
  log(`标题: ${course.title}`);
  log(`RSS  : ${course.rss.length ? course.rss.join('\n       ') : '(未发现)'}`);
  log('');
  log(`节目(series) ${course.series.length} 个:`);
  for (const s of course.series.slice(0, 40)) {
    log(`  [${s.section || '-'}] ${s.text || '(无标题)'}  ->  ${s.url}`);
  }
  if (course.episodes.length) {
    log('');
    log(`单集(episode) ${course.episodes.length} 个（前 10）:`);
    for (const e of course.episodes.slice(0, 10)) log(`  ${e.text}  ->  ${e.url}`);
  }

  const epUrl = positional[1] || course.episodes[0]?.url;
  if (epUrl) {
    bar();
    log(`PROBE 单集  ${epUrl}`);
    bar();
    const { text: eh, url: realEpUrl } = await http.getPage(epUrl, { label: 'probe-episode' });
    dumpHtml(`probe-episode-${slugify(new URL(epUrl).pathname)}.html`, eh);
    const ep = await parseEpisodePage(http, eh, realEpUrl);
    log(`标题       : ${ep.title}`);
    log(`日期       : ${ep.date || '(无)'}`);
    log(`音频       : ${ep.audioUrl || '(未找到)'}`);
    log(`音频来源   : ${ep.audioHow || '-'}`);
    log(`文稿文件   : ${ep.transcriptFile || '(无)'}`);
    log(`文稿句数   : ${ep.transcript.length}`);
    if (ep.transcript.length) log(`文稿前 3 句 : ${ep.transcript.slice(0, 3).join(' | ').slice(0, 300)}`);
  }
  bar();
  log('诊断完成。把上面的输出（或 .cache/dump 里的 HTML）发给开发者即可调整解析规则。');
}

/* ---------------- courses：解析目录页 ---------------- */

async function courses() {
  const prev = loadIndex();
  const prevSeries = new Map();
  for (const c of prev?.courses || []) {
    for (const s of c.series || []) prevSeries.set(String(s.id), s);
  }

  const fresh = [];
  let lastErr;
  for (const url of cfg.startUrls) {
    try {
      const { text: html, url: realUrl } = await http.getPage(url, { label: 'courses' });
      const parsed = parseCoursePage(html, realUrl);

      const picked = parsed.series.length ? parsed.series : parsed.episodes.length ? groupEpisodes(parsed.episodes) : [];
      if (!picked.length) {
        log(`[!] ${url} 未解析出任何节目，已保存 HTML 供检查: ${dumpHtml('course-empty.html', html)}`);
        continue;
      }

      const cid = slugify(new URL(url).pathname) || 'home';
      // BBC 各难度页的 og:title 一律是 "Easy Courses"，只能按 URL 判断真实难度
      const seg = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
      const lv = seg.match(/(easy|medium|hard)[_-]course/i);
      const LV = { easy: '入门', medium: '中级', hard: '高级' };
      fresh.push({
        id: cid,
        title: lv ? `${LV[lv[1].toLowerCase()]}课程` : stripBbc(parsed.title) || prettySlug(cid),
        url,
        rss: parsed.rss,
        series: picked.map((s) => {
          const id = slugify(s.seriesSlug || s.text || s.url);
          const old = prevSeries.get(id);
          let stitle = stripBbc(s.text);
          // 链接文字为空或本身就是 slug（不含空格）时，转成可读标题
          if (!stitle || !/\s/.test(stitle)) {
            stitle = prettySlug(s.seriesSlug || s.url.split('/').pop() || stitle || id);
          }
          return {
            id,
            title: stitle,
            level: s.section || '',
            url: s.url,
            rss: old?.rss ?? null,
            episodes: old?.episodes ?? [], // 保留已抓过的单集与音频记录
          };
        }),
      });
      bar();
      log(`来源 ${url}`);
      for (const s of fresh[fresh.length - 1].series) log(`  · ${s.title}  ${s.url}`);
    } catch (err) {
      lastErr = err;
      log(`[x] ${url} 抓取失败: ${err.message}`);
    }
  }

  if (!fresh.length) throw lastErr || new Error('所有 startUrls 都失败');

  // 旧目录在前（保住已下载内容），新解析的目录追加；同一节目只保留第一次出现
  const byCourse = new Map();
  for (const c of [...(prev?.courses || []), ...fresh]) if (!byCourse.has(c.id)) byCourse.set(c.id, c);
  const seenSeries = new Set();
  const usedTitles = new Set();
  const merged = [];
  for (const c of byCourse.values()) {
    const series = [];
    for (const s of c.series || []) {
      if (seenSeries.has(String(s.id))) continue;
      seenSeries.add(String(s.id));
      series.push(s);
    }
    if (!series.length) continue;
    // 多个目录页标题可能都是 "Easy Courses"，加来源后缀区分
    let title = c.title || c.id;
    if (usedTitles.has(title)) title = `${title}（${prettySlug(c.id)}）`;
    usedTitles.add(title);
    merged.push({ ...c, title, series });
  }

  const index = {
    generatedAt: new Date().toISOString(),
    lang: cfg.lang,
    source: cfg.startUrls.join(' , '),
    courses: merged,
  };
  saveIndex(index);
  bar();
  log(`课程目录已写入 content/index.json`);
  for (const c of merged) {
    const n = c.series.reduce((a, s) => a + (s.episodes?.length || 0), 0);
    log(`  · ${c.title}：${c.series.length} 个节目，已抓 ${n} 集`);
  }
  log('');
  log(`下一步: npm run crawl`);
}

function groupEpisodes(eps) {
  const map = new Map();
  for (const e of eps) {
    const key = e.seriesSlug;
    if (!map.has(key)) map.set(key, { seriesSlug: key, text: key.replace(/[-_]+/g, ' '), url: e.url.split('/').slice(0, -1).join('/'), section: e.section });
  }
  return [...map.values()];
}

/* ---------------- crawl：抓每集的音频与文稿 ---------------- */

async function crawl() {
  const index = loadIndex();
  if (!index) {
    log('未找到 content/index.json，先执行 courses...');
    await courses();
    return crawl();
  }

  const only = list('series');
  const limit = num('limit', cfg.maxEpisodesPerSeries || 0);

  for (const course of index.courses) {
    for (const series of course.series) {
      if (only && !only.includes(series.id)) continue;
      log('');
      bar();
      log(`节目: ${series.title}  <${series.url}>`);
      try {
        const { text: html, url: realUrl } = await http.getPage(series.url, { label: 'series' });
        series.url = realUrl;
        const parsed = await parseSeriesPage(http, html, realUrl);
        series.rss = parsed.rss || series.rss;
        // 目录页给的标题更简短好读，只有缺失时才用 og:title 兜底
        series.title = stripBbc(series.title || parsed.title);

        let eps = parsed.episodes;
        if (limit > 0) eps = eps.slice(0, limit);
        log(`  发现 ${parsed.episodes.length} 集${limit > 0 ? `，本次取 ${eps.length} 集` : ''}  来源: ${eps[0]?.source || 'html'}${series.rss ? `  RSS: ${series.rss}` : ''}`);

        const needDetail = eps.filter((e) => !e.audioUrl || !e.transcript?.length);
        if (needDetail.length) {
          log(`  需要抓取详情页补全音频/文稿: ${needDetail.length} 集`);
          await mapLimit(needDetail, cfg.concurrency || 3, async (e) => {
            if (!e.url) return;
            const { text: eh, url: realEpUrl } = await http.getPage(e.url, { label: 'episode' });
            const d = await parseEpisodePage(http, eh, realEpUrl);
            e.title = cleanEpTitle(e.title || d.title, series.title);
            e.date = e.date || d.date;
            e.audioUrl = e.audioUrl || d.audioUrl;
            e.audioHow = d.audioHow;
            e.transcript = e.transcript?.length ? e.transcript : d.transcript;
            e.transcriptFile = d.transcriptFile;
          });
        }

        // 重跑 crawl 时保留已有成果（音频文件、大小、旧文稿），避免重复下载
        const prev = new Map((series.episodes || []).map((x) => [String(x.id), x]));
        series.episodes = eps.map((x) => {
          const old = prev.get(String(x.id));
          if (!old) return x;
          const merged = { ...old, ...x };
          if (!(merged.transcript || []).length && (old.transcript || []).length) merged.transcript = old.transcript;
          if (!merged.audioFile && old.audioFile) merged.audioFile = old.audioFile;
          if (!merged.audioBytes && old.audioBytes) merged.audioBytes = old.audioBytes;
          return merged;
        });
        const withAudio = eps.filter((e) => e.audioUrl).length;
        const withText = eps.filter((e) => e.transcript?.length).length;
        log(`  完成: 音频 ${withAudio}/${eps.length}，文稿 ${withText}/${eps.length}`);
        saveIndex(index);
      } catch (err) {
        log(`  [x] 失败: ${err.message}`);
        saveIndex(index);
      }
    }
  }

  saveIndex(index);
  const total = index.courses.flatMap((c) => c.series).reduce((n, s) => n + s.episodes.length, 0);
  const okAudio = index.courses.flatMap((c) => c.series).flatMap((s) => s.episodes).filter((e) => e.audioUrl).length;
  bar();
  log(`crawl 完成：共 ${total} 集，其中 ${okAudio} 集拿到音频直链。`);
  log('下一步: npm run download');
}

/* ---------------- download：下载音频 ---------------- */

async function download() {
  const index = loadIndex();
  if (!index) throw new Error('请先运行 npm run courses && npm run crawl');
  const state = loadState();
  ensureDir('content');

  const episodes = index.courses.flatMap((c) =>
    c.series.flatMap((s) => s.episodes.map((e) => ({ series: s, ep: e })))
  );

  const todo = episodes.filter((x) => x.ep.audioUrl);
  const knownBytes = episodes.reduce((n, x) => n + (x.ep.audioBytes || 0), 0);
  log(`准备下载 ${todo.length} 个音频文件...`);
  log(`单集约 10-15MB，走代理通常 100-200KB/s，请耐心等待（Ctrl+C 中断后重跑会自动续传）`);
  if (knownBytes) log(`已下载部分合计 ${fmtBytes(knownBytes)}`);

  let done = 0, skipped = 0, failed = 0, bytes = 0;
  await mapLimit(todo, cfg.concurrency || 3, async ({ series, ep }) => {
    const rel = audioRelPath(series.id, ep.id || ep.title, ep.audioUrl);
    const dest = audioAbsPath(rel);
    const res = await downloadFile(http, ep.audioUrl, dest, {
      retries: cfg.audioMaxRetries || 3,
      timeoutMs: cfg.audioTimeoutMs || 600000,
    });
    if (res.ok) {
      ep.audioFile = rel;
      ep.audioBytes = res.bytes;
      bytes += res.bytes;
      if (res.skipped) skipped++; else done++;
      delete state.failed[ep.audioUrl];
    } else {
      failed++;
      state.failed[ep.audioUrl] = res.error;
      log(`  [x] ${ep.title || ep.id}: ${res.error}`);
    }
    if ((done + skipped + failed) % 10 === 0) {
      log(`  进度 ${done + skipped + failed}/${todo.length}  已下载 ${fmtBytes(bytes)}`);
      saveIndex(index);
      saveState(state);
    }
  });

  saveIndex(index);
  saveState(state);
  bar();
  log(`下载完成：新增 ${done}，跳过(已有) ${skipped}，失败 ${failed}，累计 ${fmtBytes(bytes)}`);
  if (failed) log(`失败清单见 content/state.json，重跑 npm run download 会重试`);
  log('下一步: npm run dist && npm run serve');
}

/* ---------------- 入口 ---------------- */

const commands = { probe, courses, crawl, download };

(async () => {
  if (cmd === 'build') {
    await courses();
    await crawl();
    await download();
    return;
  }
  const fn = commands[cmd];
  if (!fn) {
    log(`用法: node src/fetch.mjs <${Object.keys(commands).join('|')}|build> [url] [--series=slug] [--limit=N]`);
    process.exit(1);
  }
  await fn();
})().catch((err) => {
  console.error(`\n[致命错误] ${err.message}`);
  console.error('提示：国内网络通常无法直连 bbc.co.uk。若你有代理，在 config.json 的 proxy 字段填入地址后重试。');
  process.exit(1);
});
