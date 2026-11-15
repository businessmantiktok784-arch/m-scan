# Calibration quality — per-image gates and run metrics

Every image in a calibration run is individually evaluated and either
accepted, accepted-with-warnings or rejected **with machine reasons**.
Nothing is silently dropped, silently resized or silently averaged in.
This document defines the gates (as implemented in
`src/calibration/calibration-core.ts` + `image-analysis.ts`) and the
quality metrics recorded on the `CAL-` record.

## Image suitability

`FrameSuitability.suitability ∈ { "accepted", "accepted_with_warnings",
"rejected", "not_evaluated" }` with per-frame `reasons[]` and the detected
corner count. Hard-rejection reasons:

| Reason | Gate (defaults) |
|---|---|
| `frame_file_missing` | file absent on disk |
| `image_format_mismatch` | extension vs. recorded format disagree |
| `image_decode_error` | bytes unreadable as the recorded format |
| `image_dimensions_mismatch` | full-resolution dims differ from the first accepted frame (one K must fit all views) |
| `blur_high` | Laplacian variance < `blur_variance_min` (default 40) |
| `low_contrast` | gray std < `contrast_std_min` (default 12) |
| `overexposed` / `underexposed` | fraction of pixels ≥250 / ≤5 above `overexposure_fraction_max` / `underexposure_fraction_max` (default 0.25 each), stride-sampled |
| `duplicate_frame` | 8×8 aHash Hamming distance to an already-accepted frame < `duplicate_hash_distance` (default 6) |
| `target_detection_failed` | no exact rows×cols corner grid found (includes ≈90° in-plane rotations — never silently relabelled) |

Soft warning (image still used, warning recorded on the record):
blur within 1–1.5× of the threshold.

All thresholds are **operator-configurable** per run
(`CalibrationRunSettings`), recorded verbatim in the run log; a gate
disabled by setting its threshold to 0 is visible in the log too. Decoding
at a bounded working scale (when configured) is explicit and gated —
see `working_scale_mismatch` in [camera-models.md](camera-models.md); no
silent resizing exists anywhere in the pipeline.

## Run metrics (on every CAL- record)

- `input_frames`, `frames_accepted`, `frames_rejected`,
  `frames_with_warnings` — the exact arithmetic, rejected frames carrying
  their reasons in `frame_evaluations`.
- `detected_points` — total corners actually used by the solver.
- `reprojection_error_px` — RMS over all accepted corners from the final
  refined solution (pixels, full-resolution scale); `null` only if the
  solver never produced an error (not reachable on success).
- `per_image_error_px` — RMS per accepted view (pose/target visibility
  diagnostics for the operator).
- `converged` — whether LM finished inside its iteration budget; running
  out records `computed_with_warnings`.
- `coverage_note` — measured statement of target-pose coverage: greedy
  clustering of solved target-plane normals (`orientation_buckets`,
  default 8 ⇒ ~23° resolution) plus translation spread around the image
  centre. Narrow coverage produces an explicit warning (e.g. "target
  orientation coverage is narrow") — it is stated, never hidden.

## The RMS quality gate

`max_reprojection_error_px` (default **2.0 px**): with subpixel-refined
corners of a printed checkerboard, RMS above ~2 px usually means detection
trouble, motion blur, or a lens model the data doesn't support. Exceeding
the gate ⇒ `calibration_status: "computed_with_warnings"` **and**
`validation_status: "did_not_pass_configured_checks"` with a warning
naming the limit. It never blocks registration — the record exists and
says what it is.

## What these checks are NOT

- They are not **independent validation**. Passing every gate means the
  solution is self-consistent on this data; it is never a claim of
  real-world accuracy. `validation_status` stays
  `passed_configured_checks` — the schema **rejects**
  `independently_validated` from a computed record (zod refine, test
  enforced). Independent validation requires comparing against external
  ground truth, which is not implemented.
- They are not a scale statement. See the scale rules: a calibration
  record always has `scale_status: "UNKNOWN"` (basis `none`).
