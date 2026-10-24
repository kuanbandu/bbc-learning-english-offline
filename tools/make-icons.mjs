// 零依赖生成 PNG 图标（避免为几张图引入图形库）
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const R = (r, g, b, a = 255) => [r, g, b, a];
  const BG = R(0xb8, 0x00, 0x00);
  const FG = R(0xff, 0xff, 0xff);
  const radius = size * 0.19;
  const inRounded = (x, y) => {
    const cx = Math.min(Math.max(x, radius), size - 1 - radius);
    const cy = Math.min(Math.max(y, radius), size - 1 - radius);
    const dx = x - cx, dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  };
  // 三根白条（相对尺寸与 icon.svg 一致）
  const bars = [
    { x0: 0.1875, x1: 0.8125, y0: 0.234, y1: 0.324 },
    { x0: 0.1875, x1: 0.656, y0: 0.445, y1: 0.535 },
    { x0: 0.1875, x1: 0.539, y0: 0.656, y1: 0.746 },
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (!inRounded(x, y)) continue; // 圆角外保持透明
      let c = BG;
      for (const b of bars) {
        if (x >= b.x0 * size && x <= b.x1 * size && y >= b.y0 * size && y <= b.y1 * size) { c = FG; break; }
      }
      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = c[3];
    }
  }
  return encodePng(size, size, px);
}

export function writeIcons(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const size of [192, 512]) {
    fs.writeFileSync(path.join(dir, `icon-${size}.png`), render(size));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] || 'dist';
  writeIcons(dir);
  console.log(`图标已生成: ${dir}/icon-192.png, ${dir}/icon-512.png`);
}
