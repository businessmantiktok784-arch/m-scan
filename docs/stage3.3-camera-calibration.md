# Stage 3.3 — Camera calibration (known-target, on device)

Status: **IMPLEMENTED (software scope)** — `camera_calibration` is marked
IMPLEMENTED in the operation registry (v1.6), running on device from real
Stage 3.2 frames. Verification on a physical device has NOT been done in
this environment (see [stage3.3-test-results.md](stage3.3-test-results.md)).

Stage 3.3 estimates a camera's intrinsics and lens distortion from frames
of a **printed checkerboard** filmed during normal capture. Everything
downstream (tracking, reconstruction) consumes the `CAL-` record this
stage produces. Honesty constraints that shaped every decision:

- **OpenCV is NOT available on device.** Native modules cannot be installed
  in this environment. Zhang's method is therefore implemented in **pure
  TypeScript** inside this repository, and every calibration record's
  engine block says exactly that — including that the result is **not
  independently validated** against OpenCV on the same data.
- **Calibration is pixel geometry.** It fixes `fx, fy, cx, cy` and the
  distortion coefficients in pixels. It never establishes scene scale:
  `scale_status` stays `UNKNOWN` (basis `none`), always.
- Factory-assumed (Method B) and operator-imported (Method C) parameters
  exist as declared provenance paths in the contract — a record may only
  ever say `source: "estimated_from_capture"` when the images were actually
  measured (see [calibration-provenance.md](calibration-provenance.md)).

## Pipeline (one implementation, three injected seams)

`runCalibration` in `src/calibration/calibration-core.ts` is pure
orchestration. File access (`CalibrationIo`), the database (`RepoDb`) and
the frame list itself are injected — the identical pipeline runs on device
(expo glue in `src/calibration/calibration-service.ts`) and in bun tests
against a real SQLite database and rendered checkerboard images.

1. **Preflight (environment gates, pre-registration)** — the output
   directory must not exist (`output_exists`; a pre-existing directory is
   never deleted) and free storage must cover 200 MB headroom plus a
   worst-case per-image estimate (`insufficient_storage`).
2. **Register the run** — `processing_operations` + `camera_calibrations`
   rows (`running`, settings and target draft in `meta_json`) are written
   before any image is decoded. A crash is reconciled to `interrupted` on
   next launch. The **content gate** (`insufficient_images` for too few
   frames) comes *after* registration: an attempted run with too few
   frames is a real, auditable failure, not a non-event.
3. **Evaluate every image** (one at a time; raster released between
   frames) — file exists, format matches the frame record, decodes at the
   configured working scale, then the suitability gates of
   [calibration-quality.md](calibration-quality.md): blur, contrast,
   exposure, near-duplicate hash and finally checkerboard detection with
   the operator-declared grid shape. Rejections carry machine reasons and
   are recorded per frame — never silently dropped.
4. **Solve (Zhang 2000)** — per-view DLT homographies → closed-form
   intrinsics over all views → distortion initialisation → pose per view →
   joint Levenberg–Marquardt refinement of intrinsics, distortion and all
   poses against every detected corner. Details and the exact engine
   internals: [camera-models.md](camera-models.md).
5. **Quality gate + rescale + finalize** — the final RMS reprojection
   error is compared against the configured `max_reprojection_error_px`
   (default 2 px); exceeding it yields `computed_with_warnings` +
   `did_not_pass_configured_checks`, never a silent pass. Working-scale
   factor (downsampled decode) is rescaled back to full-resolution
   intrinsics — focal lengths and principal point **multiply** by the
   factor, distortion is scale-invariant — and recorded in the run log.
   `calibration.json` is written atomically, then in **one transaction**
   the `assets` row (kind `camera_calibration`, asset_id = calibration_id)
   and the `done` flips commit. A failed, cancelled or interrupted run
   registers no asset and leaves only directories it created itself.

## Output layout (per calibration, never overwritten)

```
projects/<MS-xxxx>/calibrations/<CAL-xxxx>/
├── metadata/   calibration.json (the full CAL- record)
└── logs/       calibration-log.json (settings, per-frame evaluations,
                 working downscale factor, timings, warnings, errors)
```

The SQLite row mirrors the record (meta_json), and `getCalibration` /
`listCalibrations` read it back; the asset row carries the same record so
the Media & Export screen shows real values only.

## Detection (the findChessboardCorners replacement)

A saddle-point ("X-corner") detector: a checkerboard inner corner is where
the two diagonal neighbourhood pairs have opposite, near-uniform phases
(quadrant means in a disc, non-maximum suppression, parabola subpixel
refinement on the score field). The strongest candidate seeds an exact
rows×cols grid assembled by step-chaining and parallelogram snapping; the
assembled grid is canonicalised (rows top-to-bottom by mean y, corners
left-to-right by x) so the world-point assignment is consistent across
views while the board stays within ±90° in-plane rotation.

Known, documented limitations: boards rotated ≈90° in-plane **fail
detection honestly** (`target_detection_failed`) rather than being
silently relabelled; the detector targets well-lit, reasonably sharp
boards — images it cannot read are rejected and counted, never
approximated. This is not OpenCV's adaptive multi-scale implementation.

## Failure modes (registry v1.6)

`output_exists`, `insufficient_storage`, `frame_file_missing`,
`image_format_mismatch`, `image_decode_error`, `all_frames_rejected`,
`insufficient_images`, `working_scale_mismatch`,
`degenerate_target_layout`, `registration_failed`,
`factory_values_unavailable`. Cancellation is a distinct outcome.

## UI

The Media & Export tab has a **Calibrate camera** card: frame-set picker
(completed `JOB-` sets only) → camera label → target description (inner
corner columns × rows, square size with unit, board identification) →
stage + progress + cancel. Computed calibrations for the project are
listed under the card, and every `CAL-` asset appears as an expandable row
with the real record: image size, `fx/fy/cx/cy`, distortion vector, frame
counts, engine identity — and the standing label *computed, not
independently validated; no scene scale claimed*.

## Out of scope

`visual_tracking` and everything downstream remain NOT_IMPLEMENTED.
Calibration produces camera geometry only; it consumes Stage 3.2 frame
sets and claims nothing about the world's size or position.
