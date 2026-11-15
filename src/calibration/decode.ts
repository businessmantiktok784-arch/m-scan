/**
 * Stage 3.3 — image decoding to grayscale (pure JS, shared by the expo app
 * and bun tests — fast-png / jpeg-js are pure JavaScript with no Node
 * built-ins and no native code, so Metro bundles them on device).
 *
 * Memory discipline: ONE image is decoded at a time; an optional working
 * scale (integer box-average downscale) bounds the raster size. Any scale
 * is recorded and intrinsics are rescaled consistently by the core —
 * calibration is never silently performed at a different scale than the
 * record claims.
 */

import { decode as decodePng } from "fast-png";
import jpeg from "jpeg-js";
import type { GrayImage } from "./image-analysis";

export type ImageFormat = "png" | "jpeg";

export function formatFromPath(path: string): ImageFormat | null {
  const p = path.toLowerCase();
  if (p.endsWith(".png")) return "png";
  if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "jpeg";
  return null;
}

/**
 * Decodes bytes to a grayscale raster. `maxDim` (when set) downscales by an
 * integer factor just enough that the long edge fits — the returned image
 * carries the applied factor so intrinsic coordinates stay honest.
 */
export function decodeImage(
  bytes: Uint8Array,
  format: ImageFormat,
  maxDim?: number | null,
): { image: GrayImage; downscale: number } | null {
  let width: number;
  let height: number;
  let rgba: Uint8Array;
  try {
    if (format === "png") {
      const png = decodePng(bytes);
      if (png.depth !== 8) return null; // only 8-bit depth is supported — reject, never approximate
      width = png.width;
      height = png.height;
      rgba = toRgba(png.data, png.channels);
    } else {
      const decoded = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
      width = decoded.width;
      height = decoded.height;
      rgba = new Uint8Array(decoded.data);
    }
  } catch {
    return null; // corrupted image — caller records and rejects
  }
  if (!width || !height || rgba.length < width * height * 4) return null;

  let factor = 1;
  if (maxDim && Math.max(width, height) > maxDim) {
    while (Math.max(width / factor, height / factor) > maxDim) factor++;
  }
  if (factor === 1) {
    return { image: { width, height, gray: toGray(rgba, width, height) }, downscale: 1 };
  }
  const w = Math.floor(width / factor);
  const h = Math.floor(height / factor);
  const gray = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const src = ((y * factor + dy) * width + (x * factor + dx)) * 4;
          s += 0.299 * rgba[src] + 0.587 * rgba[src + 1] + 0.114 * rgba[src + 2];
          n++;
        }
      }
      gray[y * w + x] = Math.round(s / Math.max(1, n));
    }
  }
  return { image: { width: w, height: h, gray }, downscale: factor };
}

function toRgba(data: Uint8Array | Uint16Array | Uint8ClampedArray, channels: number): Uint8Array {
  if (channels === 4) return new Uint8Array(data);
  // Expand gray (1), gray+alpha (2) and RGB (3) to RGBA so every downstream
  // path sees one layout.
  const out = new Uint8Array((data.length / channels) * 4);
  for (let i = 0; i < out.length / 4; i++) {
    const s = i * channels;
    if (channels === 3) {
      out[i * 4] = data[s];
      out[i * 4 + 1] = data[s + 1];
      out[i * 4 + 2] = data[s + 2];
    } else {
      // gray or gray+alpha: replicate the gray channel
      out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = data[s];
    }
    out[i * 4 + 3] = channels === 2 ? data[s + 1] : 255;
  }
  return out;
}

function toGray(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i++) {
    const s = i * 4;
    gray[i] = Math.round(0.299 * rgba[s] + 0.587 * rgba[s + 1] + 0.114 * rgba[s + 2]);
  }
  return gray;
}
