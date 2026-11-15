# Stage 3 failure handling — underground environment risks

Underground environments are hostile to camera-based reconstruction. This
document defines, per processing operation, how failure is detected,
reported, recovered from — and when the result **must be rejected**. It is
the engineering complement to the registry's `failure_modes` fields; the
registry names the machine-readable failure, this document explains the
policy.

**Governing rules (binding):**

1. The system is allowed — and required — to **reject an unreconstructable
   scan**. A failed or inadequate input produces a failed/incomplete
   record and **no asset**.
2. **Never manufacture** a successful trajectory, point cloud, mesh or
   measurement when the input is inadequate. No filler points, no
   interpolated frames, no guessed poses presented as real.
3. A failed scan is clearly identified as failed or incomplete — never
   rendered as a successful scan in any UI.
4. Every failure is recorded in the operation record: which failure mode,
   at which input, with the tool/version and settings that ran.
5. Retries may re-run with different *settings* (explicitly recorded); a
   retry that changes quality-reducing parameters is visible as such
   (see `docs/STAGE3_COMPATIBILITY_MATRIX.md` §D).

---

## Underground risk catalogue

| Risk | Typical effect on processing |
|---|---|
| Low illumination | Feature-poor images; noise; detector failure |
| Rapid illumination changes (lamps, headlamps) | Detector instability between frames; matching failures |
| Repetitive rock texture (periodic strata, shotcrete patterns) | Ambiguous matches; wrong correspondences; unstable/incorrect poses |
| Feature-poor surfaces (smooth freshly-cut walls) | Too few features; tracking loss; unreconstructable regions |
| Dust and airborne particles | Occlusion, false features, contrast loss |
| Water and reflective surfaces; wet/shiny rock | Specular highlights move with the camera — false features, outlier correspondences |
| Motion blur (long exposure in low light) | Feature detection/matching degradation |
| Camera movement and vibration (walking, machinery) | Blur, rolling-shutter distortion, poor frame overlap |
| Similar-looking tunnel walls (self-similar geometry) | Loop-closure and matching ambiguity; drifted trajectories |
| Poor image overlap between consecutive captures | Insufficient baseline/overlap for MVS; holes in coverage |
| Insufficient visual features overall | SfM fails or produces a sparse, unreliable model |
| Tracking loss | Frame gaps with unknown motion |
| Failed feature matching | Reconstruction cannot start or aborts mid-run |
| Incorrect camera pose estimation | Misplaced cameras; warped or doubled geometry |
| Unstable reconstruction | Non-convergent bundle adjustment; contradictory geometry |
| Inadequate geometric coverage | Model covers a fraction of the tunnel; unusable for analysis |
| Inconsistent scale | Mixing relative and metric sources without provenance |
| Incompatible coordinate frames | Registration/fusion of assets from different frames without a recorded transform |
| Corrupted or incomplete input files | Decode/parse failure; truncated models |

## Per-operation handling

### frame_extraction

| | |
|---|---|
| Preconditions | Stage 2 recording exists, checksum matches manifest, sufficient free disk |
| Input validation | Container readable; codec supported; segment sequence complete per manifest |
| Failure conditions | `video_unreadable`, `segment_missing`, `decode_error`, `disk_full`, `duplicate_frame_index`, `corrupted_input_file` |
| Expected error/warning | Failed `JOB-` record naming the segment and codec error; warning when PTS gaps indicate dropped segments |
| Recovery/retry | Re-run per segment; completed segments are kept and not re-extracted (incremental) |
| May continue? | Yes with partial output — the job record marks which segments failed; frames are never re-timestamped to hide gaps |
| Rejected? | The job fails (not the session) when any segment is unreadable; no fake PTS values are written |
| Provenance | tool + version + configuration line, per-segment source references, processed_at |

### camera_calibration

| | |
|---|---|
| Preconditions | Frames exist; target images or declared factory data available |
| Input validation | Enough detector-visible targets with varied pose; image size matches calibration |
| Failure conditions | `insufficient_images`, `detector_failure`, `degenerate_target_layout`, `factory_values_unavailable`; low-light blur is a common real cause |
| Expected error/warning | Failed `CAL-`-less record: which check failed and why; computed reprojection error attached when estimation ran |
| Recovery/retry | Re-run with additional calibration frames (new attempt, both attempts recorded) |
| May continue? | Only via explicit `factory_assumed` labelling — never silently |
| Rejected? | Yes: no calibration record, no downstream tracking/reconstruction |
| Provenance | method, source (estimated/factory/operator), computed error, processed_at |

### visual_tracking (Path A)

| | |
|---|---|
| Preconditions | Frames + valid `CAL-` of matching image size |
| Input validation | Feature count per frame above a configured floor; calibration/frames compatible |
| Failure conditions | `insufficient_texture`, `tracking_loss`, `calibration_mismatch`, `unrecoverable_frame_gap`, `low_light_feature_loss`, `motion_blur`, `repetitive_texture_degeneracy`, `reflective_or_wet_surfaces`, `dust_occlusion` |
| Expected error/warning | `TRK-` record with status `partial`/`failed`, `lost_frame_count` > 0, quality note naming the dominant condition (e.g. "tracking loss after lamp occlusion") |
| Recovery/retry | Re-run with different detector/settings — recorded as a new attempt; retries never overwrite the failed record |
| May continue? | Partial tracking may proceed to trajectory_generation only if the gaps are explicitly carried as non-inlier poses |
| Rejected? | A failed tracking result must not be converted into a trajectory |
| Provenance | method, tool_version, calibration_id, per-condition counts, processed_at |

### trajectory_generation (Path A)

| | |
|---|---|
| Preconditions | `TRK-` record with status succeeded or partial |
| Input validation | Timestamps monotonic; poses reference frame ids; coordinate frame declared |
| Failure conditions | `no_valid_tracking_result`, `discontinuous_trajectory`, `non_monotonic_timestamps` |
| Expected error/warning | Failed record; warnings when the fraction of non-inlier poses is high |
| Recovery/retry | Only from a (new) tracking result — never by smoothing/inventing poses over gaps |
| May continue? | Partial trajectories carry their gaps as non-inlier poses; consumers decide |
| Rejected? | Trajectories derived from failed tracking are refused |
| Provenance | source_tracking_result_id, coordinate_frame, timestamp_provenance, processed_at |

### pointcloud_reconstruction (both paths)

| | |
|---|---|
| Preconditions | Frames + `CAL-`; Path A: `TRJ-`; Path B: COLMAP-internal poses; sufficient free disk |
| Input validation | Image sizes match calibration; frame overlap above configured minimum; pose coverage of the frame set |
| Failure conditions | `pose_coverage_insufficient`, `insufficient_image_overlap`, `calibration_incompatible`, `out_of_memory`, `empty_output`, `low_light_or_motion_blur`, `repetitive_texture_degeneracy`, `reflective_or_wet_surfaces`, `corrupted_input_file`; Path B adds COLMAP's own registration/BA failures (reported verbatim, never masked) |
| Expected error/warning | Failed operation record with the concrete cause; warnings for sparse/partial models that DO complete (e.g. "model covers 40% of frames") |
| Recovery/retry | Re-run per capture segment with adjusted, recorded settings (max_image_size, matching window); a memory failure must surface as `out_of_memory`, never as a quiet quality drop |
| May continue? | A partial model may be kept only as an explicitly incomplete asset — scale status, coverage figures and the `pipeline_path` recorded |
| Rejected? | **Yes** — an unreconstructable scan (no viable model) produces no `PC-` asset. Empty or degenerate output is a failure, not a zero-point cloud |
| Provenance | tool, tool_version, pipeline_path, calibration_id, trajectory_id or COLMAP pose provenance, settings, scale_status + scale_provenance, coverage stats, processed_at |

### pointcloud_import

| | |
|---|---|
| Preconditions | Source file exists and is readable |
| Input validation | Format detection; parse; units/CRS metadata read; checksum; non-empty |
| Failure conditions | `file_not_found`, `parse_error`, `unsupported_or_unknown_units`, `checksum_mismatch`, `empty_cloud`, truncated file |
| Expected error/warning | Failed record; **warning + recorded limitation when CRS metadata is missing or uncertain — never a silent transformation or invented CRS** |
| Recovery/retry | Re-import after operator supplies units documentation (recorded as operator-confirmed provenance) |
| May continue? | Only with the units question explicitly resolved (confirmed by operator or source metadata) |
| Rejected? | Yes — unknown units without resolution produce no asset |
| Provenance | tool, tool_version, checksum_md5, source_file, units/CRS findings, processed_at |

### pointcloud_registration / pointcloud_fusion

| | |
|---|---|
| Preconditions | ≥2 genuine `PC-` assets; documented units and coordinate frames |
| Input validation | Scale compatibility checked; overlap estimated; frames compatible or a recorded transform exists |
| Failure conditions | `incompatible_units`, `incompatible_scale`, `insufficient_overlap`, `no_convergence`, `registration_missing_or_failed`, `coordinate_frame_mismatch`, `unit_mismatch`, `out_of_memory` |
| Expected error/warning | Failed `OP-` record with residuals when convergence happened but was poor; warnings when RMSE is high relative to cloud scale |
| Recovery/retry | Re-run with different method/settings (recorded); a failed registration blocks fusion of the affected sources |
| May continue? | Fusion proceeds only with successful registration provenance per source |
| Rejected? | Yes — no fused asset from failed/missing registrations |
| Provenance | method, transform, residuals, per-source ids, tool_version, processed_at |

### mesh_reconstruction / tunnel_axis_extraction / geometry_validation

| | |
|---|---|
| Preconditions | Genuine source asset; its validation status known |
| Input validation | Point/vertex density above floor; source scale status recorded |
| Failure conditions | `empty_or_thin_cloud`, `reconstruction_failed`, `out_of_memory`; `no_usable_geometry`, `degenerate_axis`, `ambiguous_direction`; `asset_unreadable`, `units_unconfirmed`, `checks_inconclusive` |
| Expected error/warning | Failed record; ambiguous axis direction is surfaced, never silently resolved |
| Recovery/retry | Settings-based re-runs, recorded |
| May continue? | Mesh inherits the cloud's scale status — never upgraded; a failing validation verdict marks the asset failed/incomplete in the UI |
| Rejected? | Yes for degenerate output |
| Provenance | method, settings, source ids, scale status, checks + verdicts, tool_version, processed_at |

---

## Provenance requirements on failure

Even a failed run records: operation id, the concrete failure mode,
tool + version, settings in effect, the input references, timestamps, and
free-text detail. A failed record with no provenance is treated as a bug.
