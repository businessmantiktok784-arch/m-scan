# Stage 3 dependency map

Every Stage 3 operation, what it consumes, what it produces, what must exist
before it, where it runs, its scale requirements, how it can fail, and how
"done" is verified. Statuses live in the registry
(`schemas/operations.registry.json`); this map adds the engineering detail.

Source of truth: `src/engine/operations.ts` (the JSON mirror is
test-enforced against it).

## Flow — two alternative reconstruction paths (Stage 3.0)

There are **two valid routes** from capture to a genuine point cloud. They
are alternatives, not a sequence; every reconstruction record states which
path produced it. Both paths share the tail (registration → fusion →
meshing → validation).

```
Stage 2 capture (SES + camera_video + sensor JSONL)
        │
        ▼
┌──────────────────────┐
│ frame_extraction     │  video segments → FRM frames (+JOB record)
└─────────┬────────────┘
          ▼
┌──────────────────────┐
│ camera_calibration   │  frames → CAL record (or labelled factory values)
└─────────┬────────────┘
          │
   ┌──────┴───────────────────────────────────┐
   │ PATH A — OpenCV-assisted                 │   PATH B — COLMAP-native
   ▼                                          ▼
┌──────────────────┐                ┌──────────────────────────┐
│ visual_tracking  │                │ pycolmap/COLMAP feature  │
│ frames+CAL → TRK │                │ extraction, matching,    │
└────────┬─────────┘                │ bundle adjustment and    │
         ▼                          │ pose estimation          │
┌──────────────────┐                │ (all internal)           │
│ trajectory_      │                └────────────┬─────────────┘
│ generation       │                             │
│ TRK → TRJ        │                             │
└────────┬─────────┘                             │
         ▼                                       │
┌──────────────────────────────────────────────────────────┐
│ pointcloud_reconstruction                                │
│ frames + CAL + (TRJ | COLMAP-internal poses) → genuine PC-│
└────────┬─────────────────────────────────────────────────┘
         │            ┌───────────────────────────────┐
         └────────────┤ pointcloud_import (parallel   │
                      │ branch, available early)      │
                      └──────────────┬────────────────┘
                                     ▼
┌──────────────────────┐
│ pointcloud_registration│ ≥2 genuine PC- → OP- transform + residuals
└─────────┬────────────┘
          ▼
┌──────────────────────┐
│ pointcloud_fusion    │  registered PC- + OP- → fused PC-
└─────────┬────────────┘
          ▼
┌──────────────────────┐
│ mesh_reconstruction  │  genuine PC- → MSH-
└─────────┬────────────┘
          ▼
┌──────────────────────┐
│ geometry_validation  │  PC-/MSH- → VAL- verdict (applies wherever output must be checked)
└─────────┬────────────┘
          ▼
┌──────────────────────┐
│ tunnel_axis_extraction│ MSH (or PC) → axis polyline
└──────────────────────┘
          ▼            Stage 4 (out of scope here)
  cross_section_analysis → convergence_analysis
```

**Path rules (binding):**

- `pointcloud_reconstruction` hard-depends only on `frame_extraction` +
  `camera_calibration`. The trajectory requirement belongs to **Path A**
  via the registry `paths` declaration: `opencv_assisted` requires
  `trajectory_generation`; `colmap_native` requires no OpenCV trajectory
  (COLMAP estimates poses internally).
- Path A's reconstruction engine must be **compatible with an externally
  supplied trajectory** — compatibility is proven per implementation, never
  assumed; the record carries `pipeline_path: "opencv_assisted"` and a
  mandatory `trajectory_id`.
- Path B records `pipeline_path: "colmap_native"` with the actual COLMAP/
  pycolmap tool + version as pose provenance; `trajectory_id` may be null.
- Both paths produce the **same single kind of `PC-` asset** — no duplicate
  point clouds and no duplicate operation exist merely because two paths
  do.
- Validation rules are identical on both paths: an output that fails its
  checks is rejected on either path; no path gets a leniency discount.

`frame_registration` (deprecated) used to bundle tracking, trajectory,
reconstruction, registration and fusion into one name. No data was ever
emitted under it; it is retained in the registry as DEPRECATED with explicit
`superseded_by`. It is **not** revived by the two-path change: neither path
runs through it, and it remains non-executable.

---

## pointcloud_import — Stage 3.1

| | |
|---|---|
| Inputs | Genuine external point-cloud file (PLY, LAS/LAZ; others only when justified) |
| Outputs | `PC-` asset record + file, import operation record |
| Dependencies | none (early milestone: exercises asset + Blender integration without waiting for video reconstruction) |
| Host | mobile or desktop |
| Scale requirement | Scale status must come from the source metadata or the operator, with provenance; unknown units must fail or be explicitly confirmed |
| Failure modes | file_not_found, parse_error, unsupported_or_unknown_units, checksum_mismatch, empty_cloud |
| Provenance | tool, tool_version, checksum_md5, source_file, processed_at |
| Acceptance criteria | A real PLY and a real LAS/LAZ import; units identified and recorded; checksum matches file bytes; asset appears in app index and can be opened in Blender; a corrupt file produces a failed record and no asset |

## frame_extraction — Stage 3.2

| | |
|---|---|
| Inputs | Stage 2 `camera_video` segments |
| Outputs | FRM frame files, frame index, `JOB-` job record |
| Dependencies | none (consumes Stage 2 output) |
| Host | offline desktop |
| Scale requirement | n/a (no geometry) |
| Failure modes | video_unreadable, segment_missing, decode_error, disk_full, duplicate_frame_index |
| Provenance | tool, tool_version, source_video_reference, processed_at |
| Acceptance criteria | Frames extracted from a genuine Stage 2 recording carry PTS timestamps and original source references; a corrupted video yields a failed job record and clean partial state; re-running does not duplicate outputs; no wall-clock exposure time is ever written |

## camera_calibration — Stage 3.3

| | |
|---|---|
| Inputs | Extracted frames (FRM) — or explicit operator-provided/factory data |
| Outputs | `CAL-` calibration record |
| Dependencies | frame_extraction (for the estimation path) |
| Host | offline desktop |
| Scale requirement | A calibration does NOT establish scene scale — record must not imply it |
| Failure modes | insufficient_images, detector_failure, degenerate_target_layout, factory_values_unavailable |
| Provenance | calibration_method, source (estimated_from_capture / factory_assumed / operator_provided), processed_at |
| Acceptance criteria | Estimated calibrations come from real images with the method recorded; factory values are labelled factory_assumed; no invented per-device numbers; reprojection error (if reported) is computed, never asserted |

## visual_tracking — Stage 3.4a

| | |
|---|---|
| Inputs | Frames (FRM) + calibration (CAL) |
| Outputs | `TRK-` tracking result |
| Dependencies | frame_extraction, camera_calibration |
| Host | offline desktop |
| Scale requirement | Output scale_status is structurally limited to UNKNOWN/RELATIVE — monocular motion is never metric |
| Failure modes | insufficient_texture, tracking_loss, calibration_mismatch, unrecoverable_frame_gap |
| Provenance | method, tool_version, calibration_id, processed_at |
| Acceptance criteria | Real features are matched across real frames; tracking loss is counted (lost_frame_count), never hidden; the result references its calibration; no geometry is produced; a texture-poor video yields a partial/failed result, not a fake success |

## trajectory_generation — Stage 3.4b

| | |
|---|---|
| Inputs | `TRK-` tracking result |
| Outputs | `TRJ-` camera trajectory record |
| Dependencies | visual_tracking |
| Host | offline desktop |
| Scale requirement | Translations stay in reconstruction units; scale_status RELATIVE/UNKNOWN unless a metric basis with provenance was genuinely fused in |
| Failure modes | no_valid_tracking_result, discontinuous_trajectory, non_monotonic_timestamps |
| Provenance | source_tracking_result_id, coordinate_frame, timestamp_provenance |
| Acceptance criteria | Poses reference frame ids and PTS timestamps; coordinate frame is explicit; lost poses are kept as non-inliers, not deleted; a trajectory derived from a failed tracking result is refused |

## pointcloud_reconstruction — Stage 3.5 (two paths)

| | |
|---|---|
| Inputs | Frames (FRM) + calibration (CAL) + poses — a TRJ- trajectory (Path A) or COLMAP-internal poses (Path B) |
| Outputs | Genuine `PC-` asset + reconstruction operation record (states `pipeline_path`) |
| Dependencies | frame_extraction, camera_calibration (all). Path A additionally requires trajectory_generation; Path B requires nothing more |
| Host | offline desktop |
| Scale requirement | Output positions are in reconstruction units; scale_status UNKNOWN/RELATIVE unless a provenance-backed metric basis was applied — on EITHER path |
| Failure modes | pose_coverage_insufficient, calibration_incompatible, insufficient_image_overlap, out_of_memory, empty_output, low_light_or_motion_blur, repetitive_texture_degeneracy, reflective_or_wet_surfaces, corrupted_input_file |
| Provenance | tool, tool_version, calibration_id, pipeline_path, trajectory_id (Path A) or COLMAP-internal pose provenance (Path B), scale_status + scale_provenance, processed_at; the PC- asset additionally records reconstruction provenance (v1.2) |
| Acceptance criteria | A real multi-view algorithm runs on genuine frames; every output point is traceable to images/calibration/poses and states its path; no artificial filler points; failed runs produce failed records and no asset; 8 GB-aware chunked processing with settings recorded; an unreconstructable scan is rejected, never faked |

## pointcloud_registration — Stage 3.6a

| | |
|---|---|
| Inputs | ≥2 genuine `PC-` assets (imported or reconstructed) |
| Outputs | `OP-` registration record (transform, residuals) |
| Dependencies | pointcloud_import OR pointcloud_reconstruction |
| Host | offline desktop |
| Scale requirement | Input scale compatibility is checked and recorded; incompatible scales fail the operation |
| Failure modes | incompatible_units, incompatible_scale, insufficient_overlap, no_convergence, out_of_memory |
| Provenance | method, transform_4x4, residuals, input_asset_ids, tool_version, processed_at |
| Acceptance criteria | Only genuine point clouds are accepted (camera poses/trajectories are structurally rejected); transform and residuals are computed, never asserted; failures produce failed records; camera-pose estimation is never reported as registration |

## pointcloud_fusion — Stage 3.6b

| | |
|---|---|
| Inputs | Registered `PC-` assets + their `OP-` registration records |
| Outputs | Fused `PC-` asset + fusion record |
| Dependencies | pointcloud_registration |
| Host | offline desktop |
| Scale requirement | Fused output carries the weakest honest scale verdict of its sources, with provenance |
| Failure modes | registration_missing_or_failed, coordinate_frame_mismatch, unit_mismatch, out_of_memory |
| Provenance | per-source asset + transform provenance, scale_status + scale_provenance, tool_version, processed_at |
| Acceptance criteria | Fusion refuses inputs with missing/failed registrations or mismatched units/frames; sources and transforms are recorded per asset; chunked processing keeps memory bounded |

## mesh_reconstruction — Stage 3.7

| | |
|---|---|
| Inputs | One genuine `PC-` asset (imported, reconstructed or fused) |
| Outputs | `MSH-` asset record |
| Dependencies | any of pointcloud_import / pointcloud_reconstruction / pointcloud_fusion |
| Host | offline desktop |
| Scale requirement | Mesh inherits the cloud's scale_status/provenance — never upgraded silently |
| Failure modes | empty_or_thin_cloud, reconstruction_failed, out_of_memory |
| Provenance | method, settings, source_cloud_id, tool_version, processed_at |
| Acceptance criteria | Mesh comes from a genuine cloud with the source recorded; settings (incl. resolution reductions) are recorded; no mesh is ever produced directly from video; statistics are computed from the output file |

## geometry_validation — Stage 3.7b

| | |
|---|---|
| Inputs | One genuine `PC-` or `MSH-` asset (imported, reconstructed, fused or meshed) |
| Outputs | `VAL-` validation record (checks, verdict) |
| Dependencies | any of pointcloud_import / pointcloud_reconstruction / pointcloud_fusion / mesh_reconstruction |
| Host | offline desktop |
| Scale requirement | Reports the asset's scale status; validation can never upgrade it beyond its evidence |
| Failure modes | asset_unreadable, empty_or_degenerate_geometry, units_unconfirmed, checks_inconclusive |
| Provenance | checks + verdicts, asset_id, tool_version, processed_at |
| Acceptance criteria | Checks are computed from the actual file, never asserted; a failing verdict marks the asset failed/incomplete in the UI; results are recorded even when the news is bad |

## tunnel_axis_extraction — Stage 3.8

| | |
|---|---|
| Inputs | `MSH-` asset (or compatible genuine `PC-` asset) |
| Outputs | Axis polyline stored as a traceable asset |
| Dependencies | mesh_reconstruction |
| Host | offline desktop |
| Scale requirement | Axis carries the source geometry's scale status; cross-section/convergence work stays in Stage 4 |
| Failure modes | no_usable_geometry, degenerate_axis, ambiguous_direction |
| Provenance | method, source_geometry_id, scale_status, processed_at |
| Acceptance criteria | Axis is extracted from genuine geometry with method + quality limits recorded; ambiguous direction is surfaced, not resolved silently; output is openable in Blender |

---

## Cross-cutting requirements (all operations)

- Every record validates against its JSON Schema / zod contract before use.
- Failure is a first-class state: a failed operation writes a failed record
  and produces no asset.
- Provenance (tool, version, settings, timestamps, source ids) is recorded
  from the actual run, never inferred.
- Scale is never upgraded: ESTIMATED stays visibly ESTIMATED in any UI;
  VALIDATED requires independent evidence.
- 8 GB RAM discipline: chunking/streaming, configurable limits, cancellation,
  resumability, explicit recording of any quality-reducing settings.
