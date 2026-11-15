/**
 * Stage 3.2 — sampling-grid computation (pure).
 *
 * Both extraction modes produce an explicit list of seek positions in
 * source media time, derived from the validated video probe. The grid is
 * the honest core of "timestamp preservation" for the platform decoder:
 * every extracted frame records the position it was sampled at, and
 * nothing pretends a filename index or wall-clock time is a capture time.
 */

import type { ExtractionSettings } from "./models";

export interface SampleGrid {
  /** Seek positions in source media time, seconds, non-decreasing. */
  times_s: number[];
  warnings: string[];
}

/**
 * Computes the sampling grid.
 *
 * - time_interval: first frame at media start, then every `interval_s`.
 * - frame_rate:    every Nth average-frame step that approximates the
 *   requested rate; the ACTUAL per-frame media times of a variable-frame-
 *   rate source differ from the nominal grid, which is why the grid
 *   positions — not a nominal rate — are what provenance records.
 *
 * Both modes are capped by `max_frames`; hitting the cap adds a warning so
 * silent truncation is impossible.
 */
export function computeSampleGrid(
  durationS: number,
  startTimeS: number,
  settings: ExtractionSettings,
): SampleGrid {
  const warnings: string[] = [];
  const times: number[] = [];
  if (durationS <= 0) return { times_s: times, warnings };

  if (settings.mode === "time_interval") {
    const interval = settings.interval_s!;
    // Media time starts at the track's media composition start (edit list).
    for (let t = startTimeS; t <= durationS + startTimeS - 1e-6; t += interval) {
      times.push(round6(t));
      if (times.length >= settings.max_frames) {
        warnings.push(
          `max_frames cap reached (${settings.max_frames}); the remaining video was not sampled — widen the interval or raise the cap`,
        );
        break;
      }
    }
  } else {
    const fps = settings.target_fps!;
    // The probe's average frame rate turns a target rate into a frame step.
    // Without a measured rate this mode cannot position seeks honestly —
    // the caller must reject the job instead (validated upstream).
    const step = 1 / fps;
    for (let t = startTimeS, n = 0; t <= durationS + startTimeS - 1e-6; t += step, n++) {
      times.push(round6(t));
      if (times.length >= settings.max_frames) {
        warnings.push(
          `max_frames cap reached (${settings.max_frames}); the remaining video was not sampled — lower the target rate or raise the cap`,
        );
        break;
      }
    }
    const achieved = times.length / durationS;
    if (Math.abs(achieved - fps) / fps > 0.15) {
      warnings.push(
        `requested ${fps} fps but the grid yields ${achieved.toFixed(2)} fps over the media duration (seek-based sampling)`,
      );
    }
  }
  return { times_s: times, warnings };
}

/** File name for a frame, zero-padded so lexicographic order == index order. */
export function frameFileName(index0: number, format: "png" | "jpeg"): string {
  return `frame_${String(index0 + 1).padStart(6, "0")}.${format === "png" ? "png" : "jpg"}`;
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}
