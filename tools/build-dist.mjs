import fs from 'node:fs';
import path from 'node:path';
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
