#!/usr/bin/env node
/**
 * Generates the PWA icons (192 + 512) with no external dependencies.
 * Blue gradient tile + white download arrow, 4x supersampled for smooth edges.
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

/* ------------------------------------------------------------------- PNG */

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
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------------------------------------------------------- shapes */

const inRect = (x, y, x0, y0, x1, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1;

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (!inRect(x, y, x0, y0, x1, y1)) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function inTriangle(px, py, x1, y1, x2, y2, x3, y3) {
  const d1 = (px - x2) * (y1 - y2) - (x1 - x2) * (py - y2);
  const d2 = (px - x3) * (y2 - y3) - (x2 - x3) * (py - y3);
  const d3 = (px - x1) * (y3 - y1) - (x3 - x1) * (py - y1);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

function lerp(a, b, t) { return a + (b - a) * t; }

/* ------------------------------------------------------------------ draw */

function render(size) {
  const S = 4;                       // supersample
  const W = size * S;
  const px = Buffer.alloc(W * W * 4);

  // palette — fox amber
  const topR = 0xff, topG = 0xa9, topB = 0x4d;
  const botR = 0xd9, botG = 0x54, botB = 0x08;

  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / (W - 1);
      const v = y / (W - 1);

      // diagonal gradient background
      const t = Math.min(1, Math.max(0, v * 0.85 + u * 0.15));
      let r = lerp(topR, botR, t);
      let g = lerp(topG, botG, t);
      let b = lerp(topB, botB, t);

      // soft radial glow top-left
      const gd = Math.hypot(u - 0.22, v - 0.16);
      const glow = Math.max(0, 1 - gd / 0.75) ** 2 * 0.22;
      r = lerp(r, 255, glow);
      g = lerp(g, 255, glow);
      b = lerp(b, 255, glow);

      // fox head glyph — silhouette with orange eye slits
      const face  = inTriangle(u, v, 0.170, 0.420, 0.830, 0.420, 0.500, 0.890);
      const earL  = inTriangle(u, v, 0.170, 0.440, 0.238, 0.125, 0.455, 0.440);
      const earR  = inTriangle(u, v, 0.830, 0.440, 0.762, 0.125, 0.545, 0.440);
      const eyeL  = inTriangle(u, v, 0.320, 0.572, 0.445, 0.538, 0.445, 0.590);
      const eyeR  = inTriangle(u, v, 0.680, 0.572, 0.555, 0.538, 0.555, 0.590);

      if ((face || earL || earR) && !(eyeL || eyeR)) {
        r = 0xff; g = 0xf9; b = 0xf2;
      }

      const i = (y * W + x) * 4;
      px[i] = Math.round(r);
      px[i + 1] = Math.round(g);
      px[i + 2] = Math.round(b);
      px[i + 3] = 255;
    }
  }

  // box-downsample
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const i = (((y * S + sy) * W) + (x * S + sx)) * 4;
          r += px[i]; g += px[i + 1]; b += px[i + 2];
        }
      }
      const n = S * S;
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = 255;
    }
  }
  return out;
}

for (const size of [192, 512]) {
  const file = path.join(OUT, `icon-${size}.png`);
  fs.writeFileSync(file, encodePNG(size, size, render(size)));
  console.log('wrote', file, fs.statSync(file).size, 'bytes');
}
