// GIF assembly for gif_creator: the extension sends composited PNG frames
// (overlays already drawn via OffscreenCanvas); this encodes them into an
// animated GIF with gifenc (quantize + dither) and fast-png (decode).

import gifenc from "gifenc";
import { decode } from "fast-png";

const { GIFEncoder, quantize, applyPalette } = gifenc;

const MAX_DIM = 1400; // scale down oversized frames to keep GIFs shareable

function scaleRgba(rgba, w, h, tw, th) {
  if (tw === w && th === h) return rgba;
  const out = new Uint8Array(tw * th * 4);
  for (let y = 0; y < th; y++) {
    const sy = Math.min(h - 1, Math.round((y * h) / th));
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(w - 1, Math.round((x * w) / tw));
      const si = (sy * w + sx) * 4;
      const di = (y * tw + x) * 4;
      out[di] = rgba[si];
      out[di + 1] = rgba[si + 1];
      out[di + 2] = rgba[si + 2];
      out[di + 3] = 255;
    }
  }
  return out;
}

// frames: base64 PNG strings (all same size); delays: ms per frame
export async function encodeGif(frames, delays = [], quality = 10) {
  const gif = GIFEncoder();
  let width = 0;
  let height = 0;
  for (let i = 0; i < frames.length; i++) {
    const png = decode(Buffer.from(frames[i], "base64"));
    let rgba = png.data;
    // normalize to RGBA
    if (png.channels === 3) {
      const withAlpha = new Uint8Array((png.data.length / 3) * 4);
      for (let p = 0, q = 0; p < png.data.length; p += 3, q += 4) {
        withAlpha[q] = png.data[p];
        withAlpha[q + 1] = png.data[p + 1];
        withAlpha[q + 2] = png.data[p + 2];
        withAlpha[q + 3] = 255;
      }
      rgba = withAlpha;
    }
    let w = png.width;
    let h = png.height;
    if (i === 0) {
      const scale = Math.min(1, MAX_DIM / Math.max(w, h));
      width = Math.round(w * scale);
      height = Math.round(h * scale);
    }
    rgba = scaleRgba(rgba, w, h, width, height);
    // quality 1-30 (lower = better): map to palette size + color resolution
    const colors = quality <= 10 ? 256 : quality <= 20 ? 192 : 128;
    const format = quality <= 10 ? "rgb565" : "rgb444";
    const palette = quantize(rgba, colors, { format });
    const index = applyPalette(rgba, palette, format);
    gif.writeFrame(index, width, height, {
      palette,
      delay: Math.max(delays[i] ?? 600, 20),
    });
  }
  gif.finish();
  return { bytes: Buffer.from(gif.bytes()), width, height };
}
