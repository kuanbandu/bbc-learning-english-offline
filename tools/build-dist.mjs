import fs from 'node:fs';
import path from 'node:path';
import esbuild from 'esbuild';
import { writeIcons } from './make-icons.mjs';

const ROOT = process.cwd();
const APP = path.join(ROOT, 'app');
const CONTENT = path.join(ROOT, 'content');
const DIST = path.join(ROOT, 'dist');

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

copyDir(APP, DIST);
writeIcons(DIST);

// 把解析模块（纯 JS，无 Node 依赖）复制到 dist/lib，供打包时解析相对路径
const LIB = path.join(ROOT, 'src', 'lib');
fs.mkdirSync(path.join(DIST, 'lib'), { recursive: true });
for (const f of ['html.mjs', 'audio.mjs', 'parse.mjs']) {
  const src = path.join(LIB, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(DIST, 'lib', f));
}

// 关键：把 net.js（ES module）连同解析模块打成【普通 IIFE 脚本】。
// 原因：Capacitor 的 Android WebView 加载 <script type="module"> 不稳定，
// 曾导致 window.BBCNet 一直不存在、下载页始终提示“需要 App”。
// 打成普通脚本后，它在 app.js 之前同步执行，window.BBCNet 必定就绪。
await esbuild.build({
  entryPoints: [path.join(DIST, 'net.js')],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: true,
  outfile: path.join(DIST, 'net.bundle.js'),
  logLevel: 'silent',
});
// 打包后已内联全部依赖，删除仅用于打包的中间文件，避免 App 再去加载它们
fs.rmSync(path.join(DIST, 'net.js'), { force: true });
fs.rmSync(path.join(DIST, 'lib'), { recursive: true, force: true });

if (fs.existsSync(path.join(CONTENT, 'index.json'))) {
  copyDir(CONTENT, path.join(DIST, 'content'));
  const idx = JSON.parse(fs.readFileSync(path.join(CONTENT, 'index.json'), 'utf8'));
  const eps = (idx.courses || []).flatMap((c) => (c.series || []).flatMap((s) => s.episodes || []));
  const withAudio = eps.filter((e) => e.audioFile).length;
  let bytes = 0;
  for (const e of eps) {
    if (!e.audioFile) continue;
    const p = path.join(DIST, 'content', e.audioFile);
    if (fs.existsSync(p)) bytes += fs.statSync(p).size;
  }
  console.log(`已打包：${eps.length} 集，其中 ${withAudio} 集带离线音频，共 ${(bytes / 1048576).toFixed(1)} MB`);
} else {
  fs.mkdirSync(path.join(DIST, 'content'), { recursive: true });
  fs.writeFileSync(path.join(DIST, 'content', 'index.json'), JSON.stringify({ courses: [] }, null, 2));
  console.log('提示：还没有 content/index.json（未抓取）。已生成空包，App 会提示先运行 npm run build。');
}

console.log(`离线包已生成: ${DIST}`);
console.log('下一步: npm run serve  然后用手机打开提示的地址');
