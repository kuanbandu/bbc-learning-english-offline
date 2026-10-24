import fs from 'node:fs';
import path from 'node:path';
import { slugify } from './html.mjs';

export const ROOT = process.cwd();
export const CONTENT_DIR = path.join(ROOT, 'content');
export const AUDIO_DIR = path.join(CONTENT_DIR, 'audio');
export const INDEX_FILE = path.join(CONTENT_DIR, 'index.json');
export const STATE_FILE = path.join(CONTENT_DIR, 'state.json');
export const DUMP_DIR = path.join(ROOT, '.cache', 'dump');

export function loadConfig() {
  const raw = fs
    .readFileSync(path.join(ROOT, 'config.json'), 'utf8')
    .replace(/^﻿/, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,(\s*[}\]])/g, '$1'); // 容忍手改配置时留下的尾随逗号
  return JSON.parse(raw);
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

export const loadIndex = () => readJson(INDEX_FILE, null);
export const saveIndex = (d) => writeJson(INDEX_FILE, d);
export const loadState = () => readJson(STATE_FILE, { downloaded: {}, failed: {} });
export const saveState = (d) => writeJson(STATE_FILE, d);

export function audioRelPath(seriesId, epId, audioUrl) {
  const ext = (() => {
    const m = (audioUrl || '').split('?')[0].match(/\.(mp3|m4a|aac|ogg|oga|opus)$/i);
    return m ? m[1].toLowerCase() : 'mp3';
  })();
  return `audio/${slugify(seriesId)}/${slugify(epId)}.${ext}`;
}

export function audioAbsPath(rel) {
  return path.join(CONTENT_DIR, rel);
}

export async function downloadFile(http, url, dest, { retries = 3, minBytes = 1024, timeoutMs } = {}) {
  if (fs.existsSync(dest) && fs.statSync(dest).size >= minBytes) {
    return { ok: true, bytes: fs.statSync(dest).size, skipped: true };
  }
  ensureDir(path.dirname(dest));
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await http.downloadTo(url, dest, { timeoutMs, label: 'audio' });
      if (r.bytes < minBytes) throw new Error(`文件过小 ${r.bytes}B`);
      return { ok: true, bytes: r.bytes };
    } catch (err) {
      lastErr = err;
      if (i < retries) await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  return { ok: false, error: lastErr?.message || 'unknown' };
}

export function dumpHtml(name, html) {
  ensureDir(DUMP_DIR);
  const p = path.join(DUMP_DIR, name);
  fs.writeFileSync(p, html, 'utf8');
  return p;
}

export function fmtBytes(n = 0) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
