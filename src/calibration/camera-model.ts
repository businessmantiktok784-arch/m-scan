/**
 * Stage 3.3 — camera model: intrinsics construction, validation and the
 * OpenCV ↔ COLMAP parameter conversions (pure math, no platform imports).
 *
 * Conventions (binding for every record this app emits):
 * - Pixel coordinates: origin at the top-left of the top-left pixel CENTRE
 *   is (0,0); x right, y down.
 * - Camera frame: +Z forward (out of the lens), +x right, +y down.
 * - K is row-major [[fx, 0, cx], [0, fy, cy], [0, 0, 1]].
 * - Distortion uses the OpenCV (r = sqrt(x²+y²) on NORMALISED coordinates):
 *      x_d = x(1 + k1 r² + k2 r⁴ + k3 r⁶) + 2 p1 x y + p2 (r² + 2 x²)
 *      y_d = y(1 + k1 r² + k2 r⁴ + k3 r⁶) + p1 (r² + 2 y²) + 2 p2 x y
 *   Coefficient order: [k1, k2, p1, p2, k3].
 * - COLMAP stores models as flat parameter lists in ITS OWN order; the
 *   conversions below are exact where the target model can represent the
 *   source, and refuse (never approximate) where it cannot.
 */

import type { DistortionModel } from "./models";

export interface Intrinsics {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
}

/** Row-major 3×3. */
export function buildK(i: Intrinsics): number[] {
  return [i.fx, 0, i.cx, 0, i.fy, i.cy, 0, 0, 1];
}

export function validateIntrinsics(
  i: Intrinsics,
  width: number,
  height: number,
): string[] {
  const problems: string[] = [];
  if (!(i.fx > 0) || !Number.isFinite(i.fx)) problems.push("fx must be positive and finite");
  if (!(i.fy > 0) || !Number.isFinite(i.fy)) problems.push("fy must be positive and finite");
  if (!Number.isFinite(i.cx) || i.cx < 0) problems.push("cx must be finite and non-negative");
  if (!Number.isFinite(i.cy) || i.cy < 0) problems.push("cy must be finite and non-negative");
  // Principal point far outside the sensor is almost never legitimate.
  if (i.cx > width * 1.5 || i.cy > height * 1.5) {
    problems.push("principal point lies far outside the image — likely a unit or convention error");
  }
  return problems;
}

/** Distortion coefficient count implied by a model, where fixed. */
export function expectedCoefficientCount(model: DistortionModel): number | null {
  switch (model) {
    case "opencv_radial_tangential_k1_k2_p1_p2_k3":
      return 5;
    case "none":
      return 0;
    case "unspecified":
      return null; // vendor-defined; recorded, not reinterpreted
  }
}

/**
 * Undistorts one normalised point one Newton step per iteration — used by
 * tests to round-trip project → distort → undistort against known values.
 */
export function distortNormalized(
  x: number,
  y: number,
  d: number[],
): { x: number; y: number } {
  const [k1, k2, p1, p2, k3] = [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0, d[3] ?? 0, d[4] ?? 0];
  const r2 = x * x + y * y;
  const radial = 1 + k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2;
  const xy = x * y;
  return {
    x: x * radial + 2 * p1 * xy + p2 * (r2 + 2 * x * x),
    y: y * radial + p1 * (r2 + 2 * y * y) + 2 * p2 * xy,
  };
}

// ---------------------------------------------------------------------------
// OpenCV ↔ COLMAP conversions
// ---------------------------------------------------------------------------

export type ColmapModel =
  | "SIMPLE_PINHOLE" // f, cx, cy
  | "PINHOLE" // fx, fy, cx, cy
  | "SIMPLE_RADIAL" // f, cx, cy, k
  | "RADIAL" // f, cx, cy, k1, k2
  | "OPENCV"; // fx, fy, cx, cy, k1, k2, p1, p2

export interface ColmapCamera {
  model: ColmapModel;
  width: number;
  height: number;
  params: number[];
}

export interface ConversionResult {
  ok: boolean;
  camera: ColmapCamera | null;
  /** Why the conversion was refused / what it preserves. */
  note: string;
}

const OPENCV_ORDER = [0, 1, 2, 3, 4]; // k1,k2,p1,p2,k3

/**
 * Converts this app's OpenCV-convention intrinsics to a COLMAP camera.
 *
 * Exactness rules (a refused conversion is NEVER silently approximated):
 * - PINHOLE / SIMPLE_PINHOLE: only when distortion is truly absent.
 * - SIMPLE_RADIAL / RADIAL: only when tangential p1 = p2 = 0 AND k3 = 0
 *   AND fy == fx (COLMAP's single f means square pixels).
 * - OPENCV: exact for k1,k2,p1,p2; k3 ≠ 0 has NO COLMAP equivalent in the
 *   CPU-supported model set — the conversion refuses with a documented
 *   limitation rather than dropping the coefficient.
 */
export function opencvToColmap(
  i: Intrinsics,
  distortion: number[],
  model: DistortionModel,
  width: number,
  height: number,
): ConversionResult {
  const d = [...distortion];
  while (d.length < 5) d.push(0);
  const [k1, k2, p1, p2, k3] = d;
  const distFree = k1 === 0 && k2 === 0 && p1 === 0 && p2 === 0 && k3 === 0;

  if (model === "unspecified") {
    return {
      ok: false,
      camera: null,
      note: "distortion model 'unspecified' (vendor parameters) has no defined COLMAP mapping — record the vendor model and convert on a documented basis, never automatically",
    };
  }

  if (model === "none" || distFree) {
    if (i.fx === i.fy) {
      return {
        ok: true,
        camera: { model: "SIMPLE_PINHOLE", width, height, params: [i.fx, i.cx, i.cy] },
        note: "no distortion; square pixels → SIMPLE_PINHOLE (exact)",
      };
    }
    return {
      ok: true,
      camera: { model: "PINHOLE", width, height, params: [i.fx, i.fy, i.cx, i.cy] },
      note: "no distortion → PINHOLE (exact)",
    };
  }

  if (k3 !== 0) {
    return {
      ok: false,
      camera: null,
      note: "k3 ≠ 0 is not representable in COLMAP's OPENCV model (which carries k1,k2,p1,p2 only); refit with k3 fixed at 0 or use a conversion that documents the dropped term — this conversion refuses instead of approximating",
    };
  }

  if (p1 !== 0 || p2 !== 0) {
    if (model === "opencv_radial_tangential_k1_k2_p1_p2_k3" && k1 === 0 && k2 === 0) {
      // Tangential-only is still exactly OPENCV in COLMAP.
      return {
        ok: true,
        camera: { model: "OPENCV", width, height, params: [i.fx, i.fy, i.cx, i.cy, k1, k2, p1, p2] },
        note: "tangential-only distortion → COLMAP OPENCV (exact)",
      };
    }
    return {
      ok: true,
      camera: { model: "OPENCV", width, height, params: [i.fx, i.fy, i.cx, i.cy, k1, k2, p1, p2] },
      note: "COLMAP OPENCV carries k1,k2,p1,p2 — exact (k3 was 0)",
    };
  }

  // Radial-only [k1, k2]: SIMPLE_RADIAL / RADIAL need a single focal length.
  if (i.fx !== i.fy) {
    return {
      ok: true,
      camera: { model: "OPENCV", width, height, params: [i.fx, i.fy, i.cx, i.cy, k1, k2, p1, p2] },
      note: "fx ≠ fy, so the square-pixel RADIAL models do not apply; COLMAP OPENCV is exact",
    };
  }
  if (k2 === 0) {
    return {
      ok: true,
      camera: { model: "SIMPLE_RADIAL", width, height, params: [i.fx, i.cx, i.cy, k1] },
      note: "single radial term, square pixels → SIMPLE_RADIAL (exact)",
    };
  }
  return {
    ok: true,
    camera: { model: "RADIAL", width, height, params: [i.fx, i.cx, i.cy, k1, k2] },
    note: "radial-only, square pixels → RADIAL (exact)",
  };
}

/**
 * Inverse direction for interop tests: a COLMAP camera back to this app's
 * OpenCV convention (fx, fy, cx, cy, [k1, k2, p1, p2, k3]).
 */
export function colmapToOpencv(c: ColmapCamera): { intrinsics: Intrinsics; distortion: number[] } | null {
  switch (c.model) {
    case "SIMPLE_PINHOLE": {
      const [f, cx, cy] = c.params;
      return { intrinsics: { fx: f, fy: f, cx, cy }, distortion: [] };
    }
    case "PINHOLE": {
      const [fx, fy, cx, cy] = c.params;
      return { intrinsics: { fx, fy, cx, cy }, distortion: [] };
    }
    case "SIMPLE_RADIAL": {
      const [f, cx, cy, k1] = c.params;
      return { intrinsics: { fx: f, fy: f, cx, cy }, distortion: [k1, 0, 0, 0, 0] };
    }
    case "RADIAL": {
      const [f, cx, cy, k1, k2] = c.params;
      return { intrinsics: { fx: f, fy: f, cx, cy }, distortion: [k1, k2, 0, 0, 0] };
    }
    case "OPENCV": {
      const [fx, fy, cx, cy, k1, k2, p1, p2] = c.params;
      return { intrinsics: { fx, fy, cx, cy }, distortion: [k1, k2, p1, p2, 0] };
    }
  }
}

/** Coefficient-order mapping reference for tests and documentation. */
export const OPENCV_TO_COLMAP_ORDER_NOTE =
  "OpenCV [k1,k2,p1,p2,k3] → COLMAP OPENCV [k1,k2,p1,p2] (k3 must be 0); COLMAP SIMPLE_RADIAL/RADIAL use a single f with k-only radial terms; nothing reorders silently.";

export const _ORDER_GUARD = OPENCV_ORDER; // re-exported for tests
