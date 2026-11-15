/**
 * Stage 3.3 — camera-calibration core (pure orchestration).
 *
 * Mirrors the Stage 3.2 extraction-core pattern: ALL file access and
 * database work is injected behind seams (CalibrationIo, RepoDb), so the
 * FULL lifecycle — preflight, per-image decode/evaluate/detect, solver,
 * quality gates, record writing, ONE-transaction registration — runs
 * unchanged on device (expo-file-system IO) and in bun tests (node fs).
 * There is deliberately no second implementation of the pipeline logic.
 *
 * Honesty rules enforced here:
 * - Images are decoded and evaluated ONE at a time (8 GB RAM discipline);
 *   each raster is released before the next image is read.
 * - A frame the detector cannot read is REJECTED with a machine-readable
 *   reason — corners are never guessed, never interpolated.
 * - Fewer accepted images than configured → failure (insufficient_images);
 *   zero accepted → all_frames_rejected. The solver is never fed garbage.
 * - The solver runs only on accepted frames; per-image and RMS reprojection
 *   errors are MEASURED from the actual corners, never assumed.
 * - Quality gates are the configured thresholds; a gate breach records
 *   computed_with_warnings + did_not_pass_configured_checks — never silent.
 * - Working-scale honesty: if decoding used a downscale factor, the same
 *   factor must apply to every accepted image and intrinsics are rescaled
 *   to full-resolution pixels before the record is written; the factor is
 *   recorded in the log.
 * - Calibration is pixel geometry: scale_status stays UNKNOWN (basis none).
 * - Success registers the CAL- asset in ONE transaction; failed or
 *   cancelled runs leave no asset behind and remove their output directory.
 * - Output directories are per-run (CAL-) and never overwritten.
 */
import type { RepoDb } from "../database/import-repository";
import { calibrationRepository } from "../database/calibration-repository";
import {
  calibrationRecordSchema,
  type CalibrationRunSettings,
  type CheckerboardTarget,
  type FrameSuitability,
  type CalibrationMetrics,
} from "./models";
import { detectCheckerboard, exposureStats, averageHash, hammingDistance, type GrayImage } from "./image-analysis";
import { decodeImage, formatFromPath } from "./decode";
import { calibrateZhang, rodrigues, type Correspondences, type ViewPose } from "./zhang";
import type { Intrinsics } from "./camera-model";
// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

export interface CalibrationIo {
  ensureDir(path: string): void;
  /** True when the path exists (file or directory). */
  exists(path: string): boolean;
  removeTree(path: string): void;
  md5(path: string): string | null;
  byteSize(path: string): number;
  /** Whole-file read (one image at a time; released by the caller's scope). */
  readBytes(path: string): Promise<Uint8Array>;
  writeJsonAtomic(path: string, value: unknown): void;
}

export interface CalibrationFrameInput {
  frame_id: string;
  /** Absolute path of the stored frame image. */
  abs_path: string;
  /** Project-relative path (for records). */
  rel_path: string;
  image_format: "png" | "jpeg";
  width: number | null;
  height: number | null;
  checksum_md5: string | null;
  source_video_asset_id: string;
}

export interface CalibrationInput {
  calibration_id: string;
  project_id: string;
  session_id: string | null;
  camera_label: string;
  target: CheckerboardTarget;
  frames: CalibrationFrameInput[];
  settings: CalibrationRunSettings;
  /** Absolute base directory for outputs: .../calibrations/{calibration_id}. */
  output_dir_abs: string;
  /** Free storage in bytes, or 0 when it cannot be verified. */
  free_bytes: number;
  /** Real app version of the host — recorded as the engine version. */
  app_version: string;
}

export interface CalibrationHooks {
  onStage?: (stage: "preflight" | "evaluating" | "solving" | "finalizing" | "done", label: string) => void;
  onProgress?: (framesDone: number, framesTotal: number) => void;
  shouldCancel?: () => boolean;
}

export type CalibrationOutcome =
  | { kind: "succeeded"; calibration_id: string; warnings: string[]; reprojection_error_px: number | null }
  | { kind: "cancelled"; calibration_id: string }
  | { kind: "failed"; calibration_id: string; code: string; message: string };

/** Same storage headroom rule as capture/import/extraction. */
export const MIN_FREE_BYTES = 200 * 1024 * 1024;
/** Worst-case per-image estimate used ONLY for the free-space gate. */
const ESTIMATED_BYTES_PER_IMAGE = 12 * 1024 * 1024;
/** Greedy pose-orientation clustering threshold, derived from the setting. */
function orientationThresholdDeg(buckets: number): number {
  return 180 / buckets;
}

// ---------------------------------------------------------------------------

export async function runCalibration(
  input: CalibrationInput,
  db: RepoDb,
  io: CalibrationIo,
  hooks: CalibrationHooks = {},
): Promise<CalibrationOutcome> {
  const startedAt = new Date().toISOString();
  const startedMonoS = Date.now() / 1000;
  const warnings: string[] = [];
  const errors: string[] = [];

  /** Set once the pipeline has created the output directory itself; a
   *  pre-existing directory found by the output_exists guard must NEVER be
   *  deleted (it belongs to a previous run). */
  let outputCreated = false;

  const fail = async (code: string, message: string): Promise<CalibrationOutcome> => {
    errors.push(`${code}: ${message}`);
    const finishedAt = new Date().toISOString();
    if (outputCreated) io.removeTree(input.output_dir_abs); // failed runs leave nothing behind
    await calibrationRepository.markFailed(db, {
      calibrationId: input.calibration_id,
      status: "failed",
      message: `${code}: ${message}`,
      warnings,
      errors,
      finishedAt,
    });
    hooks.onStage?.("done", "failed");
    return { kind: "failed", calibration_id: input.calibration_id, code, message };
  };

  const cancelled = async (): Promise<CalibrationOutcome> => {
    const finishedAt = new Date().toISOString();
    if (outputCreated) io.removeTree(input.output_dir_abs);
    await calibrationRepository.markFailed(db, {
      calibrationId: input.calibration_id,
      status: "cancelled",
      message: "cancelled by operator",
      warnings,
      errors,
      finishedAt,
    });
    hooks.onStage?.("done", "cancelled");
    return { kind: "cancelled", calibration_id: input.calibration_id };
  };

  // ---- preflight ----------------------------------------------------------
  hooks.onStage?.("preflight", "checking storage");
  if (io.exists(input.output_dir_abs)) {
    return fail("output_exists", `output directory already exists — calibrations are never overwritten (${input.output_dir_abs})`);
  }
  const estimatedBytes = input.frames.length * ESTIMATED_BYTES_PER_IMAGE;
  if (input.free_bytes !== 0 && input.free_bytes < Math.max(MIN_FREE_BYTES, estimatedBytes)) {
    return fail(
      "insufficient_storage",
      `free storage ${(input.free_bytes / 1e9).toFixed(2)} GB is below the calibration estimate ${(
        Math.max(MIN_FREE_BYTES, estimatedBytes) / 1e9
      ).toFixed(2)} GB`,
    );
  }

  // ---- register the run before any image is decoded ------------------------
  await calibrationRepository.beginCalibration(db, {
    calibrationId: input.calibration_id,
    projectId: input.project_id,
    sessionId: input.session_id,
    cameraLabel: input.camera_label,
    outputDir: input.output_dir_abs,
    settings: input.settings,
    target: input.target,
    frameCount: input.frames.length,
    startedAt,
  });

  // Content gate AFTER registration: an attempted run with too few frames is
  // a real, auditable failure (environment gates above stay pre-registration,
  // matching the Stage 3.1/3.2 pattern).
  if (input.frames.length < input.settings.min_images) {
    return await fail(
      "insufficient_images",
      `only ${input.frames.length} frame(s) supplied; the configured minimum is ${input.settings.min_images}`,
    );
  }

  const metadataDir = `${input.output_dir_abs}/metadata`;
  const logsDir = `${input.output_dir_abs}/logs`;
  io.ensureDir(metadataDir);
  io.ensureDir(logsDir);
  outputCreated = true;

  // ---- evaluate every image (one at a time) --------------------------------
  hooks.onStage?.("evaluating", `${input.frames.length} frame(s)`);
  const evaluations: FrameSuitability[] = [];
  const accepted: { frame: CalibrationFrameInput; view: Correspondences; downscale: number; hash: bigint; corners: [number, number][] }[] = [];
  const seenHashes: { hash: bigint; frameId: string }[] = [];
  let referenceDims: { w: number; h: number } | null = null; // full-resolution dims of the first accepted frame

  for (let i = 0; i < input.frames.length; i++) {
    if (hooks.shouldCancel?.()) return cancelled();
    const frame = input.frames[i];
    const reasons: string[] = [];
    let suitability: FrameSuitability["suitability"] = "accepted";
    let detectedCorners: number | null = null;
    let decoded: { image: GrayImage; downscale: number } | null = null;

    try {
      if (!io.exists(frame.abs_path)) {
        reasons.push("frame_file_missing");
      } else if (formatFromPath(frame.abs_path) !== frame.image_format) {
        reasons.push("image_format_mismatch");
      } else {
        const bytes = await io.readBytes(frame.abs_path);
        decoded = decodeImage(bytes, frame.image_format, input.settings.max_working_dimension_px);
        // `bytes` goes out of scope here; the raster is released after use below.
      }
      if (reasons.length === 0 && !decoded) reasons.push("image_decode_error");

      if (decoded && reasons.length === 0) {
        // Full-resolution dimension consistency (one K for all views).
        const fullW = decoded.image.width * decoded.downscale;
        const fullH = decoded.image.height * decoded.downscale;
        if (!referenceDims) referenceDims = { w: fullW, h: fullH };
        else if (fullW !== referenceDims.w || fullH !== referenceDims.h) {
          reasons.push("image_dimensions_mismatch");
        }

        if (reasons.length === 0) {
          const stats = exposureStats(decoded.image);
          if (input.settings.blur_variance_min > 0 && stats.blurVariance < input.settings.blur_variance_min) {
            reasons.push("blur_high");
          } else if (input.settings.blur_variance_min > 0 && stats.blurVariance < input.settings.blur_variance_min * 1.5) {
            warnings.push(`[${frame.frame_id}] blur close to the configured threshold (Laplacian variance ${stats.blurVariance.toFixed(1)})`);
            suitability = "accepted_with_warnings";
          }
          if (input.settings.contrast_std_min > 0 && stats.std < input.settings.contrast_std_min) {
            reasons.push("low_contrast");
          }
          if (stats.overFraction > input.settings.overexposure_fraction_max) reasons.push("overexposed");
          if (stats.underFraction > input.settings.underexposure_fraction_max) reasons.push("underexposed");

          // Duplicate detection against every previously ACCEPTED image.
          const hash = averageHash(decoded.image);
          for (const seen of seenHashes) {
            if (hammingDistance(hash, seen.hash) < input.settings.duplicate_hash_distance) {
              reasons.push("duplicate_frame");
              warnings.push(`[${frame.frame_id}] near-duplicate of an earlier accepted frame (${seen.frameId})`);
              break;
            }
          }

          if (reasons.length === 0) {
            const detection = detectCheckerboard(decoded.image, input.settings.target.corner_rows, input.settings.target.corner_columns);
            if (!detection.board) {
              reasons.push(detection.reason ?? "target_detection_failed");
            } else {
              detectedCorners = detection.board.corners.length;
              const view = boardToView(detection.board.corners, detection.board.rows, detection.board.cols, input.settings.target.square_size);
              accepted.push({ frame, view, downscale: decoded.downscale, hash, corners: detection.board.corners });
              seenHashes.push({ hash, frameId: frame.frame_id });
            }
          } else {
            suitability = "rejected";
          }
        }
        if (reasons.length > 0) suitability = "rejected";
      }
      if (reasons.length > 0) suitability = "rejected";
    } catch (err) {
      reasons.push("image_decode_error");
      warnings.push(`[${frame.frame_id}] evaluation error: ${err instanceof Error ? err.message : String(err)}`);
      suitability = "rejected";
    }

    evaluations.push({
      frame_id: frame.frame_id,
      file_path: frame.rel_path,
      suitability,
      reasons,
      detected_corners: detectedCorners,
    });
    hooks.onProgress?.(i + 1, input.frames.length);
  }

  if (accepted.length === 0) {
    return fail("all_frames_rejected", `no frame was suitable (${summarizeReasons(evaluations)})`);
  }
  if (accepted.length < input.settings.min_images) {
    return fail(
      "insufficient_images",
      `${accepted.length} frame(s) accepted, below the configured minimum ${input.settings.min_images} (${summarizeReasons(evaluations)})`,
    );
  }

  // ---- working-scale honesty: every accepted image must share one factor ----
  const downscale = accepted[0].downscale;
  for (const a of accepted) {
    if (a.downscale !== downscale) {
      return fail(
        "working_scale_mismatch",
        "accepted frames decoded at different working scales — intrinsics could not be rescaled consistently; rerun with a fixed max_working_dimension_px",
      );
    }
  }

  // ---- solve ----------------------------------------------------------------
  hooks.onStage?.("solving", `${accepted.length} accepted view(s)`);
  if (hooks.shouldCancel?.()) return cancelled();
  const estimate = calibrateZhang(accepted.map((a) => a.view));
  if (!estimate) {
    return fail("degenerate_target_layout", "the accepted views do not constrain intrinsics (degenerate target layout or parallel target planes)");
  }

  // Pose-variation diagnostics, measured from the actual solution.
  const poseWarnings = poseVariationWarnings(estimate.poses, input.settings.orientation_buckets, input.settings.target.square_size);
  warnings.push(...poseWarnings);

  // ---- quality gates (configured, never silent) -----------------------------
  const rms = estimate.reprojectionErrorPx;
  let calibrationStatus: "computed" | "computed_with_warnings" = "computed";
  let validationStatus: "passed_configured_checks" | "did_not_pass_configured_checks" = "passed_configured_checks";
  if (!estimate.converged) {
    calibrationStatus = "computed_with_warnings";
    warnings.push("solver hit its iteration budget without full convergence");
  }
  if (rms !== null && rms > input.settings.max_reprojection_error_px) {
    calibrationStatus = "computed_with_warnings";
    validationStatus = "did_not_pass_configured_checks";
    warnings.push(
      `RMS reprojection error ${rms.toFixed(3)} px exceeds the configured max_reprojection_error_px ${input.settings.max_reprojection_error_px}`,
    );
  }

  // ---- rescale intrinsics from working pixels to full-resolution pixels -----
  // A working image at 1/downscale of full size has focal lengths and a
  // principal point at 1/downscale of the full-resolution pixel values, so
  // recovering full-resolution intrinsics MULTIPLIES by the factor.
  const k: Intrinsics = estimate.intrinsics;
  const record = calibrationRecordSchema.parse({
    calibration_id: input.calibration_id,
    project_id: input.project_id,
    session_id: input.session_id,
    camera_label: input.camera_label,
    image_width: referenceDims?.w ?? Math.round(k.cx * downscale * 2),
    image_height: referenceDims?.h ?? Math.round(k.cy * downscale * 2),
    fx: k.fx * downscale,
    fy: k.fy * downscale,
    cx: k.cx * downscale,
    cy: k.cy * downscale,
    model: "opencv_radial_tangential_k1_k2_p1_p2_k3",
    distortion: estimate.distortion,
    source: "estimated_from_capture",
    calibration_method: "known_target_checkerboard",
    created_at: new Date().toISOString(),
    engine: {
      tool: "mining-scanner calibration core (pure TypeScript Zhang)",
      tool_version: input.app_version,
      note:
        "On-device implementation. OpenCV is NOT available in this environment (native modules are not installable), so Zhang's method is implemented in pure TypeScript: DLT homographies, closed-form intrinsics, distortion initialisation and joint Levenberg–Marquardt refinement. Not independently validated against OpenCV on the same data.",
    },
    metrics: {
      input_frames: input.frames.length,
      frames_accepted: accepted.length,
      frames_rejected: evaluations.filter((e) => e.suitability === "rejected").length,
      frames_with_warnings: evaluations.filter((e) => e.suitability === "accepted_with_warnings").length,
      detected_points: accepted.reduce((s, a) => s + a.view.image.length, 0),
      reprojection_error_px: rms,
      per_image_error_px: estimate.perImageErrorPx,
      coverage_note: coverageNote(accepted.flatMap((a) => a.corners), decodedDims(input, referenceDims, downscale)),
      converged: estimate.converged,
    },
    target_config: input.settings.target,
    source_frame_ids: accepted.map((a) => a.frame.frame_id),
    source_video_asset_ids: [...new Set(accepted.map((a) => a.frame.source_video_asset_id))],
    frame_evaluations: evaluations,
    factory_provenance: null,
    import_provenance: null,
    calibration_status: calibrationStatus,
    validation_status: validationStatus,
    scale_status: "UNKNOWN",
    scale_provenance: {
      basis: "none",
      detail:
        "Camera calibration fixes intrinsics in PIXELS only. The target's square_size unit is the operator's declared unit and never propagates to a scene-scale claim; independent metric evidence is required elsewhere.",
    },
    coordinate_convention:
      "opencv_pinhole: x right, y down, z forward from camera; K row-major [[fx,0,cx],[0,fy,cy],[0,0,1]]; distortion [k1,k2,p1,p2,k3] on normalized coordinates",
    operation_id: input.calibration_id,
    warnings,
    errors,
  });

  // ---- finalize: record file + ONE-transaction registration ------------------
  hooks.onStage?.("finalizing", "writing calibration record");
  const finishedAt = new Date().toISOString();
  try {
    io.writeJsonAtomic(`${metadataDir}/calibration.json`, record);
    io.writeJsonAtomic(`${logsDir}/calibration-log.json`, {
      calibration_id: record.calibration_id,
      settings: input.settings,
      engine: record.engine,
      metrics: record.metrics,
      frame_evaluations: evaluations,
      working_downscale_factor: downscale,
      started_at: startedAt,
      finished_at: finishedAt,
      processing_duration_s: Date.now() / 1000 - startedMonoS,
      warnings,
      errors,
    });
    await calibrationRepository.markSucceeded(db, {
      record,
      workingDirBytes: totalBytes(io, input.output_dir_abs),
      finishedAt,
    });
  } catch (err) {
    return fail("registration_failed", `writing calibration records failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  hooks.onStage?.("done", "finished");
  return {
    kind: "succeeded",
    calibration_id: record.calibration_id,
    warnings,
    reprojection_error_px: rms,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** World-plane correspondences for a detected board (row-major corners). */
function boardToView(
  corners: [number, number][],
  rows: number,
  cols: number,
  squareSize: number,
): Correspondences {
  const world: [number, number][] = [];
  const image: [number, number][] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      world.push([c * squareSize, r * squareSize]);
      image.push(corners[r * cols + c]);
    }
  }
  return { world, image };
}

/**
 * Orientation clustering of the solved target-plane normals (third column of
 * each rotation, sign-normalised) plus a translation-spread check. Returns
 * human-readable warnings; empty when coverage is good.
 */
function poseVariationWarnings(poses: ViewPose[], buckets: number, squareSize: number): string[] {
  const out: string[] = [];
  const threshold = orientationThresholdDeg(buckets) * (Math.PI / 180);
  const normals: [number, number, number][] = poses.map((p) => {
    const R = rodrigues(p.rvec);
    // Target-plane normal (world +z) in camera coordinates: third COLUMN of R.
    const n = [R[2], R[5], R[8]];
    return [n[0], n[1], n[2]];
  });
  const reps: [number, number, number][] = [];
  for (const n of normals) {
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    const u = [n[0] / len, n[1] / len, n[2] / len];
    const aligned = reps.find((r) => {
      const dot = Math.abs(r[0] * u[0] + r[1] * u[1] + r[2] * u[2]); // sign-agnostic: a plane has no arrow
      return Math.acos(Math.min(1, dot)) < threshold;
    });
    if (!aligned) reps.push([u[0], u[1], u[2]]);
  }
  if (reps.length < 3) {
    out.push(
      `target orientation coverage is narrow (${reps.length} distinct orientation cluster(s) at ${((threshold * 180) / Math.PI).toFixed(0)}° resolution) — tilt the board more for a stronger calibration`,
    );
  }
  // Translation spread in target-size units.
  let maxDist = 0;
  for (let i = 0; i < poses.length; i++)
    for (let j = i + 1; j < poses.length; j++) {
      const d = Math.hypot(poses[i].t[0] - poses[j].t[0], poses[i].t[1] - poses[j].t[1], poses[i].t[2] - poses[j].t[2]);
      maxDist = Math.max(maxDist, d);
    }
  if (maxDist < 2 * squareSize) {
    out.push("camera barely moved relative to the target (translation spread under two square sizes) — depth estimate is weak");
  }
  return out;
}

/** Coverage note: where the target sat in the frame across accepted views. */
function coverageNote(cornersPerPixel: [number, number][], dims: { w: number; h: number } | null): string {
  if (!dims || cornersPerPixel.length === 0) return "coverage not computed";
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of cornersPerPixel) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const spanX = (maxX - minX) / dims.w;
  const spanY = (maxY - minY) / dims.h;
  return `detected corners span ${(spanX * 100).toFixed(0)}% × ${(spanY * 100).toFixed(0)}% of the frame across accepted views (full-frame and edge positions give a better distortion estimate)`;
}

function decodedDims(
  input: CalibrationInput,
  referenceDims: { w: number; h: number } | null,
  downscale: number,
): { w: number; h: number } | null {
  if (referenceDims) return { w: referenceDims.w, h: referenceDims.h };
  const first = input.frames.find((f) => f.width && f.height);
  if (!first) return null;
  void downscale;
  return { w: first.width as number, h: first.height as number };
}

function summarizeReasons(evaluations: FrameSuitability[]): string {
  const counts = new Map<string, number>();
  for (const e of evaluations) for (const r of e.reasons) counts.set(r, (counts.get(r) ?? 0) + 1);
  return [...counts.entries()].map(([r, n]) => `${r}×${n}`).join(", ") || "no reasons recorded";
}

function totalBytes(io: CalibrationIo, dir: string): number {
  // The asset row's byte_size is the calibration.json + log size; frame bytes
  // live in the frames table (image bytes are never copied into the run dir).
  let total = 0;
  for (const f of [`${dir}/metadata/calibration.json`, `${dir}/logs/calibration-log.json`]) {
    try {
      if (io.exists(f)) total += io.byteSize(f);
    } catch {
      // best effort only
    }
  }
  return total;
}
