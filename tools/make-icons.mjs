#!/usr/bin/env node
// Generate simple solid-gradient PNG icons for the extension (no deps —
// hand-rolled minimal PNG encoder using zlib).
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "extension", "icons");
mkdirSync(outDir, { recursive: true });

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function makeIcon(size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0;
    for (let x = 0; x < size; x++) {
      const t = (x + y) / (2 * size - 2);
      // indigo -> teal gradient, rounded-square alpha mask
      const margin = Math.max(1, Math.round(size * 0.08));
      const rad = Math.round(size * 0.22);
      const inX = Math.min(x - margin, size - 1 - margin - x);
      const inY = Math.min(y - margin, size - 1 - margin - y);
      let alpha = 255;
      if (inX < 0 || inY < 0) alpha = 0;
      else if (inX < rad && inY < rad) {
        const dx = rad - inX, dy = rad - inY;
        alpha = dx * dx + dy * dy <= rad * rad ? 255 : 0;
      }
      const r = Math.round(79 + t * (13 - 79));
      const g = Math.round(70 + t * (148 - 70));
      const b = Math.round(229 + t * (136 - 229));
      const o = 1 + x * 4;
      row[o] = r; row[o + 1] = g; row[o + 2] = b; row[o + 3] = alpha;
    }
    // white "chevron" glyph: draw a simple > shape
    rows.push(row);
  }
  // stamp a white dot pattern (cursor-ish) in the center
  const cx = Math.round(size * 0.5), cy = Math.round(size * 0.5), r0 = Math.max(2, Math.round(size * 0.16));
  for (let y = cy - r0; y <= cy + r0; y++) {
    for (let x = cx - r0; x <= cx + r0; x++) {
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const d2 = (x - cx) ** 2 + (y - cy) ** 2;
      if (d2 <= r0 * r0) {
        const o = 1 + x * 4;
        rows[y][o] = 255; rows[y][o + 1] = 255; rows[y][o + 2] = 255;
      }
    }
  }
  const idat = deflateSync(Buffer.concat(rows));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [16, 48, 128]) {
  writeFileSync(join(outDir, `icon${size}.png`), makeIcon(size));
  console.log(`icon${size}.png`);
}
