# Stage 3.0 finalization report — final architecture corrections

**Date:** 2026-11-06
**Scope:** planning/architecture finalization only. **No Stage 3 processing
engine was implemented.** Every processing operation remains
NOT_IMPLEMENTED (except the DEPRECATED `frame_registration`), every engine
seam still rejects, and no device or Blender testing was performed.
Claims below were verified against the actual source code and a real
environment probe, not taken from earlier reports.

## A. Overall verdict

**COMPLETE** for the Stage 3.0 finalization scope (Section 16's acceptance
criteria), with the honest limitation that every compatibility/performance
item outside this sandbox is NOT_TESTED and is labelled so in
`docs/STAGE3_COMPATIBILITY_MATRIX.md`.

## B. Corrections completed

| # | Correction | Status | Where |
|---|---|---|---|
| 1 | Remove device-verification blocker contradiction | **COMPLETE** | STAGE3_READINESS.md §3 rewritten to the binding policy ("software development may proceed; device verification is a deferred acceptance requirement"); the contradicting lines in PLAN.md ("requires on-device capture verification first") and STAGE3_PLANNING_CORRECTION_REPORT.md §9 removed; architecture.md and README.md state the same policy. Grep across docs finds no remaining "verification first" blocker |
| 2 | Two valid reconstruction paths | **COMPLETE** | Registry `paths` field (opencv_assisted / colmap_native) on `pointcloud_reconstruction`; hard dependency on trajectory_generation removed; `pipeline_path` provenance + conditional `trajectory_id` in the zod record, the JSON Schema, and pointcloud-asset v1.2; two-path flow diagram in STAGE3_DEPENDENCY_MAP.md |
| 3 | Dependency count and library classification | **COMPLETE** | STAGE3_LIBRARY_EVALUATION.md: "five functional groups and six named tools/packages" (FFmpeg; OpenCV; COLMAP/pycolmap; Open3D; laspy; lazrs); per-tool rows extended with exact name, install, version detection, and verified status |
| 4 | FFmpeg licensing | **COMPLETE** | Dedicated licensing section: licence is build-configuration-dependent (LGPL vs GPL vs component obligations); exact binary/version/config must be recorded; licensing review required before distributing any binary; worked example — this sandbox's distro ffmpeg 7.1.5 is a `--enable-gpl` build, proving no blanket statement is safe |
| 5 | Real compatibility verification plan | **COMPLETE** | New `docs/STAGE3_COMPATIBILITY_MATRIX.md` (Windows env, Python joint compatibility, Blender 5.1, 8 GB strategy, VERIFIED/FAILED/NOT_TESTED/NOT_AVAILABLE/NOT_APPLICABLE statuses) |
| 6 | Underground failure handling | **COMPLETE** | New `docs/STAGE3_FAILURE_HANDLING.md` (risk catalogue; per-op preconditions/validation/failures/errors/recovery/continue-or-reject/provenance); underground-specific failure modes added to the registry (`low_light_feature_loss`, `motion_blur`, `repetitive_texture_degeneracy`, `reflective_or_wet_surfaces`, `dust_occlusion`, `corrupted_input_file`, …) |
| 7 | Scale and accuracy rules preserved | **COMPLETE** | All seven scale bases and the refinements unchanged; new binding rule 6 (no silent CRS transformation; missing/uncertain CRS recorded + warned) and rule 7 (no ±2–5 cm claims) in data-exchange.md; STAGE3_READINESS §8 CRS question resolved |
| 8 | Operation and schema consistency | **COMPLETE** | `geometry_validation` was missing from the registry (existed only as schema + seam) — added as its own operation (registry now 14 ops); Zod/JSON mirror test-enforced; deprecated `frame_registration` preserved and not revived |
| 9 | Blender integration boundary | **COMPLETE** | blender-extension.md: fixed four-way boundary (capture / external processing / Blender inspection / shared formats); no processing engine inside Blender; existing metadata loader preserved; panels must show `pipeline_path` |
| 10 | Final readiness order | **COMPLETE** | STAGE3_READINESS.md §2 rewritten to the required 10-step order (incl. "visual_tracking and/or COLMAP-native", "trajectory_generation where required by path", geometry validation woven in); first implementation direction: import → extraction → COLMAP video-to-cloud; not meshing; not waiting for devices |

## C. Files changed

**Created**
- `docs/STAGE3_COMPATIBILITY_MATRIX.md` — Correction 5 deliverable.
- `docs/STAGE3_FAILURE_HANDLING.md` — Correction 6 deliverable.
- `docs/STAGE3_FINALIZATION_REPORT.md` — this report.

**Modified**
- `src/engine/operations.ts` — `OperationPath` type + `paths` on OperationSpec; `pointcloud_reconstruction` re-depened + two paths + underground failure modes; `geometry_validation` op added (14 entries); `validateRegistry()` validates paths (duplicate ids, unknown/deprecated/later-stage requires).
- `schemas/operations.registry.json` — full mirror of the above (title v1.3, Stage 3.0 finalization).
- `src/models/reconstruction.ts` — `pipelinePathSchema`; `pointcloudReconstructionRecordSchema`: `pipeline_path` required, `trajectory_id` nullable with refinement (opencv_assisted ⇒ TRJ required), method gains `trajectory_based_mvs`.
- `src/models/models.ts` — pointcloud-asset v1.2 `reconstruction` block: `trajectory_id` nullable, optional `pipeline_path`, matching refinement (backward compatible).
- `schemas/pointcloud-reconstruction.schema.json` — mirrors the zod record (if/then conditional).
- `schemas/pointcloud-asset.schema.json` — mirrors the v1.2 block change (stays v1.2; additive).
- `tests/mobile/reconstruction.test.ts` — updated for two paths, geometry_validation, path-validation fixtures, pipeline-path records (+6 tests → 100).
- `tests/python/test_stage2.py` — updated for two paths, geometry_validation, pipeline_path schema checks (+2 tests → 34).
- `docs/STAGE3_READINESS.md`, `docs/STAGE3_DEPENDENCY_MAP.md`, `docs/STAGE3_LIBRARY_EVALUATION.md`, `docs/data-exchange.md`, `docs/architecture.md`, `docs/blender-extension.md`, `docs/STAGE3_PLANNING_CORRECTION_REPORT.md` (verdict line), `README.md`, `PLAN.md` (root) — per the corrections above.

**Deleted** — nothing. No identifier, field or operation was removed.

## D. Architecture decisions

**Two-path reconstruction.** `pointcloud_reconstruction` hard-depends only
on `frame_extraction` + `camera_calibration`. Its registry entry declares
`paths`:
- **Path A `opencv_assisted`** — additionally requires
  `trajectory_generation` (OpenCV tracking → `TRK-` → `TRJ-`); its records
  must carry a non-null `trajectory_id`; the reconstruction engine must be
  proven compatible with an externally supplied trajectory at
  implementation time.
- **Path B `colmap_native`** — requires nothing more; COLMAP/pycolmap does
  feature extraction, matching, bundle adjustment and pose estimation
  internally; `trajectory_id` may be null and pose provenance is the
  recorded COLMAP tool/version.

Both paths emit the **same single `PC-` asset kind** (no duplicate clouds
or operations); each record states `pipeline_path`; validation rules are
identical on both paths — no leniency for either. `geometry_validation` is
now a registry operation that can reject any genuine geometry asset.
`frame_registration` remains DEPRECATED and non-executable on both paths.
The recommended first implementation is Path B (COLMAP-native), preceded by
`pointcloud_import` and `frame_extraction`.

## E. Compatibility (verified facts, this Linux sandbox)

| Item | Status |
|---|---|
| Linux sandbox: 7.8 GiB RAM, 99 GB free, Python 3.13.14, pip 26.2.2, bun 1.4.4 | VERIFIED |
| ffmpeg/ffprobe 7.1.5 (Debian, `--enable-gpl` config) | VERIFIED |
| `cv2` 4.11.0, `numpy` 2.3.5 import | VERIFIED (import only — no workflow) |
| `open3d`, `pycolmap`, `laspy`, `lazrs` | NOT_AVAILABLE (proposed, uninstalled) |
| Blender, COLMAP executables | NOT_AVAILABLE |
| Windows workstation env (all attributes) | NOT_TESTED |
| Joint Python-package compatibility | NOT_TESTED |
| Blender 5.1 add-on install/panels, bundled Python | NOT_TESTED |
| 8 GB strategies (chunking, cancellation, monitoring) | UNVERIFIED (design, no benchmarks) |
| FAILED | — (nothing executed and failed) |
| NOT_APPLICABLE | — |

## F. Test results (actually executed)

| Command | Result |
|---|---|
| `bun test tests/mobile` | **100 pass, 0 fail** (460 expects, 4 files) |
| `python3 -m unittest discover -s tests/python` | **OK, 34 tests** |
| JSON validation of all 18 schemas + operations.registry.json (json.load) | all valid |
| Registry structural check (14 unique ids; rec deps `[frame_extraction, camera_calibration]`; paths `[opencv_assisted, colmap_native]`; frame_registration DEPRECATED) | pass |
| `runChecks` (TypeScript strict + lint + structure, appPath mining-scanner) | **passed, 0 errors** |

## G. Remaining limitations

- All Windows-workstation, Blender and joint-package verification is
  NOT_TESTED and must be run on the operator machine (matrix provided).
- The 8 GB handling strategy is unbenchmarked design.
- No processing engine exists; nothing here is evidence that any
  reconstruction works on underground data.
- `assertRegistryValid()` remains a test-time guard (not wired into app
  runtime), unchanged from the planning correction.

## H. Stage 3.1 recommendation

**Task:** implement `pointcloud_import` (Stage 3.1) on the desktop, then
`frame_extraction` (3.2), then the genuine COLMAP-native video-to-point-
cloud workflow (Path B).

- **Modules:** a new offline-desktop Python package behind the existing
  registry seam; PC- asset + processing-operation record writers
  (schema-validated); units/CRS validation with record-and-warn semantics.
- **Acceptance criteria** (from `docs/STAGE3_DEPENDENCY_MAP.md`): a real
  PLY and a real LAS/LAZ import with units identified and checksums
  verified; frames extracted from a genuine Stage 2 recording carry PTS
  timestamps; corrupt inputs yield failed records and **no assets**;
  every record carries tool + version + settings provenance.
- **Boundaries:** no mesh reconstruction, no fake sample outputs, no
  bundled FFmpeg binary without the licensing review, no device testing
  required to start — and no accuracy claims at any point.
