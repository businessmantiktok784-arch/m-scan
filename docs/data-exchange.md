# Data exchange — formats, units, conventions

This document is the contract between the mobile app, the Blender extension
and future processing stages. Capture (Stage 2) produces real camera video
and sensor streams; **no stage yet produces or consumes scan payloads**
(point clouds, meshes) — those contracts are defined here up front so Stage 3
implementers cannot improvise.

## Units and coordinates

| Aspect | Value |
|---|---|
| Length unit | metre, everywhere (app, files, Blender scene scale 1.0 = 1 m) |
| Coordinate convention | right-handed, +X east, +Y north, +Z up |
| Origin | local project origin (set when the first real session is captured) |
| Geo-referencing | **none**. Projects are never auto-registered to WGS84 or any CRS. A transform, if introduced later, will be an explicit stored object with documented parameters and provenance |
| Angles | radians in code, degrees in UI text |
| Timestamps | ISO 8601 with UTC or explicit offset (`2026-11-05T10:00:00Z`) |
| Identifiers | prefix + 8 hex: `MS-` project, `SES-` session, `PC-` point cloud, `MSH-` mesh, `OP-` operation; Stage 3 records add `JOB-` extraction job, `FRM-` frame, `CAL-` calibration, `TRK-` tracking result, `TRJ-` trajectory, `POSE-` trajectory pose, `VAL-` validation |

## Project directory layout (planned contract)

```
<project-dir>/
├── .miningscan.json          # project metadata (schemas/project-metadata)
├── sessions/
│   └── <SES-xxxxxxxx>/
│       ├── session.json      # scan-session metadata
│       └── assets/           # point clouds, meshes, exports
└── operations/
    └── <OP-xxxxxxxx>.json    # processing-operation records
```

Databases index assets by relative `file_path`; the files themselves are the
source of truth. Deleting a file invalidates the index row, not vice versa.
A safe reconciliation approach for later stages (read-only "FILE MISSING"
marking, explicit user-confirmed index-row removal, write-side file+row
pairing) is proposed in `docs/hardware-verification.md` Part 3 — Stage 1
implements none of it.

## Asset formats

### Point clouds

| Format | Status | Notes |
|---|---|---|
| PLY | planned (preferred interchange) | binary_little_endian, double precision XYZ, optional normals/colours |
| XYZ | planned | plain text, `x y z [nx ny nz] [r g b]` per line, metres |
| LAS / LAZ | planned | via laspy + lazrs in later stages (see `docs/STAGE3_LIBRARY_EVALUATION.md`); storage v1.4 |
| E57 | planned | includes per-point timestamps when available |

### Meshes

| Format | Status | Notes |
|---|---|---|
| OBJ | planned (preferred interchange) | + MTL, metres, Y-up converted on export per convention above |
| STL | planned | binary only; units implied metres |
| FBX | planned | Blender import/export only |
| PLY | planned | mesh form (faces), same rules as point clouds |

**Export formats are PLANNED; import (Stage 3.1) is IMPLEMENTED.** The app
writes none of these files; the export screen labels every format
accordingly and creates no files. Importing external point clouds is live
(see docs/pointcloud-formats.md).

## Operation registry

Processing operations are recorded with a machine-readable name. The single
source of truth is **`src/engine/operations.ts`**, mirrored (and
test-enforced) in **`schemas/operations.registry.json`**. Registry as of
Stage 3.3 — 14 operations; `pointcloud_import` (external point-cloud
import, docs/stage3.1-pointcloud-import.md), `frame_extraction`
(Stage 2 recordings → verified frames with honest timestamp provenance,
docs/stage3.2-frame-extraction.md) and `camera_calibration` (Stage 3.3
known-target calibration, docs/stage3.3-camera-calibration.md) are
IMPLEMENTED, every other non-deprecated operation is NOT_IMPLEMENTED, and
`frame_registration` is deprecated:

| Name | Stage | Status | Input → output | Depends on | Runs on |
|---|---|---|---|---|---|
| `pointcloud_import` | 3 | **IMPLEMENTED** (Stage 3.1) | external PLY (ascii/binary-LE), XYZ or LAS file → `PC-` asset; LAZ rejected as unsupported | — | mobile or desktop |
| `frame_extraction` | 3 | **IMPLEMENTED** (Stage 3.2) | Stage 2 video segments → frames (`FRM-`, `JOB-`); platform decoder (seek-based, no PTS) — FFmpeg on device NOT_AVAILABLE | — | mobile or desktop |
| `camera_calibration` | 3 | **IMPLEMENTED** (Stage 3.3) | frames → `CAL-` record; pure-TS Zhang solver (OpenCV on device NOT_AVAILABLE); computed, never independently validated; scale UNKNOWN | frame_extraction | mobile or desktop |
| `visual_tracking` | 3 | NOT_IMPLEMENTED | frames + `CAL-` → `TRK-` result | frame_extraction, camera_calibration | offline desktop |
| `trajectory_generation` | 3 | NOT_IMPLEMENTED | `TRK-` → `TRJ-` trajectory | visual_tracking | offline desktop |
| `pointcloud_reconstruction` | 3 | NOT_IMPLEMENTED | frames + `CAL-` + poses (TRJ- or COLMAP-internal) → genuine `PC-` asset | frame_extraction, camera_calibration; Path A also `trajectory_generation` | offline desktop |
| `pointcloud_registration` | 3 | NOT_IMPLEMENTED | ≥2 genuine `PC-` → `OP-` transform + residuals | pointcloud_import *or* pointcloud_reconstruction | offline desktop |
| `pointcloud_fusion` | 3 | NOT_IMPLEMENTED | registered `PC-` + `OP-` → fused `PC-` | pointcloud_registration | offline desktop |
| `mesh_reconstruction` | 3 | NOT_IMPLEMENTED | genuine `PC-` → `MSH-` asset | any cloud producer | offline desktop |
| `geometry_validation` | 3 | NOT_IMPLEMENTED | genuine `PC-`/`MSH-` → `VAL-` record | any cloud/mesh producer | offline desktop |
| `tunnel_axis_extraction` | 3 | NOT_IMPLEMENTED | `MSH-` (or `PC-`) → axis polyline | mesh_reconstruction | offline desktop |
| `frame_registration` | 3 | **DEPRECATED** | — | — | — |
| `cross_section_analysis` | 4 | NOT_IMPLEMENTED | mesh + axis → section profiles, `VAL-` | tunnel_axis_extraction | offline desktop |
| `convergence_analysis` | 4 | NOT_IMPLEMENTED | mesh pair → deformation report | mesh_reconstruction | offline desktop |

**Stage 2.1 audit corrections.** The Stage 1 table assigned
`pointcloud_import` and `frame_registration` to Stage 2, but nothing in
Stage 2 implements them. Both were corrected to Stage 3.

**Stage 3 planning correction.** `frame_registration` conflated visual
tracking, trajectory generation, point-cloud reconstruction, registration
and fusion, and the plan lacked any operation that actually *generates* a
point cloud. It is **deprecated** and split into `visual_tracking`,
`trajectory_generation`, `pointcloud_reconstruction`,
`pointcloud_registration` and `pointcloud_fusion`. No data was ever emitted
under `frame_registration`, so no migration is needed; the identifier stays
in the registry (with `superseded_by`) for document compatibility — and it
is **not** revived by later changes. Camera poses are never registration
inputs; registration consumes only genuine point clouds.

**Stage 3.0 finalization.** `pointcloud_reconstruction` now declares two
alternative valid paths in the registry (`paths`): `opencv_assisted`
(requires `trajectory_generation`; mandatory `trajectory_id` in the record)
and `colmap_native` (COLMAP performs feature extraction, matching, bundle
adjustment and pose estimation internally; `trajectory_id` may be null).
Both paths emit the same single `PC-` asset kind and the record states
which path ran. `geometry_validation` was added as its own registry
operation. See `docs/STAGE3_DEPENDENCY_MAP.md` for the path rules.

Per-operation dependencies, failure modes and mandatory provenance live in
the registry; the dependency chain is explained in
`docs/STAGE3_DEPENDENCY_MAP.md`.

Adding a name to this table is a schema-registry change: update
`src/engine/operations.ts` and `schemas/operations.registry.json` together
(the test suites fail when they drift), then document it here and in
`docs/architecture.md` before any producer emits it.

## Honesty rules for producers

1. A record may only claim `collected` / `done` after the work actually
   happened. Never pre-write success states.
2. `null` means "unknown / not probed". Producers must not encode guesses as
   `false` or `0`.
3. No accuracy, resolution or coverage figures may be written unless they were
   measured from real data with a documented method.
4. Deleting data removes both file and index row; "deleted but still listed"
   is a bug, not a state.

## Metric scale rules (binding)

`scale_status ∈ {UNKNOWN, RELATIVE, ESTIMATED, VALIDATED}` always travels
with a `scale_provenance` record. The enforced rules:

1. `UNKNOWN` ⇔ basis `none`. No scale information is a normal, honest state.
2. `RELATIVE` is the ceiling for monocular tracking and any reconstruction
   built on it without external evidence. Camera **calibration fixes camera
   geometry, not scene scale** — it is never a scale basis.
3. `operator_assumed` scale stays `ESTIMATED` at best and must be visibly
   identified as estimated wherever measurements are displayed.
4. `VALIDATED` requires independent metric evidence: a known physical
   dimension, survey control points, validated depth measurements, or
   compatible metric external scanner data (`known_dimension`,
   `survey_control`, `validated_depth`, `external_metric_scan`). An
   algorithm completing successfully is never validation.
5. Any other basis must be documented in `detail` (`other_documented`) and
   still cannot reach `VALIDATED` without independent evidence.
6. **No silent coordinate-system transformation.** If CRS or coordinate
   metadata on an imported file is missing or uncertain, the limitation is
   recorded on the asset and the user is warned — a CRS is never silently
   invented, and no undocumented reprojection is performed. Camera poses
   are never accepted as registration inputs (Correction 7 of Stage 3.0).
7. No accuracy value (e.g. "±2–5 cm") may be claimed anywhere without
   independent surveyed validation.

## JSON Schemas

The **eighteen** files in `schemas/` are draft 2020-12, each with `$id`,
`required` and fully typed properties. They are the referee between the
TypeScript (zod) and Python implementations. Validation tooling for
third-party files is a later-stage deliverable; today the schemas are
enforced in code on both sides.

In addition, `schemas/operations.registry.json` is the machine-readable
operation registry (not a data schema) described above.

Schema inventory by origin: Stage 1 (project-metadata, scan-session,
sensor-capability v1.1, pointcloud-asset **v1.3**, mesh-asset,
processing-operation), Stage 2 (capture-config, camera-recording,
sensor-stream, capture-manifest, tracking-status), Stage 2.1
(frame-extraction **v2**, camera-calibration **v2** — both rewritten by
their implementation stages — tracking-result **v1.1**,
registration-operation **v1.1**, geometry-validation), Stage 3 planning
correction (pointcloud-reconstruction, pointcloud-fusion).

**frame-extraction v2** (Stage 3.2) mirrors the zod models exactly:
`$defs` + top-level `oneOf` over the two record kinds the pipeline emits —
the `JOB-` extraction job (settings with mode-dependent required fields via
if/then, decoder identity, sources with checksums, counters,
warnings/errors, timings) and the `FRM-` frame record (nullable
`pts_ms`/`time_base`, `capture_time_mapping`, measured size + MD5,
`extraction_method`). `file_path` is relative to the job output directory.
No v1 document exists in the wild (no extraction ever ran under the Stage
2.1 draft), so the rewrite replaces it outright.

**camera-calibration v2** (Stage 3.3) mirrors the zod models exactly:
`$defs` + top-level `oneOf` over the two record kinds a calibration
produces — the `CAL-` record (full-res intrinsics + distortion with
model-matched coefficient count, `engine` identity with the OpenCV
NOT_AVAILABLE note, `metrics` incl. RMS and per-image errors,
`target_config`, exact `source_frame_ids` / `source_video_asset_ids`,
per-image `frame_evaluations`, nullable `factory_provenance` /
`import_provenance`, `calibration_status` / `validation_status`,
`scale_status UNKNOWN` with basis `none` only) and the per-run
`processing_operation` view. Schema-enforced honesty: a
`estimated_from_capture` record cannot claim
`independently_validated`, and a calibration record cannot claim any
scale basis other than `none`.
No v1 document exists in the wild (no calibration ever ran under the
Stage 2.1 draft), so the rewrite replaces it outright.

**pointcloud-asset v1.3** (Stage 3.1) extends v1.1/v1.2 backward-compatibly
for imported clouds: `coordinate_units` gains `"unit_unknown"`,
`coordinate_convention` gains `"source_documented"` (coordinates stored
as-is; the app asserts no axis mapping), plus optional `original_filename`
and a `content` block (`coordinate_properties`, `has_colors`, `has_normals`,
`crs`) recording only file-documented facts. Imports always record
`unit_unknown` and `scale_status UNKNOWN` (basis `none`); earlier documents
remain valid unchanged.

**pointcloud-asset v1.2** extends v1.1 with the optional `reconstruction`
provenance block (method, calibration_id, trajectory_id, frame job ids,
tool, tool_version, processed_at); v1 and v1.1 documents remain valid
unchanged. The v1.1 fields (`source_session_ids`, `checksum_md5`,
`provenance`, `scale_status`, `scale_provenance`, `validation`) are
unchanged.
