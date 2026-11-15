# Stage 3.3 — Test results (software scope)

Environment: Linux sandbox, bun test runner against real `bun:sqlite`
databases; no physical device, no OpenCV, no emulator. **Nothing in this
document is a device result.**

## What was run

- `bun test tests/mobile` from `mining-scanner/` — **201 tests pass**
  (Stage 3.3 adds 31 on top of Stage 3.2's 170), ~806 assertions.
- `python3 -m unittest discover -s tests/python` — **57 tests pass**
  (schema/registry mirror checks including the v1.6 registry and
  camera-calibration schema v2).
- `bunx tsc --noEmit -p .` — clean; `runChecks` — clean.

## The test ground truth (synthetic, documented — never presented as real)

The calibration tests render their own checkerboard images from a fully
documented ground truth, so every number below has a known reference:

- K = {fx 610, fy 606, cx 322, cy 238} px, image 640×480;
- distortion `[k1 0.06, k2 −0.015, p1 0.0004, p2 −0.0006, k3 0]`;
- board 6×5 squares (5×4 = 20 inner corners), square size 1.4 mm
  (declared unit), 6 distinct target poses;
- images rendered with a mid-gray surround (see
  `tests/mobile/helpers/calibration-host.ts`) so the exposure gate tests
  image content, not the fixture background.

**Measured against this ground truth (synthetic images):**

- Detection finds all 20 inner corners on every fixture view; corner
  position error vs. the rendered ground truth ≤ **0.416 px**.
- The solver recovers the intrinsics to within test tolerances (fx, fy
  within 2 % of ground truth; cx, cy within a few pixels; k1 within
  0.02) with RMS reprojection error **well under 0.5 px** on the
  ground-truth correspondences; the downscaled (factor 2) lifecycle run
  lands at ≈ **0.12 px** RMS after rescaling to full resolution.
- A no-distortion fixture solves to zero distortion (all coefficients
  < 1e-3) — the solver does not hallucinate lens curvature.

## Scenarios exercised (bun)

- End-to-end success: 6 frames → CAL- record registered as an asset,
  `metadata/calibration.json` on disk, run row `done`, operation row
  `succeeded` with the real tool version and output asset id; record
  re-read from the database equals the written one.
- Per-image rejection with reasons: a blurred frame is rejected
  (`blur_high`) and the run still succeeds on the remaining frames with
  the rejection recorded in `frame_evaluations`; a near-duplicate frame
  is rejected (`duplicate_frame`).
- `insufficient_images`: too few frames ⇒ registered-then-failed run
  (auditable), no asset. `all_frames_rejected`: every image unsuitable ⇒
  failure, and the run's own output directory is removed.
- `output_exists`: a pre-existing output directory is refused and its
  contents (a sentinel file) are preserved byte-for-byte.
- Cancellation mid-evaluation: outcome `cancelled`, no asset, own
  outputs removed.
- Crash reconciliation: a stale `running` calibration becomes
  `interrupted` on next launch; no asset.
- Working scale: frames decoded at factor 2 ⇒ log records
  `working_downscale_factor: 2`, record carries full-resolution
  intrinsics (`fx` at full-res scale), image dims are the full 640×480.
- RMS gate: a configured 1e-6 px limit forces
  `computed_with_warnings` + `did_not_pass_configured_checks` with the
  warning naming the limit.
- Model refusals (schema-level): a computed record cannot claim
  `independently_validated`; a calibration record cannot claim any scale
  basis other than `none`; factory/imported sources cannot claim
  measured methods; distortion coefficient counts must match the model.
- COLMAP conversion round-trips (exact values, including refusals for
  `k3 ≠ 0` and `unspecified`).
- Rescale arithmetic and pose utilities against hand-computed values.

## NOT tested (stated plainly)

- **On-device execution** — the calibration service glue
  (`expo-file-system` io, SQLite via expo-sqlite) mirrors the Stage
  3.1/3.2 patterns that passed `runChecks`, but no phone has run it.
- **Real photographs** — all detection/solver numbers above are on
  synthetic renders. Real printed-board robustness (lighting, focus,
  motion, sensor noise, JPEG artifacts) is unmeasured here; the
  detector's honest-rejection design means hard real-world shots surface
  as rejections, not as wrong numbers.
- **OpenCV cross-validation** — the solver's outputs have not been
  compared against OpenCV (or any independent implementation) on the
  same data; every record's engine note says exactly this.
- Independent metric validation — not implemented anywhere in the
  pipeline by design (see [calibration-provenance.md](calibration-provenance.md)).
