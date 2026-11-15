# Stage 3 planning correction — report

**Date:** 2026-11-06
**Scope:** planning-correction only. **No Stage 3 processing code was
written, no pipeline was implemented, and no device or Blender testing was
performed.** All processing operations remain NOT_IMPLEMENTED (except the
deprecated `frame_registration`).

## 1. Summary of the problem found

Planning the Stage 3 work surfaced structural errors in the Stage 2.1-era
plan, caught before any implementation started:

1. **No operation produced a point cloud.** The registry had consumers
   (`mesh_reconstruction`) of a "fused point cloud" but no operation that
   turns frames, calibration and camera poses into genuine geometry.
2. **`frame_registration` was a bundle, not an operation.** It conflated
   visual tracking, trajectory generation, point-cloud reconstruction,
   registration and fusion — five responsibilities with different inputs,
   outputs, failure modes and hosts.
3. **Metric-scale rules were wrong.** `calibrated_trajectory` and
   `calibration_target` appeared as scale bases, but camera calibration
   fixes camera geometry, not scene scale.
4. **Camera poses could reach registration.** The old registration contract
   allowed trajectory-derived inputs; registering camera poses against point
   clouds is a category error.
5. **The dependency order was undefined.** Nothing recorded which operation
   could run before which, or on what host.

## 2. Registry changes (`src/engine/operations.ts`, `schemas/operations.registry.json`)

- `frame_registration` → status **DEPRECATED** (new status value), with
  `superseded_by = [visual_tracking, trajectory_generation,
  pointcloud_reconstruction, pointcloud_registration, pointcloud_fusion]`.
  No data was ever emitted under it — **no migration needed**; the
  identifier is retained for document compatibility.
- Five operations **added**: `visual_tracking`, `trajectory_generation`,
  `pointcloud_reconstruction`, `pointcloud_registration`,
  `pointcloud_fusion`.
- `OperationSpec` extended with `dependencies` + `dependencyLogic`
  (`"all"` | `"any"`), `failureModes`, `provenanceRequired`, `supersededBy`.
- `dependencyLogic = "any"` for `pointcloud_registration` (imported OR
  reconstructed clouds) and `mesh_reconstruction` (any cloud producer);
  `"all"` elsewhere.
- **13 entries** total; `validateRegistry()` / `assertRegistryValid()`
  enforce stage ordering, unknown/self dependencies, `"any"` needing ≥ 2
  dependencies, and supersession consistency.

## 3. Contract changes (`src/models/reconstruction.ts`, `src/models/models.ts`, `schemas/`)

- **Scale rules (binding):** bases are now `none`, `known_dimension`,
  `survey_control`, `validated_depth`, `external_metric_scan`,
  `operator_assumed`, `other_documented`. Enforced refinements: UNKNOWN ⇔
  `none`; `operator_assumed` can never be VALIDATED; VALIDATED requires
  independent metric bases (`known_dimension` / `survey_control` /
  `validated_depth` / `external_metric_scan`). RELATIVE is the monocular
  ceiling — `trackingResultSchema.scale_status` is structurally limited to
  `"RELATIVE" | "UNKNOWN"`.
- **tracking-result v1.1** (`TRK-`): tracking-only record — no embedded
  trajectory, `calibration_id` required, `lost_frame_count` recorded.
- **camera trajectory** (`TRJ-` with `POSE-` poses): new record; mandatory
  `coordinate_frame` and `timestamp_provenance` (`video_pts` first).
- **pointcloud-reconstruction**: new record linking a produced `PC-` asset
  to its calibration, trajectory and frame job.
- **registration-operation v1.1**: inputs restricted to ≥ 2 genuine
  `PC-…` assets (camera poses structurally rejected); dropped the
  `trajectory_fusion` method; requires tool + tool_version, coordinate
  frame, scale compatibility.
- **pointcloud-fusion**: ≥ 2 sources, each with registration provenance.
- **pointcloud-asset v1.2**: optional `reconstruction` provenance block
  (method, calibration/trajectory/job ids, tool, timestamp); v1 and v1.1
  documents remain valid — **backward compatible, no migration**.
- Schema count: **18 `.schema.json` files** + `operations.registry.json`.

## 4. Engine seams (`src/engine/reconstruction.ts`)

Rewritten to one honest, rejecting seam per operation: `FrameExtractor`,
`CameraCalibrator`, `VisualTracker`, `TrajectoryBuilder`,
`PointCloudReconstructor`, `PointCloudRegistrar`, `PointCloudFuser`,
`MeshReconstructor`, `GeometryValidator` — all served by
`unavailableReconstructionEngine`, which async-rejects every call. No
placeholder pipeline, no fake data path.

## 5. Planning documents

- **`docs/STAGE3_DEPENDENCY_MAP.md`** (new): flow diagram + per-operation
  tables (inputs/outputs/dependencies/host/scale rules/failure
  modes/provenance/acceptance criteria).
- **`docs/STAGE3_LIBRARY_EVALUATION.md`** (new): minimal free stack —
  FFmpeg (extraction), OpenCV (calibration/features), pycolmap
  (COLMAP BSD-3-Clause), Open3D (registration/fusion/meshing), laspy +
  lazrs (LAS/LAZ); twelve-criterion comparison tables; rejected: PDAL,
  OpenMVG/MVS, CloudCompare CLI, PyTorch/TF, PCL, commercial SDKs;
  modularity rule (every library behind a seam).
- **`docs/STAGE3_READINESS.md`** (rewritten): corrected dependency order
  3.1–3.8, verification gates separated from build steps, 8 GB RAM
  discipline (chunked processing, LAZ streaming, memory budgets per
  operation), Blender 5.1 inspection plan, open questions.
- **`docs/data-exchange.md`**: identifier list (+JOB-/FRM-/CAL-/TRK-/TRJ-/
  POSE-/VAL-), 13-operation registry table with Depends-on column, binding
  "Metric scale rules" section, eighteen-schema inventory, laspy+lazrs
  note replacing the rejected PDAL mention.
- **`docs/tracking-evaluation.md`**: addendum mapping the old evaluation
  onto the separated responsibilities.
- **`docs/blender-extension.md`**: status note + planned (not implemented)
  Stage 3 inspection panels: imported/reconstructed/fused clouds, meshes,
  trajectory axis polylines, provenance and scale-honesty displays; the
  rule that an operator un-stubs only when its registry operation becomes
  IMPLEMENTED.
- **`docs/architecture.md`**, **`README.md`**, root **`PLAN.md`**: brought
  in line with the above.

## 6. Tests

- `tests/mobile/reconstruction.test.ts` rewritten: registry validation
  (including a deliberately broken-registry fixture against
  `validateRegistry()`), scale-provenance refinements, TRK/TRJ separation,
  reconstruction/registration/fusion records, schema-mirror equality —
  **94 bun tests green** (4 files).
- `tests/python/test_stage2.py` rewritten, `test_stage1.py` updated:
  registry statuses ∈ {NOT_IMPLEMENTED, DEPRECATED}, dependency
  consistency, scale-basis enum consistency across six schema files, 18
  schema count, registration/fusion minimum inputs, pointcloud v1.2
  backward compatibility, Blender operator honesty — **32 Python tests
  green**.
- `runChecks` (TypeScript strict + Expo checks): **clean** after all
  code and documentation changes of this correction.

## 7. What was deliberately NOT done

- **No Stage 3 implementation** — tracking, reconstruction, registration,
  fusion and meshing code does not exist; every seam still rejects.
- **No device, emulator, iOS-simulator or underground capture testing.**
- **No Blender run** — the sandbox has no Blender binary.
- **No fabricated data anywhere** — no fixtures presented as real mining
  output; any future test data will be labelled synthetic or cite its real
  origin.

## 8. Known limitations

- `assertRegistryValid()` is wired into tests but not yet called from app
  runtime code (intentional: the registry is compile-time/test-time data
  until Stage 3 runs).
- The 8 GB RAM budgets in `STAGE3_READINESS.md` are planning figures, not
  measurements — they will be validated against real recordings during
  Stage 3 implementation.
- Hardware/on-device verification remains deferred to the operator machine
  (`docs/hardware-verification.md`), unchanged from earlier stages.

## 9. Verdict

**COMPLETE** for the planning-correction scope defined above. Stage 3
implementation has not started. Per the Stage 3.0 finalization policy,
software development does **not** wait for physical-device verification;
that verification is a deferred acceptance requirement before
phone-derived results are trusted (see `docs/STAGE3_READINESS.md` §3,
which this report's earlier "gates first" wording has been aligned with).
