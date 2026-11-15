# Underground Mining Scanner — Master Plan

## Stage 3.3 — Camera calibration (COMPLETE, software scope)

- [x] Registry v1.6: `camera_calibration` IMPLEMENTED (mobile-or-desktop;
  depends on frame_extraction; failure modes output_exists,
  insufficient_storage, frame_file_missing, image_format_mismatch,
  image_decode_error, all_frames_rejected, insufficient_images,
  working_scale_mismatch, degenerate_target_layout, registration_failed,
  factory_values_unavailable); camera-calibration schema rewritten to v2
  (`$defs` + `oneOf`, mirrors the zod models) — TS↔JSON mirror
  test-enforced
- [x] Pure-TypeScript Zhang solver (no native modules; OpenCV documented
  NOT_AVAILABLE on device in every record's engine block): DLT
  homographies, closed-form intrinsics (two-sided symmetric Jacobi),
  distortion initialisation, joint Levenberg–Marquardt refinement of
  intrinsics + distortion + all poses; recovers documented synthetic
  ground truth (fx/fy <2 %, RMS <0.5 px; ≈0.12 px in the downscaled
  lifecycle run); COLMAP OpenCV↔app conversions exact-only with refusals
  (k3 ≠ 0, `unspecified` model)
- [x] Checkerboard detection in pure TS: saddle-point candidates (quadrant
  phase, NMS, parabola subpixel), exact-grid assembly with canonicalised
  row/column labelling (±90° in-plane consistency; ≈90° rotations fail
  honestly); 20/20 inner corners at ≤0.416 px on rendered fixtures;
  per-image suitability gates (blur, contrast, exposure, duplicate aHash,
  target detection) — rejections carry machine reasons, thresholds
  configurable and logged, no silent resizing
- [x] Pure calibration core (preflight environment gates → register run →
  evaluate every image → working-scale consistency → solve → RMS quality
  gate → full-res rescale (×factor) → atomic calibration.json +
  ONE-transaction asset registration); cancellation and crash
  reconciliation (`interrupted`); failed/cancelled runs leave no asset
  and remove only their own directories
- [x] Provenance honesty: `estimated_from_capture` records can never claim
  `independently_validated` (schema refine, test-enforced) or any scale
  basis other than `none`; factory-assumed and operator-imported remain
  declared contract paths labelled not_evaluated; scale_status stays
  UNKNOWN (calibration is pixel geometry)
- [x] Migration v5 (`camera_calibrations`), injectable RepoDb/CalibrationIo
  seams; run status kept separate from the record's computed/computed_with
  warnings; expo glue (`calibration-service.ts`, never imported by tests)
  resolves frames from completed frame sets, enforces the 200 MB storage
  headroom, reconciles stale runs on launch
- [x] UI: Calibrate-camera card (frame-set picker → camera label → target
  description → stage/progress/cancel), project calibration list,
  expandable CAL- asset rows with real record values
- [x] Tests: 201 bun + 57 Python green; tsc clean; runChecks clean; 10
  bugs found and fixed during test development (see
  docs/STAGE3.3_IMPLEMENTATION_REPORT.md)
- [x] Docs: stage3.3-camera-calibration, camera-models,
  calibration-quality, calibration-provenance,
  colmap-camera-compatibility, stage3.3-test-results,
  STAGE3.3_IMPLEMENTATION_REPORT (verdict: PARTIALLY COMPLETE —
  synthetic-fixture testing only, device NOT TESTED, no independent
  validation); README, PLAN, data-exchange (registry v1.6, schema v2)
  updated
- [ ] On-device calibration end-to-end (capture board video → extract →
  calibrate → review) — needs a physical device; BLOCKED here
- [ ] Real-photograph detection robustness + independent (OpenCV /
  ground-truth) validation — operator machine; records state
  not-validated until then

## Stage 3.2 — Frame extraction (COMPLETE, software scope)

- [x] Registry v1.5: `frame_extraction` IMPLEMENTED (mobile-or-desktop;
  failure modes video_unreadable, segment_missing, decode_error,
  no_video_stream, empty_extraction, output_exists, insufficient_storage,
  registration_failed); frame-extraction schema rewritten to v2 (`$defs` +
  `oneOf`, mirrors the zod models) — TS↔JSON mirror test-enforced
- [x] MP4 probe + streamed video validation hardened against real fixtures:
  tkhd track-id offset, display-matrix rotation element, edit-list raw
  values parsed before conversion (empty edits skipped), real
  `playback_duration_s` (elst segment duration) + `start_time_s` (media
  start, never flattened to zero); 12 regenerated fixtures with measured
  expected.json (nonzero start ≈2.5667 s, remuxed 270° rotation)
- [x] Pure extraction core (validate-everything-first → register job →
  sample grid → decode → verify (exists/non-empty/checksum) → register
  frames + ONE `frame_set` asset in one transaction); two sampling modes
  (`time_interval`, `frame_rate`), max_frames cap with explicit warning,
  cancellation, per-job outputs never overwritten; injectable
  RepoDb/ExtractionIo/FrameDecoder seams — no second implementation
- [x] Platform decoder (`expo-video-thumbnails` + `expo-image-manipulator`):
  seek-based, pts_ms/time_base null, capture_time_mapping "unavailable" with
  CAPTURE_TIME_DETAIL — never fabricated; FFmpeg on device NOT_AVAILABLE
  (ffmpeg-kit retired; native modules not installable) with documented
  FrameDecoder seam; host FFmpeg CLI decoder proves the pipeline in tests
- [x] Migration v4 (`frame_extractions`, `frames` with UNIQUE
  (job, source, index)); full job stored in meta_json at begin for crash
  recovery; `interruptStaleExtractions` reconciliation
- [x] UI: Extract-frames card (session → segments → mode/format → stage,
  progress, cancel) + expandable frame_set rows with real frame thumbnails
  and honest "pts: not reported by the decoder" labels
- [x] Tests: 170 bun (30 Stage 3.2 incl. real FFmpeg CLI + real SQLite + 12
  real MP4 fixtures) + 57 Python green; runChecks clean; bugs found by
  real-fixture testing fixed (job-global frame numbering, output_exists
  deletion guard, pre-finalize getExtraction, playback window)
- [x] Docs: stage3.2-frame-extraction, video-input-validation,
  frame-timestamp-provenance, frame-storage, ffmpeg-integration,
  stage3.2-test-results, STAGE3.2_IMPLEMENTATION_REPORT (verdict:
  PARTIALLY COMPLETE re FFmpeg; device NOT TESTED); README, PLAN,
  data-exchange (registry v1.5, schema v2) updated
- [ ] On-device extraction end-to-end (record → extract → review) — needs a
  physical device; BLOCKED here

## Stage 3.1 — External point-cloud import (COMPLETE, software scope)

- [x] Registry flipped: `pointcloud_import` IMPLEMENTED (registry v1.4,
  TS↔JSON mirror test-enforced) with failure modes — `unsupported_variant`,
  `file_too_large`, `insufficient_storage`, `import_interrupted`,
  `source_missing`; every other Stage 3 operation stays NOT_IMPLEMENTED
- [x] Pure streamed validators: PLY ascii/binary-LE (header window
  `max(chunkSize, 4096)`, carry-buffer record reads, colours/normals/faces
  recorded not decoded), XYZ (≥3 columns, colour-ambiguity warning), LAS
  1.0–1.4 header+VLR level (payload NOT decoded); LAZ / big-endian /
  vertex-not-first rejected as `unsupported_variant`; six distinct verdicts
  incl. `incomplete` and `not_verified`, cancellation between chunks,
  `checked_bytes` accounting
- [x] Import pipeline (`src/pointcloud/import-service.ts`, the only
  expo-facing module): document picker → preflight gates (extension, LAZ
  early reject, 2 GB cap, 200 MB free-space headroom) → register before
  copy → preserved copy → streamed validation → atomic finalize; failures
  clean up and never register
- [x] Migration v3: `processing_operations` + `pointcloud_imports`; injectable
  structural `RepoDb` (expo-sqlite on device, bun:sqlite in tests); success
  writes the `assets` row in the SAME transaction as the `succeeded` flip;
  no FK from imports to assets (documented); crash reconciliation to
  `interrupted` on next launch
- [x] pointcloud-asset schema v1.3 (backward compatible): `unit_unknown`,
  `source_documented`, optional `original_filename` + `content` block;
  imports always record units unknown and scale UNKNOWN (basis `none`)
  with an explicit explanatory detail
- [x] UI: import card (staged progress, cancel), expandable point-cloud asset
  rows with real metadata, `reconcileInterruptedImports()` on mount, export
  still honestly labelled PLANNED
- [x] Blender add-on v0.2.0: real PLY import operator (pure parser + sidecar
  provenance reader), coordinates as stored, honest no-sidecar warning,
  `analyze_mesh` still a stub
- [x] 26 synthetic fixtures regenerated (face-element header bug fixed) with
  documented exact values
- [x] Tests: 140 bun + 57 Python green; runChecks clean
- [x] Docs: stage3.1-pointcloud-import, pointcloud-formats,
  pointcloud-storage, pointcloud-validation, blender-pointcloud-import,
  stage3.1-test-results, STAGE3.1_IMPLEMENTATION_REPORT; README,
  data-exchange, blender-extension updated
- [ ] On-device import end-to-end (picker → validate → asset list) — needs a
  physical device; BLOCKED here
- [ ] Blender 5.1 install + import-operator acceptance — needs Blender; BLOCKED here
- [ ] Real-world external files acceptance (vendor scanner exports) — operator machine

## Stage 1 — Data foundation (COMPLETE, pending on-device verification)

- [x] Register Expo app `mining-scanner` (React Native, expo-router, TypeScript)
- [x] Theme + design tokens (dark industrial, amber/teal)
- [x] Pure zod models mirroring shared schemas (no react-native imports)
- [x] SQLite layer (WAL, FK, versioned migrations) + project repository
- [x] Engine seams: ScannerEngine / ScanAssetStore with honest unavailable stubs
- [x] Tri-state capability detection (null = unknown)
- [x] 4 screens: Projects / Live Scan / Review / Media & Export (no fake data anywhere)
- [x] Blender extension skeleton (manifest, panels, metadata loader, honest stub operators)
- [x] 6 shared JSON Schemas (draft 2020-12, v1)
- [x] Tests: 22 bun (models, migrations vs bun:sqlite, name edges) + 12 Python
  (schemas/add-on statics) — all green
- [x] Docs: architecture, data-exchange, blender-extension, README
- [x] App icon generated (amber tunnel arch + teal scan line)
- [x] STAGE1_REPORT.md (created/modified files, passed vs not-run tests, blockers)
- [x] Verification pass (sandbox): contract comparison, migration SQL vs bun:sqlite,
  honesty audit — 22 TS + 12 Python tests green, checks clean; bugs found & fixed
  (see STAGE1_REPORT.md)
- [ ] On-device SQLite + navigation verification (needs device/emulator — operator machine; BLOCKED here)
- [ ] Blender install/panel verification (needs Blender 5.1 — operator machine; BLOCKED here)

## Stage 2 — Capture & registration (COMPLETE, pending on-device verification)

- [x] Real offline capture: segmented muted camera video (expo-camera) +
  accelerometer/gyroscope/magnetometer JSONL streams (expo-sensors)
- [x] Capture-session lifecycle: pure state machine, DB satellite table
  (migration v2), single-active-capture guard, atomic manifests
- [x] Storage: session directory tree, checksums, dual-clock timestamps,
  200 MB free-space gate (see docs/capture-pipeline.md)
- [x] Capability probing upgraded to 5 explicit states (v1.1 schema)
- [x] 4 screens updated: real capture UI, real provenance in Review, real
  stored-file list in Media & Export
- [x] 5 new JSON Schemas + sensor-capability v1.1; 11 schemas total
- [x] Tracking/registration evaluated and documented as NOT IMPLEMENTED
  (docs/tracking-evaluation.md); no SLAM/point clouds anywhere
- [x] Tests: 50 bun + 12 Python green; typecheck clean; STAGE2_REPORT.md
- [ ] On-device capture verification (docs/hardware-verification.md Part 1b:
  A12–A25 — needs a physical device; BLOCKED in sandbox)
- [ ] iOS capture verification (needs macOS/Xcode; BLOCKED in sandbox)

## Stage 2.1 — Audit & Stage 3 contracts (COMPLETE, software scope)

- [x] Full source audit against STAGE1/STAGE2 reports; features classified
  IMPLEMENTED / PARTIALLY / NOT_IMPLEMENTED / STUB (docs/STAGE2_1_AUDIT_REPORT.md)
- [x] Operation registry corrected: `pointcloud_import` and
  `frame_registration` re-assigned Stage 2 → Stage 3 (nothing in Stage 2
  implements them); `frame_extraction` + `camera_calibration` added as
  Stage 3 operations; registry as code (`src/engine/operations.ts`)
  mirrored to `schemas/operations.registry.json`, test-enforced
- [x] Dead code removed: template `app/modal.tsx` + route entry,
  template `constants/colors.ts`, unreferenced `ScanAssetStore`/
  `unavailableAssetStore` (superseded by session-store.ts)
- [x] Stage 3 reconstruction contracts: zod (`src/models/reconstruction.ts`)
  + 5 JSON Schemas (frame-extraction, camera-calibration, tracking-result,
  registration-operation, geometry-validation); unavailable engine seams
- [x] `pointcloud-asset` v1.1 (backward compatible): provenance, checksum,
  scale_status/scale_provenance, validation
- [x] Scale honesty enforced: UNKNOWN/RELATIVE/ESTIMATED/VALIDATED with
  provenance refinement; no metre claims anywhere in code
- [x] Docs: data-exchange (registry + 16-schema inventory), architecture,
  capture-pipeline (frame-timestamp limitation), tracking-evaluation
  (offline-desktop addendum), blender-extension, README,
  STAGE2_1_AUDIT_REPORT.md, STAGE3_READINESS.md
- [x] Tests: 77 bun + 23 Python green; runChecks clean
- [ ] Hardware/Blender verification — deferred to the operator machine
  (unchanged; see docs/hardware-verification.md)

## Stage 3 — Planning correction (COMPLETE, software scope; implementation NOT started)

- [x] Planning correction of the Stage 3 plan: deprecated `frame_registration`
  (superseded_by 5 operations; no data ever emitted under it — no migration)
  and split its responsibilities into `visual_tracking`,
  `trajectory_generation`, `pointcloud_reconstruction`,
  `pointcloud_registration` and `pointcloud_fusion` — 13-operation registry
- [x] Registry upgraded: per-operation dependencies (all/any logic), failure
  modes, provenance requirements; `validateRegistry()` +
  `assertRegistryValid()`; TS↔JSON mirror test-enforced
- [x] Metric-scale rules tightened: calibration ≠ scene scale;
  operator_assumed capped at ESTIMATED; VALIDATED requires independent
  metric bases (known_dimension / survey_control / validated_depth /
  external_metric_scan); monocular tracking structurally capped at RELATIVE
- [x] New contracts: tracking-result v1.1 (TRK-), camera trajectory (TRJ-/
  POSE- with coordinate_frame + timestamp_provenance),
  pointcloud-reconstruction, pointcloud-fusion, registration-operation v1.1
  (≥2 genuine PC- inputs only; camera poses rejected), pointcloud-asset v1.2
  (backward compatible) — 18 schemas + operations registry
- [x] Engine seams rewritten: one honest rejecting seam per operation (9
  seams); no fake pipeline anywhere
- [x] Docs: STAGE3_DEPENDENCY_MAP.md, STAGE3_LIBRARY_EVALUATION.md (FFmpeg,
  OpenCV, pycolmap, Open3D, laspy+lazrs; rejected alternatives + licences),
  STAGE3_READINESS.md (corrected order 3.1–3.8, 8 GB RAM discipline,
  Blender 5.1 plan, gates), data-exchange, tracking-evaluation,
  blender-extension, architecture, README, this file
- [x] Tests: 94 bun + 32 Python green; runChecks clean
- [ ] Stage 3 implementation (tracking/reconstruction/meshing code —
  external import is done in Stage 3.1 above) — deliberately not started;
  software development may proceed without
  device verification (see Stage 3.0 policy below)
- [ ] Hardware/Blender verification — deferred to the operator machine
  (unchanged; see docs/hardware-verification.md)

## Stage 3.0 — Final architecture corrections (COMPLETE, software scope)

- [x] Device-verification contradiction removed everywhere: **Stage 3
  software development may proceed without physical-device verification**;
  device verification is a deferred acceptance requirement before
  phone-derived results can be trusted as validated mining data — never a
  prerequisite for writing Stage 3 code
- [x] Two declared reconstruction paths on `pointcloud_reconstruction`:
  `opencv_assisted` (path-requires `trajectory_generation`; mandatory
  `trajectory_id`) and `colmap_native` (COLMAP features/matching/bundle
  adjustment/poses internally; `trajectory_id` may be null). One `PC-`
  asset kind, `pipeline_path` provenance; validation identical on both
  paths; `frame_registration` stays DEPRECATED
- [x] Library stack corrected: five functional groups, six named
  tools/packages (FFmpeg; OpenCV; COLMAP/pycolmap; Open3D; laspy; lazrs);
  per-tool verified/NOT_AVAILABLE status; FFmpeg licensing documented as
  build-dependent with a real GPL-build example — no bundling without
  review
- [x] New docs: STAGE3_COMPATIBILITY_MATRIX.md (VERIFIED/FAILED/NOT_TESTED/
  NOT_AVAILABLE/NOT_APPLICABLE statuses, 8 GB RAM strategy),
  STAGE3_FAILURE_HANDLING.md (underground risks → failure conditions →
  rejection rules), STAGE3_FINALIZATION_REPORT.md
- [x] `geometry_validation` added as its own registry operation (14 ops);
  CRS rule resolved: record + warn, never silently reproject or invent a
  CRS
- [x] Tests: 100 bun + 34 Python green; runChecks clean

## Stage 4 (planned) — Analysis & reporting
- Cross-sections, convergence analysis, reports; C++/Kotlin/Swift native
  interfaces where profiling demands

## Environment notes
- Sandbox has no Blender, no emulators, no Xcode: those verifications are
  reported as not-run in STAGE1_REPORT.md and belong on the operator's
  Windows machine.
