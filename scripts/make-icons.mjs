/**
 * Generates the placeholder extension icons (icons/icon{16,32,48,128}.png).
 *
 * Placeholder art on purpose: a rounded dark square with a white ring — "zero".
 * Written by hand (zlib + a minimal PNG encoder) so the repo needs no image
 * dependency and `bun run icons` regenerates them deterministically. The
 * pixels are always identical, but the deflate bytes depend on the runtime's
 * zlib — regenerating under a different Bun/zlib version may rewrite the
 * files without changing the image.
 *
 * Usage: bun scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'icons');
const SIZES = [16, 32, 48, 128];

/** neutral-900-ish plate + near-white mark; matches the shadcn neutral palette. */
const PLATE = [23, 23, 23];
const MARK = [250, 250, 250];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Encodes RGBA pixel data (size × size) as a PNG buffer. */
function encodePng(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Coverage of the rounded plate at a unit-square point, 0..1 (supersampled by caller). */
function insidePlate(x, y) {
  const r = 0.22;
  const dx = Math.max(r - x, x - (1 - r), 0);
  const dy = Math.max(r - y, y - (1 - r), 0);
  return dx * dx + dy * dy <= r * r;
}

/** The "zero" ring: an annulus centred on the plate. */
function insideRing(x, y) {
  const d = Math.hypot(x - 0.5, y - 0.5);
  return d <= 0.3 && d >= 0.175;
}

function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const SS = 4; // supersampling factor per axis
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let plate = 0;
      let mark = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          if (insidePlate(x, y)) plate += 1;
          if (insideRing(x, y)) mark += 1;
        }
      }
      const total = SS * SS;
      const alpha = plate / total;
      const markMix = Math.min(mark / total, alpha);
      const off = (py * size + px) * 4;
      for (let c = 0; c < 3; c += 1) {
        rgba[off + c] = Math.round(PLATE[c] * (1 - markMix) + MARK[c] * markMix);
      }
      rgba[off + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(size, rgba);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = join(OUT_DIR, `icon${size}.png`);
  writeFileSync(file, renderIcon(size));
  console.log(`wrote ${file}`);
}
