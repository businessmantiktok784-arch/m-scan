/**
 * Stage 3.3 — camera-calibration solver (pure TypeScript, no platform or
 * native imports).
 *
 * OpenCV is NOT available on device (native modules cannot be installed in
 * this environment — the same constraint that made FFmpeg a seam in Stage
 * 3.2). The engine here is a genuine implementation of Zhang's
 * "Flexible Camera Calibration by Viewing a Plane from Unknown Orientations"
 * (2000), the method OpenCV's calibrateCamera implements:
 *
 *   1. Homography per view (Hartley-normalised DLT, smallest right
 *      singular vector via Jacobi eigen-decomposition of AᵀA).
 *   2. Closed-form intrinsics from the stacked v-constraints (full 6-param
 *      B, general formulas — skew comes out ≈ 0 and is then forced to 0).
 *   3. Per-view extrinsics from H and K, orthonormalised.
 *   4. Distortion initialisation (linear least squares, k1/k2, tangential 0).
 *   5. Joint Levenberg–Marquardt refinement over intrinsics, 5 distortion
 *      coefficients [k1,k2,p1,p2,k3] and all per-view poses, with a numeric
 *      (central-difference) Jacobian.
 *
 * Everything is linear algebra on plain arrays. There is NO randomness and
 * no synthetic-data assumption inside the solver: it consumes 2D↔3D
 * correspondences, whoever measured them. Whether they came from real
 * detection is the caller's responsibility.
 */

import { distortNormalized, type Intrinsics } from "./camera-model";

// ---------------------------------------------------------------------------
// small linear algebra
// ---------------------------------------------------------------------------

function matVec(m: number[], v: number[]): number[] {
  const out = new Array<number>(m.length / v.length).fill(0);
  for (let r = 0; r < out.length; r++) {
    let s = 0;
    for (let c = 0; c < v.length; c++) s += m[r * v.length + c] * v[c];
    out[r] = s;
  }
  return out;
}

/** Smallest-eigenvalue eigenvector of a symmetric matrix (Jacobi rotations). */
export function smallestEigenvector(sym: number[], n: number): number[] {
  const a = sym.slice();
  const v = new Array<number>(n * n).fill(0);
  for (let i = 0; i < n; i++) v[i * n + i] = 1;
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p * n + q] ** 2;
    if (off < 1e-20) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q];
        if (Math.abs(apq) < 1e-15) continue;
        const app = a[p * n + p];
        const aqq = a[q * n + q];
        const theta = (aqq - app) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        // A ← Gᵀ A G: apply the rotation on BOTH sides (row update AND column
        // update). Skipping the row update leaves A undiagonalised.
        for (let k = 0; k < n; k++) {
          const akp = a[k * n + p];
          const akq = a[k * n + q];
          a[k * n + p] = c * akp - s * akq;
          a[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p * n + k];
          const aqk = a[q * n + k];
          a[p * n + k] = c * apk - s * aqk;
          a[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k * n + p];
          const vkq = v[k * n + q];
          v[k * n + p] = c * vkp - s * vkq;
          v[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  // Pick the eigenvalue on the diagonal with the smallest magnitude.
  let best = 0;
  let bestVal = Math.abs(a[0]);
  for (let i = 1; i < n; i++) {
    if (Math.abs(a[i * n + i]) < bestVal) {
      bestVal = Math.abs(a[i * n + i]);
      best = i;
    }
  }
  const out = new Array<number>(n);
  for (let k = 0; k < n; k++) out[k] = v[k * n + best];
  return normalise(out);
}

function normalise(v: number[]): number[] {
  const n = Math.hypot(...v);
  return n === 0 || !Number.isFinite(n) ? v : v.map((x) => x / n);
}

/** Solves the 4th-or-lower... general normal equations (AᵀA)x = Aᵀb via Gaussian elimination. */
export function solveLeastSquares(rows: number[][], rhs: number[], nCols: number): number[] | null {
  const ata = new Array<number>(nCols * nCols).fill(0);
  const atb = new Array<number>(nCols).fill(0);
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (let i = 0; i < nCols; i++) {
      atb[i] += row[i] * rhs[r];
      for (let j = 0; j < nCols; j++) ata[i * nCols + j] += row[i] * row[j];
    }
  }
  // Gaussian elimination with partial pivoting.
  const m = ata.map((v, idx) => v);
  const b = atb.slice();
  for (let col = 0; col < nCols; col++) {
    let piv = col;
    for (let r = col + 1; r < nCols; r++) if (Math.abs(m[r * nCols + col]) > Math.abs(m[piv * nCols + col])) piv = r;
    if (Math.abs(m[piv * nCols + col]) < 1e-12) return null;
    if (piv !== col) {
      for (let c = 0; c < nCols; c++) {
        const t = m[col * nCols + c];
        m[col * nCols + c] = m[piv * nCols + c];
        m[piv * nCols + c] = t;
      }
      const tb = b[col];
      b[col] = b[piv];
      b[piv] = tb;
    }
    for (let r = col + 1; r < nCols; r++) {
      const f = m[r * nCols + col] / m[col * nCols + col];
      if (f === 0) continue;
      for (let c = col; c < nCols; c++) m[r * nCols + c] -= f * m[col * nCols + c];
      b[r] -= f * b[col];
    }
  }
  const x = new Array<number>(nCols).fill(0);
  for (let r = nCols - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < nCols; c++) s -= m[r * nCols + c] * x[c];
    x[r] = s / m[r * nCols + r];
  }
  return x.every((v) => Number.isFinite(v)) ? x : null;
}

/** Rodrigues: axis-angle vector → 3×3 rotation matrix (row-major). */
export function rodrigues(w: number[]): number[] {
  const theta = Math.hypot(w[0], w[1], w[2]);
  if (theta < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const k = w.map((x) => x / theta);
  const K = [0, -k[2], k[1], k[2], 0, -k[0], -k[1], k[0], 0];
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const R = new Array<number>(9);
  for (let r = 0; r < 3; r++)
    for (let col = 0; col < 3; col++)
      R[r * 3 + col] =
        (r === col ? c : 0) + s * K[r * 3 + col] + (1 - c) * k[r] * k[col];
  return R;
}

/** Inverse Rodrigues: rotation matrix → axis-angle vector. */
export function rodriguesInverse(R: number[]): number[] {
  const theta = Math.acos(Math.min(1, Math.max(-1, (R[0] + R[4] + R[8] - 1) / 2)));
  if (theta < 1e-9) return [0, 0, 0];
  let w: number[];
  if (theta < Math.PI - 1e-6) {
    w = [(R[7] - R[5]) / 2, (R[2] - R[6]) / 2, (R[3] - R[1]) / 2];
  } else {
    // Near π: extract the axis from the diagonal.
    const xx = Math.sqrt(Math.max(0, (R[0] + 1) / 2));
    const yy = Math.sqrt(Math.max(0, (R[4] + 1) / 2));
    const zz = Math.sqrt(Math.max(0, (R[8] + 1) / 2));
    w = [xx, yy, zz];
  }
  const n = Math.hypot(...w);
  if (n < 1e-12) return [0, 0, 0];
  return w.map((x) => (x / n) * theta);
}

// ---------------------------------------------------------------------------
// 1. homography (Hartley-normalised DLT)
// ---------------------------------------------------------------------------

/**
 * Estimates the planar homography mapping world (X, Y) → image (u, v).
 * Returns the 9-element row-major H or null when the system is degenerate.
 */
export function estimateHomography(
  world: [number, number][],
  image: [number, number][],
): number[] | null {
  const n = world.length;
  if (n < 4) return null;

  // Hartley normalisation: centroid to origin, mean distance to sqrt(2).
  const norm = (pts: [number, number][]) => {
    const cx = pts.reduce((s, p) => s + p[0], 0) / n;
    const cy = pts.reduce((s, p) => s + p[1], 0) / n;
    const d = Math.sqrt(pts.reduce((s, p) => s + Math.hypot(p[0] - cx, p[1] - cy), 0) / n) || 1;
    const s = Math.SQRT2 / d;
    return { cx, cy, s };
  };
  const nw = norm(world);
  const ni = norm(image);
  const T = (c: number, cx: number, cy: number, s: number): number[] => [s, 0, -s * cx, 0, c * s, -c * s * cy, 0, 0, 1];
  const Tw = T(1, nw.cx, nw.cy, nw.s);
  const Ti = T(1, ni.cx, ni.cy, ni.s);
  const wp = world.map(([x, y]) => {
    const w = 1;
    return [
      (nw.s * x - nw.s * nw.cx) / w,
      (nw.s * y - nw.s * nw.cy) / w,
    ] as [number, number];
  });
  const ip = image.map(([u, v]) => [
    (ni.s * u - ni.s * ni.cx),
    (ni.s * v - ni.s * ni.cy),
  ] as [number, number]);

  // A (2n × 9): rows for [u v 1] × h3ᵀ − [X Y 1] × h1ᵀ etc.
  const rows: number[][] = [];
  for (let i = 0; i < n; i++) {
    const [X, Y] = wp[i];
    const [u, v] = ip[i];
    rows.push([X, Y, 1, 0, 0, 0, -u * X, -u * Y, -u]);
    rows.push([0, 0, 0, X, Y, 1, -v * X, -v * Y, -v]);
  }
  const ata = new Array<number>(81).fill(0);
  for (const row of rows)
    for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++) ata[i * 9 + j] += row[i] * row[j];
  const h = smallestEigenvector(ata, 9);
  if (!h.every(Number.isFinite)) return null;

  // Denormalise: H = Ti⁻¹ · h̃ · Tw
  const Ht = h; // h̃ (3×3 row-major)
  const TiInv = [
    1 / ni.s, 0, ni.cx, 0, 1 / ni.s, ni.cy, 0, 0, 1,
  ];
  const Hn = matVec9(TiInv, Ht);
  const H = matVec9(Hn, Tw);
  const scale = H[8];
  if (!Number.isFinite(scale) || Math.abs(scale) < 1e-12) return null;
  const out = H.map((x) => x / scale);
  return out.every(Number.isFinite) ? out : null;
}

function matVec9(m: number[], v: number[]): number[] {
  const out = new Array<number>(9).fill(0);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      for (let k = 0; k < 3; k++) out[r * 3 + c] += m[r * 3 + k] * v[k * 3 + c];
  return out;
}

// ---------------------------------------------------------------------------
// 2. closed-form intrinsics (Zhang §3.1, Appendix B)
// ---------------------------------------------------------------------------

/**
 * Estimates K from ≥3 homographies. Returns null when the B matrix is not
 * positive-definite (degenerate views — e.g. all planes parallel).
 */
export function closedFormIntrinsics(homographies: number[][]): Intrinsics | null {
  if (homographies.length < 3) return null;
  const rows: number[][] = [];
  for (const H of homographies) {
    // H is row-major; column i of H is (H[i], H[i+3], H[i+6]).
    const col = (i: number) => [H[i], H[i + 3], H[i + 6]];
    /** Zhang eq. 9: v_ij for a COLUMN pair (a, b), stacked against
     * b = [B11, B12, B13, B22, B23, B33]. The constraint aᵀBa (= h1ᵀBh2 = 0
     * for the first two columns) pairs the two columns componentwise. */
    const vij = (a: number[], b: number[]): number[] => [
      a[0] * b[0],
      a[0] * b[1] + a[1] * b[0],
      a[0] * b[2] + a[2] * b[0],
      a[1] * b[1],
      a[1] * b[2] + a[2] * b[1],
      a[2] * b[2],
    ];
    const h1 = col(0);
    const h2 = col(1);
    const v11 = vij(h1, h1);
    const v22 = vij(h2, h2);
    rows.push(vij(h1, h2));
    rows.push(v11.map((x, idx) => x - v22[idx]));
  }
  const ata = new Array<number>(36).fill(0);
  for (const row of rows)
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) ata[i * 6 + j] += row[i] * row[j];
  const b = smallestEigenvector(ata, 6);
  if (!b.every(Number.isFinite)) return null;

  const B11 = b[0];
  const B12 = b[1];
  const B13 = b[2];
  const B22 = b[3];
  const B23 = b[4];
  const B33 = b[5];

  // Zhang Appendix B (b up to an arbitrary scale — every formula below is
  // homogeneous of degree 0 in b, so the eigenvector normalisation cancels).
  const d = B11 * B22 - B12 * B12;
  if (!(d > 0) || B11 <= 0 || B22 <= 0) return null;
  const cy = (B12 * B13 - B11 * B23) / d;
  const lambda = B33 - (B13 * B13 + cy * (B12 * B13 - B11 * B23)) / B11;
  if (!(lambda > 0)) return null;
  const fx = Math.sqrt(lambda / B11);
  const fy = Math.sqrt(lambda / B22);
  // Skew comes out of the same formulas; for a zero-skew camera |B12| ≈ 0
  // and γ ≈ 0 (the caller checks the residual either way).
  const gamma = (-B12 * fx * fx * fy * fy) / lambda;
  const cx = (gamma * cy) / (fx * fx) - (B13 * fx * fx) / lambda;
  if (![fx, fy, cx, cy].every((x) => Number.isFinite(x)) || fx <= 0 || fy <= 0) return null;
  // Zero-skew convention is binding for this app: the estimated |B12| is
  // checked by the caller via reprojection error, not silently propagated.
  return { fx, fy, cx, cy };
}

// ---------------------------------------------------------------------------
// 3. per-view extrinsics
// ---------------------------------------------------------------------------

export interface ViewPose {
  /** Rodrigues vector, 3 elements. */
  rvec: number[];
  t: number[];
}

/** Decomposes H = K [r1 r2 t] (up to scale) into an orthonormalised pose. */
export function poseFromHomography(H: number[], K: Intrinsics): ViewPose | null {
  const Kinv = [1 / K.fx, 0, -K.cx / K.fx, 0, 1 / K.fy, -K.cy / K.fy, 0, 0, 1];
  // H is row-major; column i of H is (H[i], H[i+3], H[i+6]).
  const col = (i: number) => [H[i], H[i + 3], H[i + 6]];
  const h1 = col(0);
  const h2 = col(1);
  const h3 = col(2);
  const apply = (m: number[], v: number[]) => [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
  const n1 = apply(Kinv, h1);
  const n2 = apply(Kinv, h2);
  const lam = Math.hypot(n1[0], n1[1], n1[2]);
  if (!(lam > 1e-12)) return null;
  let r1 = n1.map((x) => x / lam);
  let r2 = n2.map((x) => x / lam);
  // Orthonormalise (Gram-Schmidt), then r3 = r1 × r2 for a proper rotation.
  const dot = r1[0] * r2[0] + r1[1] * r2[1] + r1[2] * r2[2];
  r2 = r2.map((x, i) => x - dot * r1[i]);
  const n2len = Math.hypot(...r2);
  if (!(n2len > 1e-9)) return null;
  r2 = r2.map((x) => x / n2len);
  const r3 = [
    r1[1] * r2[2] - r1[2] * r2[1],
    r1[2] * r2[0] - r1[0] * r2[2],
    r1[0] * r2[1] - r1[1] * r2[0],
  ];
  const t = apply(Kinv, h3).map((x) => x / lam);
  const R = [r1[0], r2[0], r3[0], r1[1], r2[1], r3[1], r1[2], r2[2], r3[2]];
  return { rvec: rodriguesInverse(R), t };
}

// ---------------------------------------------------------------------------
// 4–5. distortion init + joint LM refinement
// ---------------------------------------------------------------------------

export interface Correspondences {
  world: [number, number][]; // target-plane coordinates in the target's unit
  image: [number, number][]; // observed pixel coordinates
}

export interface CalibrationEstimate {
  intrinsics: Intrinsics;
  distortion: number[]; // [k1, k2, p1, p2, k3]
  poses: ViewPose[];
  reprojectionErrorPx: number | null;
  perImageErrorPx: number[];
  converged: boolean;
}

/** Projects one world point (plane z=0) with distortion into pixels. */
export function projectPoint(
  K: Intrinsics,
  d: number[],
  pose: ViewPose,
  world: [number, number],
): [number, number] | null {
  const R = rodrigues(pose.rvec);
  const p = [world[0], world[1], 0];
  const pc = [
    R[0] * p[0] + R[1] * p[1] + R[2] * 0 + pose.t[0],
    R[3] * p[0] + R[4] * p[1] + R[5] * 0 + pose.t[1],
    R[6] * p[0] + R[7] * p[1] + R[8] * 0 + pose.t[2],
  ];
  if (!(pc[2] > 1e-9)) return null; // behind the camera
  const x = pc[0] / pc[2];
  const y = pc[1] / pc[2];
  const xd = distortNormalized(x, y, d);
  return [K.fx * xd.x + K.cx, K.fy * xd.y + K.cy];
}

/** Initialises k1/k2 by linear least squares (tangential fixed at 0). */
export function initDistortion(
  K: Intrinsics,
  poses: ViewPose[],
  views: Correspondences[],
): number[] {
  const rows: number[][] = [];
  const rhs: number[] = [];
  for (let v = 0; v < views.length; v++) {
    const R = rodrigues(poses[v].rvec);
    for (let i = 0; i < views[v].world.length; i++) {
      const [X, Y] = views[v].world[i];
      const [u, obv] = views[v].image[i];
      const pc = [
        R[0] * X + R[1] * Y + poses[v].t[0],
        R[3] * X + R[4] * Y + poses[v].t[1],
        R[6] * X + R[7] * Y + poses[v].t[2],
      ];
      if (!(pc[2] > 1e-9)) continue;
      const x = pc[0] / pc[2];
      const y = pc[1] / pc[2];
      const r2 = x * x + y * y;
      const xn = (u - K.cx) / K.fx;
      const yn = (obv - K.cy) / K.fy;
      rows.push([x * r2, x * r2 * r2]);
      rhs.push(xn - x);
      rows.push([y * r2, y * r2 * r2]);
      rhs.push(yn - y);
    }
  }
  const sol = solveLeastSquares(rows, rhs, 2);
  return sol ? [sol[0], sol[1], 0, 0, 0] : [0, 0, 0, 0, 0];
}

/**
 * Full Zhang pipeline. `views` carry correspondences from REAL detections.
 * Returns null when any stage is degenerate; per-image reprojection errors
 * are ALWAYS measured, never assumed.
 */
export function calibrateZhang(views: Correspondences[]): CalibrationEstimate | null {
  if (views.length < 3) return null;
  for (const v of views) if (v.world.length < 4 || v.world.length !== v.image.length) return null;

  const homographies: number[][] = [];
  for (const v of views) {
    const H = estimateHomography(v.world, v.image);
    if (!H) return null;
    homographies.push(H);
  }
  const K0 = closedFormIntrinsics(homographies);
  if (!K0) return null;

  const poses: ViewPose[] = [];
  for (const H of homographies) {
    const pose = poseFromHomography(H, K0);
    if (!pose) return null;
    poses.push(pose);
  }
  const d0 = initDistortion(K0, poses, views);

  // ---- Levenberg–Marquardt over [fx,fy,cx,cy,k1,k2,p1,p2,k3, poses…] ----
  const intrin: number[] = [K0.fx, K0.fy, K0.cx, K0.cy];
  const dist: number[] = d0.slice();
  const poseVecs = poses.map((p) => [...p.rvec, ...p.t]);

  const residuals = (): number[] => {
    const K: Intrinsics = { fx: intrin[0], fy: intrin[1], cx: intrin[2], cy: intrin[3] };
    const res: number[] = [];
    for (let v = 0; v < views.length; v++) {
      const pose: ViewPose = { rvec: poseVecs[v].slice(0, 3), t: poseVecs[v].slice(3, 6) };
      for (let i = 0; i < views[v].world.length; i++) {
        const p = projectPoint(K, dist, pose, views[v].world[i]);
        if (!p) {
          res.push(1e3, 1e3); // soft penalty for behind-camera points
          continue;
        }
        res.push(p[0] - views[v].image[i][0], p[1] - views[v].image[i][1]);
      }
    }
    return res;
  };

  const step = 1e-6;
  const params: number[][] = [intrin, dist, ...poseVecs];
  const setParams = (flat: number[]) => {
    let o = 0;
    for (let i = 0; i < params.length; i++) {
      for (let j = 0; j < params[i].length; j++) params[i][j] = flat[o++];
    }
  };
  const flatten = (): number[] => params.flat();
  const nParams = flatten().length;

  const cost = (r: number[]) => r.reduce((s, x) => s + x * x, 0);

  let lambda = 1e-3;
  let r = residuals();
  let c = cost(r);
  let converged = false;
  const maxIter = 60;
  for (let iter = 0; iter < maxIter && !converged; iter++) {
    // Numeric Jacobian (central difference), stored column-wise per
    // parameter, then JᵀJ and Jᵀr accumulated from the FULL matrix —
    // JtJ[p][q] = Σ_k J[k][p]·J[k][q] (parameter indices on both factors).
    const JtJ = new Array<number>(nParams * nParams).fill(0);
    const Jtr = new Array<number>(nParams).fill(0);
    const base = flatten();
    const nRes = r.length;
    const cols: Float64Array[] = [];
    for (let p = 0; p < nParams; p++) {
      const plus = base.slice();
      const minus = base.slice();
      const h = step * Math.max(1, Math.abs(base[p]));
      plus[p] += h;
      minus[p] -= h;
      setParams(plus);
      const rp = residuals();
      setParams(minus);
      const rm = residuals();
      setParams(base);
      const colJ = new Float64Array(nRes);
      for (let k = 0; k < nRes; k++) colJ[k] = (rp[k] - rm[k]) / (2 * h);
      cols.push(colJ);
    }
    for (let p = 0; p < nParams; p++) {
      let jtr = 0;
      for (let k = 0; k < nRes; k++) jtr += cols[p][k] * r[k];
      Jtr[p] = jtr;
      for (let q = p; q < nParams; q++) {
        let s = 0;
        for (let k = 0; k < nRes; k++) s += cols[p][k] * cols[q][k];
        JtJ[p * nParams + q] = s;
        JtJ[q * nParams + p] = s;
      }
    }
    // Damping + solve (JtJ + λ diag)δ = −Jtr
    const A = JtJ.slice();
    for (let p = 0; p < nParams; p++) A[p * nParams + p] *= 1 + lambda;
    const delta = solveSymmetric(A, Jtr.map((x) => -x), nParams);
    if (!delta) {
      lambda *= 10;
      if (lambda > 1e8) break;
      continue;
    }
    const before = c;
    const trial = base.map((x, i) => x + (delta[i] ?? 0));
    setParams(trial);
    const rt = residuals();
    const ct = cost(rt);
    if (ct < before && Number.isFinite(ct)) {
      const improvement = before - ct;
      c = ct;
      r = rt;
      lambda = Math.max(1e-9, lambda / 3);
      if (Math.sqrt(c / (r.length / 2)) < 1e-4 || improvement < 1e-10) converged = true;
    } else {
      setParams(base);
      lambda *= 10;
      if (lambda > 1e8) {
        converged = true; // stuck — keep the best estimate, flag it
      }
    }
  }

  const perImage: number[] = [];
  let idx = 0;
  for (const v of views) {
    let s = 0;
    for (let i = 0; i < v.world.length; i++) {
      s += r[idx] * r[idx] + r[idx + 1] * r[idx + 1];
      idx += 2;
    }
    perImage.push(Math.sqrt(s / v.world.length));
  }

  const K: Intrinsics = { fx: intrin[0], fy: intrin[1], cx: intrin[2], cy: intrin[3] };
  const estimate: CalibrationEstimate = {
    intrinsics: K,
    distortion: dist.slice(0, 5),
    poses: poseVecs.map((p) => ({ rvec: p.slice(0, 3), t: p.slice(3, 6) })),
    reprojectionErrorPx: Math.sqrt(c / (r.length / 2)),
    perImageErrorPx: perImage,
    converged,
  };
  const sane =
    estimate.intrinsics.fx > 0 &&
    estimate.intrinsics.fy > 0 &&
    Number.isFinite(estimate.reprojectionErrorPx ?? NaN) &&
    (estimate.reprojectionErrorPx ?? Infinity) < 1e6;
  return sane ? estimate : null;
}

/** Solves a symmetric linear system via Gaussian elimination. */
function solveSymmetric(A: number[], b: number[], n: number): number[] | null {
  const m = A.slice();
  const y = b.slice();
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r * n + col]) > Math.abs(m[piv * n + col])) piv = r;
    if (Math.abs(m[piv * n + col]) < 1e-14) return null;
    if (piv !== col) {
      for (let c2 = 0; c2 < n; c2++) {
        const t = m[col * n + c2];
        m[col * n + c2] = m[piv * n + c2];
        m[piv * n + c2] = t;
      }
      const t = y[col];
      y[col] = y[piv];
      y[piv] = t;
    }
    for (let r = col + 1; r < n; r++) {
      const f = m[r * n + col] / m[col * n + col];
      if (f === 0) continue;
      for (let c2 = col; c2 < n; c2++) m[r * n + c2] -= f * m[col * n + c2];
      y[r] -= f * y[col];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = y[r];
    for (let c2 = r + 1; c2 < n; c2++) s -= m[r * n + c2] * x[c2];
    x[r] = s / m[r * n + r];
  }
  return x.every(Number.isFinite) ? x : null;
}
