/**
 * Stage 3.3 — image analysis: checkerboard inner-corner detection and
 * per-image suitability metrics (pure TypeScript on a grayscale raster).
 *
 * This is the on-device replacement for OpenCV's findChessboardCorners. It
 * is a saddle-point ("X-corner") detector: a checkerboard inner corner is
 * the point where the two diagonal neighbourhood pairs have opposite, nearly
 * uniform phases. The detector is honest about failure: when it cannot
 * assemble a consistent grid of the EXACT expected shape, it reports
 * failure — the caller rejects that image rather than guessing corners.
 *
 * Known, documented limitation: this detector targets well-lit, reasonably
 * sharp checkerboards (what an operator shoots for calibration). It is not
 * OpenCV's adaptive repo-scale implementation; images it cannot read are
 * rejected and counted, never approximated.
 */

export interface GrayImage {
  width: number;
  height: number;
  gray: Uint8Array; // row-major, 0..255
}

export interface DetectedBoard {
  /** Ordered corners, row-major: rows × cols, in pixel coordinates. */
  corners: [number, number][];
  rows: number;
  cols: number;
}

export interface DetectionOutcome {
  board: DetectedBoard | null;
  reason: string | null;
}

/** 8×8 average hash, for duplicate-image detection. */
export function averageHash(img: GrayImage): bigint {
  const small = new Array<number>(64).fill(0);
  const cellW = img.width / 8;
  const cellH = img.height / 8;
  for (let ty = 0; ty < 8; ty++) {
    for (let tx = 0; tx < 8; tx++) {
      let s = 0;
      let n = 0;
      for (let y = Math.floor(ty * cellH); y < Math.floor((ty + 1) * cellH); y += 2) {
        for (let x = Math.floor(tx * cellW); x < Math.floor((tx + 1) * cellW); x += 2) {
          s += img.gray[y * img.width + x];
          n++;
        }
      }
      small[ty * 8 + tx] = n > 0 ? s / n : 0;
    }
  }
  const mean = small.reduce((a, b) => a + b, 0) / 64;
  let h = 0n;
  for (let i = 0; i < 64; i++) if (small[i] > mean) h |= 1n << BigInt(i);
  return h;
}

export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let d = 0;
  while (x) {
    d += Number(x & 1n);
    x >>= 1n;
  }
  return d;
}

/** Otsu threshold; returns the threshold value. */
export function otsu(img: GrayImage): number {
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < img.gray.length; i++) hist[img.gray[i]]++;
  const total = img.gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) {
      bestVar = between;
      best = t;
    }
  }
  return best;
}

interface Candidate {
  x: number;
  y: number;
  score: number;
}

/**
 * Detects the inner corners of a checkerboard with the DECLARED grid shape
 * (corner_rows × corner_columns). The assembled grid is canonicalised:
 * rows are sorted top-to-bottom (mean image y) and corners within each row
 * left-to-right (mean x), so the world-point assignment is consistent
 * across views whenever the board's in-plane rotation stays within ±90°
 * over the frame set. Operating guidance: keep the target roughly upright
 * and do not rotate it 180° between shots; boards rotated ≈90° in-plane
 * fail detection honestly (target_detection_failed) rather than being
 * silently relabelled.
 */
export function detectCheckerboard(
  img: GrayImage,
  cornerRows: number,
  cornerCols: number,
): DetectionOutcome {
  if (img.width < 64 || img.height < 64) {
    return { board: null, reason: "image_too_small_for_target" };
  }
  const candidates = findSaddleCandidates(img);
  if (candidates.length < cornerRows * cornerCols) {
    return { board: null, reason: "target_detection_failed" };
  }
  const raw = assembleGrid(candidates, cornerRows, cornerCols);
  if (!raw) return { board: null, reason: "target_detection_failed" };
  return { board: { corners: canonicalize(raw, cornerRows, cornerCols), rows: cornerRows, cols: cornerCols }, reason: null };
}

/** Rows top-to-bottom by mean y, corners left-to-right by x. */
function canonicalize(
  corners: [number, number][],
  rows: number,
  cols: number,
): [number, number][] {
  const asRows: [number, number][][] = [];
  for (let r = 0; r < rows; r++) asRows.push(corners.slice(r * cols, (r + 1) * cols));
  asRows.sort((a, b) => meanY(a) - meanY(b));
  for (const row of asRows) row.sort((a, b) => a[0] - b[0]);
  return asRows.flat();
}

function meanY(row: [number, number][]): number {
  return row.reduce((s, p) => s + p[1], 0) / row.length;
}

/** Saddle-point candidates with non-maximum suppression. */
function findSaddleCandidates(img: GrayImage): Candidate[] {
  const { width: w, height: h, gray } = img;
  const r = Math.max(3, Math.min(12, Math.round(Math.min(w, h) * 0.012)));
  const scores = new Float32Array(w * h);
  // Quadrant sums via diagonal split inside a disc of radius r.
  const offsets: [number, number, 0 | 1 | 2 | 3][] = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r || (dx === 0 && dy === 0)) continue;
      const q: 0 | 1 | 2 | 3 = dy < 0 ? (dx >= 0 ? 0 : 1) : dx >= 0 ? 3 : 2;
      offsets.push([dx, dy, q]);
    }
  }
  const qSum = [0, 0, 0, 0];
  const qN = [0, 0, 0, 0];
  for (let y = r + 1; y < h - r - 1; y++) {
    for (let x = r + 1; x < w - r - 1; x++) {
      qSum[0] = qSum[1] = qSum[2] = qSum[3] = 0;
      qN[0] = qN[1] = qN[2] = qN[3] = 0;
      for (const [dx, dy, q] of offsets) {
        qSum[q] += gray[(y + dy) * w + (x + dx)];
        qN[q]++;
      }
      const m0 = qSum[0] / qN[0];
      const m1 = qSum[1] / qN[1];
      const m2 = qSum[2] / qN[2];
      const m3 = qSum[3] / qN[3];
      // Diagonal pairs (0,2) and (1,3): a saddle has one pair bright, the other dark.
      const s1 = Math.min(m0, m2) - Math.max(m1, m3);
      const s2 = Math.min(m1, m3) - Math.max(m0, m2);
      const s = Math.max(s1, s2);
      if (s > 24) scores[y * w + x] = s;
    }
  }
  // Non-max suppression in a 2r+1 window.
  const out: Candidate[] = [];
  for (let y = r + 1; y < h - r - 1; y++) {
    for (let x = r + 1; x < w - r - 1; x++) {
      const s = scores[y * w + x];
      if (s <= 0) continue;
      let isMax = true;
      for (let dy = -r; dy <= r && isMax; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (scores[(y + dy) * w + (x + dx)] > s) {
            isMax = false;
            break;
          }
        }
      if (isMax) {
        // Parabola subpixel refinement on the score field.
        const sx = parabola(scores[y * w + x - 1], s, scores[y * w + x + 1]);
        const sy = parabola(scores[(y - 1) * w + x], s, scores[(y + 1) * w + x]);
        out.push({ x: x + sx, y: y + sy, score: s });
      }
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

function parabola(a: number, b: number, c: number): number {
  const denom = a - 2 * b + c;
  return Math.abs(denom) < 1e-9 ? 0 : (0.5 * (a - c)) / denom;
}

/**
 * Assembles an exact rows×cols grid from candidates: seed at the strongest
 * candidate, chain the first row and column by predicted steps, then fill
 * by parallelogram snapping. Returns row-major pixel coordinates or null.
 */
function assembleGrid(
  candidates: Candidate[],
  rows: number,
  cols: number,
): [number, number][] | null {
  const limit = Math.min(candidates.length, 400);
  const pts = candidates.slice(0, limit);
  // Spacing: median distance from each of the top candidates to its nearest
  // neighbour — robust to a stray strongest detection.
  const nn: number[] = [];
  for (let i = 0; i < Math.min(24, pts.length); i++) {
    let d = Infinity;
    for (let j = 0; j < Math.min(60, pts.length); j++) {
      if (i === j) continue;
      d = Math.min(d, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
    }
    if (Number.isFinite(d) && d > 2) nn.push(d);
  }
  if (nn.length === 0) return null;
  nn.sort((a, b) => a - b);
  const spacing = nn[Math.floor(nn.length / 2)];
  const snapTol = spacing * 0.55;

  const taken = new Set<number>();
  const nearestTo = (px: number, py: number): number | null => {
    let bestIdx: number | null = null;
    let bestD = snapTol;
    for (let i = 0; i < pts.length; i++) {
      if (taken.has(i)) continue;
      const d = Math.hypot(pts[i].x - px, pts[i].y - py);
      if (d < bestD) {
        bestD = d;
        bestIdx = i;
      }
    }
    return bestIdx;
  };
  const claim = (idx: number | null): number | null => {
    if (idx === null) return null;
    taken.add(idx);
    return idx;
  };

  // Chain one row from a seed in both directions, re-estimating the step
  // direction from the most recent segment.
  const chainRow = (seedIdx: number): number[] | null => {
    taken.clear();
    const first = claim(seedIdx);
    if (first === null) return null;
    const forward: number[] = [];
    let dirX = spacing;
    let dirY = 0;
    let cur = first;
    for (;;) {
      const a = pts[cur];
      const next = claim(nearestTo(a.x + dirX, a.y + dirY));
      if (next === null) break;
      const b = pts[next];
      dirX = b.x - a.x;
      dirY = b.y - a.y;
      forward.push(next);
      cur = next;
    }
    // Backward chain from the seed.
    const backward: number[] = [];
    let bDirX = -spacing;
    let bDirY = 0;
    cur = first;
    for (;;) {
      const a = pts[cur];
      const next = claim(nearestTo(a.x + bDirX, a.y + bDirY));
      if (next === null) break;
      const b = pts[next];
      bDirX = b.x - a.x;
      bDirY = b.y - a.y;
      backward.push(next);
      cur = next;
    }
    const line = backward.reverse().concat([first], forward);
    if (line.length < cols) return null;
    // Choose the contiguous window of `cols` that contains the seed.
    const seedPos = backward.length;
    const startIdx = Math.max(0, Math.min(seedPos, line.length - cols));
    return line.slice(startIdx, startIdx + cols);
  };

  // Try several seeds (strongest first); the strongest is not always on the
  // target, and interior seeds chain differently than row-end seeds.
  let row0: number[] | null = null;
  for (let s = 0; s < Math.min(10, pts.length); s++) {
    const candidate = chainRow(s);
    if (candidate && candidate.length === cols) {
      row0 = candidate;
      break;
    }
  }
  if (!row0) return null;

  const p0 = pts[row0[0]];
  const p1 = pts[row0[cols - 1]];
  const rowVec: [number, number] = [(p1.x - p0.x) / (cols - 1), (p1.y - p0.y) / (cols - 1)];
  // Unit normal of the row direction (rowVec is a per-corner STEP whose
  // length is ~spacing, never a unit vector — it must be normalised
  // before being scaled by the spacing).
  const rowLen = Math.hypot(rowVec[0], rowVec[1]) || 1;
  const perp: [number, number] = [-rowVec[1] / rowLen, rowVec[0] / rowLen];

  const takenSnapshot = new Set(taken);

  /** Extends the grid by one row in `sign` (+1 below, −1 above row0). */
  const extend = (
    existing: [number, number][][],
    existingStarts: [number, number][],
    sign: 1 | -1,
  ): [number, number][] | null => {
    let predicted: [number, number];
    const n = existing.length;
    if (n >= 2) {
      // Continue the established direction of travel (rows are ordered along
      // the travel direction, so this is always extrapolation forward).
      const prev = existingStarts[n - 1];
      const prev2 = existingStarts[n - 2];
      predicted = [prev[0] + (prev[0] - prev2[0]), prev[1] + (prev[1] - prev2[1])];
    } else {
      const anchor = existingStarts[0];
      predicted = [anchor[0] + sign * perp[0] * spacing, anchor[1] + sign * perp[1] * spacing];
      const hasSide = pts.some(
        (p, i) => !takenSnapshot.has(i) && Math.hypot(p.x - predicted[0], p.y - predicted[1]) < snapTol,
      );
      if (!hasSide) {
        predicted = [anchor[0] - sign * perp[0] * spacing, anchor[1] - sign * perp[1] * spacing];
      }
    }
    taken.clear();
    for (const i of takenSnapshot) taken.add(i);
    const startIdx = claim(nearestTo(predicted[0], predicted[1]));
    if (startIdx === null) return null;
    const startPt = pts[startIdx];
    const row: [number, number][] = [[startPt.x, startPt.y]];
    for (let c = 1; c < cols; c++) {
      const prev = row[c - 1];
      const idx = claim(nearestTo(prev[0] + rowVec[0], prev[1] + rowVec[1]));
      if (idx === null) return null;
      row.push([pts[idx].x, pts[idx].y]);
    }
    return row;
  };

  // The seed row may be ANY row of the board (the strongest corner is not
  // necessarily on the top edge): extend downward AND upward until the
  // declared shape is assembled or no candidate fits.
  const down: [number, number][][] = [row0.map((i) => [pts[i].x, pts[i].y])];
  const downStarts: [number, number][] = [[p0.x, p0.y]];
  while (down.length < rows) {
    const row = extend(down, downStarts, 1);
    if (!row) break;
    down.push(row);
    downStarts.push([row[0][0], row[0][1]]);
  }
  // Upward extension always chains from the seed row: upChain starts with
  // row0 and grows upward, so the extrapolation direction stays correct.
  const up: [number, number][][] = [];
  const upChain: [number, number][][] = [row0.map((i) => [pts[i].x, pts[i].y])];
  const upStarts: [number, number][] = [[p0.x, p0.y]];
  while (down.length + up.length < rows) {
    const row = extend(upChain, upStarts, -1);
    if (!row) break;
    up.push(row);
    upChain.push(row);
    upStarts.push([row[0][0], row[0][1]]);
  }
  if (down.length + up.length !== rows) return null;
  const grid = [...up.reverse(), ...down];

  // Consistency: corners must be distinct and non-degenerate.
  const corners: [number, number][] = [];
  for (const row of grid) for (const p of row) corners.push([p[0], p[1]]);
  const uniq = new Set(corners.map((p) => `${Math.round(p[0])},${Math.round(p[1])}`));
  if (uniq.size !== rows * cols) return null;
  return corners;
}

// ---------------------------------------------------------------------------
// suitability metrics (measured, thresholded only by configured gates)
// ---------------------------------------------------------------------------

export interface ExposureStats {
  mean: number;
  std: number;
  overFraction: number; // pixels ≥ 250
  underFraction: number; // pixels ≤ 5
  blurVariance: number; // variance of the 3×3 Laplacian
}

/** Samples with stride for the 8 GB budget — statistically valid, cheap. */
export function exposureStats(img: GrayImage, stride = 2): ExposureStats {
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  let over = 0;
  let under = 0;
  for (let y = 1; y < img.height - 1; y += stride) {
    for (let x = 1; x < img.width - 1; x += stride) {
      const v = img.gray[y * img.width + x];
      n++;
      sum += v;
      sumSq += v * v;
      if (v >= 250) over++;
      if (v <= 5) under++;
    }
  }
  const mean = n ? sum / n : 0;
  const variance = n ? sumSq / n - mean * mean : 0;

  // Laplacian variance on the same stride.
  let lapSum = 0;
  let lapSq = 0;
  let ln = 0;
  for (let y = 1; y < img.height - 1; y += stride) {
    for (let x = 1; x < img.width - 1; x += stride) {
      const i = y * img.width + x;
      const lap = img.gray[i - 1] + img.gray[i + 1] + img.gray[i - img.width] + img.gray[i + img.width] - 4 * img.gray[i];
      lapSum += lap;
      lapSq += lap * lap;
      ln++;
    }
  }
  const lapMean = ln ? lapSum / ln : 0;
  return {
    mean,
    std: Math.sqrt(Math.max(0, variance)),
    overFraction: n ? over / n : 0,
    underFraction: n ? under / n : 0,
    blurVariance: ln ? lapSq / ln - lapMean * lapMean : 0,
  };
}
