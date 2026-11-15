# STAGE 3.3 — IMPLEMENTATION REPORT

Date: 2026-11-07 · Scope: camera calibration (known-target checkerboard)

## Verdict

**PARTIALLY COMPLETE — software scope implemented and tested; on-device
and real-world validation open.**

What exists and works (off-device): a genuine, pure-TypeScript Zhang
calibration pipeline wired into the app's data model, UI and registry,
with honest provenance and per-image quality evaluation, green against
201 bun + 57 Python tests and clean `runChecks`.

What does **not** exist: on-device execution (no device in this
environment), real-photograph robustness evidence (all numeric results
are on documented synthetic fixtures), and independent validation
against OpenCV or external ground truth (not implemented; records say
so). No camera parameter, accuracy figure or success state in this stage
is fabricated — the record schema, engine note and UI all state the
actual situation.

## What was built

- **Solver** (`src/calibration/zhang.ts`): DLT homographies, closed-form
  intrinsics (two-sided symmetric Jacobi eigensolver), distortion
  initialisation, joint Levenberg–Marquardt refinement of intrinsics +
  distortion + all poses. Recovered synthetic ground truth (fx/fy <2 %,
  RMS <0.5 px; downscaled lifecycle run ≈0.12 px).
- **Image analysis** (`src/calibration/image-analysis.ts`): saddle-point
  checkerboard detection (quadrant-phase score, NMS, parabola subpixel),
  exact-grid assembly with canonicalised labelling, aHash duplicate
  detection, Otsu, exposure/blur/contrast stats. 20/20 corners at ≤0.416
  px on fixtures; honest failure reasons elsewhere.
- **Decode + camera model** (`decode.ts`, `camera-model.ts`): PNG/JPEG
  decode with explicit working scale, K build/validation, exact
  OpenCV⇄COLMAP conversions with documented refusals.
- **Core** (`calibration-core.ts`): preflight gates (environment
  pre-registration, content post-registration), per-image suitability
  evaluation, working-scale consistency, quality gates, full-res
  rescaling (intrinsics × factor), atomic record write + one-transaction
  asset registration, cancellation, crash reconciliation.
- **Repository + migration v5** (`calibration-repository.ts`,
  `migrations.ts`): `camera_calibrations` table, run lifecycle in
  `processing_operations`, asset row in the same transaction as success.
- **Registry v1.6 + schema v2**: `camera_calibration` IMPLEMENTED with
  11 failure modes; `camera-calibration.schema.json` rewritten to mirror
  the zod models (`$defs` + `oneOf`), mirror tests enforce both sides.
- **Expo glue** (`src/calibration/calibration-service.ts`): the only
  expo-facing module — frame-set resolution, storage gate, output dirs,
  real app version as engine version, `reconcileInterruptedCalibrations`
  on launch. Never imported by tests.
- **UI** (`app/(tabs)/export.tsx`): Calibrate-camera card (frame set →
  camera label → target → run/progress/cancel), project calibration
  list, expandable CAL- asset rows with real record values.
- **Docs**: stage3.3-camera-calibration, camera-models,
  calibration-quality, calibration-provenance, colmap-camera-compatibility,
  stage3.3-test-results, this report; README, PLAN, data-exchange updated.

## Bugs found and fixed during test development

1. Grid assembly scaled a row-offset vector that already carried the
   spacing (predictions thousands of px away) — normalised before scaling.
2. Grid assembly assumed the seed was the top row; tilted views with an
   interior seed ran off the board — bidirectional row extension added.
3. Jacobi eigensolver applied only the column (right) rotation — the
   matrix never diagonalised; fixed to two-sided symmetric rotation.
4. Closed-form intrinsics v-vectors paired components within a column
   instead of pairing the two constraint columns; the `col()` helper
   returned rows; two appendix-B coefficients were swapped. Ground truth
   now recovered exactly.
5. LM normal equations conflated residual and parameter indices in
   `JᵀJ` — Jacobian stored column-wise per parameter instead.
6. The test fixture's own white background tripped the pipeline's
   overexposure gate — fixture re-rendered on mid-gray (documented).
7. Repository `markSucceeded` wrote the record where readers expected
   `{record}` — merged into the run row's meta_json.
8. `insufficient_images` moved after run registration (auditable failed
   run), matching the Stage 3.1/3.2 gate split.
9. Working-scale rescale divided by the downscale factor instead of
   multiplying — fx came out full/4; fixed and covered by a test.
10. Model refine added so computed/computed-with-warnings records can
    never claim `independently_validated` or a nonzero scale basis.

## Test status

- `bun test tests/mobile`: **201 pass** (31 new Stage 3.3).
- Python schema/registry suite: **57 pass**.
- `bunx tsc --noEmit -p .`: clean. `runChecks`: clean.
- Details and measured numbers: [stage3.3-test-results.md](stage3.3-test-results.md).

## Not run / open

- **On-device end-to-end** (record → extract → calibrate → review):
  needs a physical device — BLOCKED in this environment.
- **Real-photograph detection robustness**: needs a printed board and a
  camera — operator acceptance.
- **Independent (OpenCV / ground-truth) validation**: not implemented;
  every record states this in `engine.note` and `validation_status`.
- Stage 3.4 (Visual Tracking + Trajectory) is the declared next stage
  and has not been started.
