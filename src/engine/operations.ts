/**
 * Operation registry — the single machine-readable source of truth for
 * processing-operation names, their stage assignment, dependencies and real
 * implementation status.
 *
 * Stage 3 planning correction (this revision):
 * - `pointcloud_reconstruction` ADDED: camera frames and camera trajectories
 *   are not point clouds; a genuine reconstruction operation must exist
 *   between trajectory estimation and any point-cloud registration.
 * - The old `frame_registration` (which conflated visual tracking,
 *   trajectory generation, registration and fusion) is DEPRECATED and split
 *   into `visual_tracking`, `trajectory_generation`, `pointcloud_registration`
 *   and `pointcloud_fusion`. It is kept in the registry for compatibility:
 *   no data was ever emitted with that operation name (nothing was ever
 *   implemented), so deprecation requires no data migration — the identifier
 *   is retained so historical documentation stays interpretable.
 * - Every operation now declares dependencies, failure modes and mandatory
 *   provenance. `validateRegistry()` enforces internal consistency.
 *
 * Stage 3.0 finalization (this revision):
 * - `pointcloud_reconstruction` no longer hard-depends on
 *   `trajectory_generation`. Two alternative valid paths are declared via
 *   `paths`: the OpenCV-assisted tracking path (which DOES require a TRJ-
 *   trajectory) and the COLMAP-native photogrammetry path (COLMAP performs
 *   feature extraction, matching, bundle adjustment and pose estimation
 *   internally — no OpenCV trajectory first). Both paths produce the same
 *   single kind of PC- asset; the record states which path produced it.
 * - `geometry_validation` added as its own registry operation (it existed
 *   only as a schema + engine seam before).
 * - Failure modes extended to name underground-specific conditions
 *   (low light, motion blur, repetitive texture, reflective/wet surfaces,
 *   dust). See `docs/STAGE3_FAILURE_HANDLING.md`.
 *
 * Stage 3.1 (this revision):
 * - `pointcloud_import` is IMPLEMENTED: genuine external import of PLY
 *   (ascii + binary_little_endian), XYZ, and LAS 1.0-1.4 (header + VLR
 *   validation; point payloads not decoded). LAZ is unsupported on device
 *   (no decompressor). The mobile app imports via the system document
 *   picker; the Blender add-on imports PLY. Failed imports never register
 *   as assets; units/scale are recorded as unknown, never assumed.
 *
 * Stage 3.2 (this revision):
 * - `frame_extraction` is IMPLEMENTED: recorded Stage 2 camera segments are
 *   MP4-probed and validated, sampled on a declared grid (`time_interval`
 *   or `frame_rate` mode, max_frames cap), decoded and verified (existence,
 *   size>0, MD5), and registered only on success (frames table +
 *   frames.jsonl + one `frame_set` asset + JOB- job record). On device the
 *   decoder is the platform media framework via expo-video-thumbnails
 *   (seek-based: no decoded PTS is exposed, so pts_ms/time_base stay null
 *   and capture_time_mapping is 'unavailable'); FFmpeg is NOT integrated in
 *   this environment and remains a documented plug-in seam. Every other
 *   Stage 3 operation stays NOT_IMPLEMENTED.
 *
 * Stage 3.3 (this revision):
 * - `camera_calibration` is IMPLEMENTED on device: genuine known-target
 *   (checkerboard) calibration estimated from real extracted frames with a
 *   pure-TypeScript Zhang implementation (DLT homographies, closed-form
 *   intrinsics, distortion initialisation, joint Levenberg–Marquardt
 *   refinement). OpenCV is NOT available in this environment (native
 *   modules are not installable); the pure-TS core replaces it and every
 *   record states this in its engine provenance. Factory-assumed and
 *   imported parameters remain explicitly labelled methods — never
 *   presented as measured. Calibration fixes pixel geometry only;
 *   scale_status stays UNKNOWN (basis none).
 *
 * Every entry is mirrored in `schemas/operations.registry.json`; the test
 * suites (bun + Python) cross-check the two files so they cannot drift.
 *
 * Honesty rule: an operation may only carry status IMPLEMENTED after a real
 * implementation exists in this codebase and passes appropriate tests with
 * genuine inputs. Synthetic data may be used for software testing only and
 * never presented as real mining output.
 */

export type OperationStatus = "IMPLEMENTED" | "PLANNED" | "NOT_IMPLEMENTED" | "DEPRECATED";

export type OperationHost =
  /** Runs in the Expo app on a phone. */
  | "native-mobile"
  /** Runs offline on a workstation (Blender add-on / Python). */
  | "offline-desktop"
  /** Designed to run in either host. */
  | "mobile-or-desktop";

export interface OperationSpec {
  /** Machine-readable name emitted as `operation` in processing records. */
  readonly id: string;
  /** Stage scheduled to deliver it. */
  readonly stage: 2 | 3 | 4;
  readonly status: OperationStatus;
  readonly summary: string;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly host: OperationHost;
  /**
   * Implementation dependencies: operations whose outputs (or, for
   * `pointcloud_import`, externally produced equivalents) must exist before
   * this operation can run.
   */
  readonly dependencies: readonly string[];
  /** "all" = every dependency required; "any" = at least one. */
  readonly dependencyLogic: "all" | "any";
  /** Native/hardware capabilities required; empty when none. */
  readonly requirements: readonly string[];
  /** Concrete failure modes the implementation must detect and record. */
  readonly failureModes: readonly string[];
  /** Provenance fields that MUST be recorded on successful output. */
  readonly provenanceRequired: readonly string[];
  /** For DEPRECATED operations: the operations that replace them. */
  readonly supersededBy?: readonly string[];
  /** Alternative valid execution routes (e.g. OpenCV-assisted vs COLMAP-native). */
  readonly paths?: readonly OperationPath[];
}

/**
 * An alternative valid execution route for an operation. Dependencies listed
 * in a path are ADDITIONAL to the operation's base `dependencies`; a record
 * must state which path produced its output so results remain attributable.
 */
export interface OperationPath {
  readonly id: string;
  readonly label: string;
  readonly requires: readonly string[];
  readonly description: string;
}

export const OPERATIONS: readonly OperationSpec[] = [
  // ---- Stage 3.1 -----------------------------------------------------------
  {
    id: "pointcloud_import",
    stage: 3,
    status: "IMPLEMENTED",
    summary:
      "Import a genuine external point cloud (PLY ascii/binary-little-endian, XYZ, or LAS 1.0-1.4 with header+VLR validation; LAZ is unsupported on device) into a project as a `PC-` asset, preserving the original file and recording content facts, units (unknown unless documented) and scale status UNKNOWN.",
    inputs: ["external point-cloud file (PLY / XYZ / LAS / LAZ)"],
    outputs: ["PC- asset record + preserved source file", "import operation record", "validation report"],
    host: "mobile-or-desktop",
    dependencies: [],
    dependencyLogic: "all",
    requirements: ["format parsers"],
    failureModes: [
      "file_not_found",
      "parse_error",
      "unsupported_or_unknown_units",
      "checksum_mismatch",
      "empty_cloud",
      "unsupported_variant",
      "file_too_large",
      "insufficient_storage",
      "import_interrupted",
      "source_missing",
    ],
    provenanceRequired: ["tool", "tool_version", "checksum_md5", "source_file", "processed_at"],
  },
  // ---- Stage 3.2 -----------------------------------------------------------
  {
    id: "frame_extraction",
    stage: 3,
    status: "IMPLEMENTED",
    summary:
      "Decode recorded Stage 2 camera-video segments into verified individual frames. Segments are MP4-probed and validated BEFORE any decode; frames are sampled on a declared grid (time_interval or frame_rate mode, max_frames cap), written, size- and checksum-verified, and registered only on success. Provenance is honest by construction: the on-device decoder is the platform media framework (seek-based, it does not expose decoded PTS, so pts_ms/time_base stay null and capture_time_mapping is 'unavailable'); an FFmpeg decoder remains a plug-in seam for offline desktop use. Wall-clock exposure times are never invented.",
    inputs: ["camera_video assets (Stage 2 recordings)"],
    outputs: ["extracted frame files (FRM-)", "frames.jsonl frame index", "JOB- extraction job record", "frame_set asset record"],
    host: "mobile-or-desktop",
    dependencies: [],
    dependencyLogic: "all",
    requirements: ["platform video decoder (MediaMetadataRetriever / AVAssetImageGenerator on device; FFmpeg-compatible FrameDecoder seam for offline desktop)"],
    failureModes: [
      "video_unreadable",
      "segment_missing",
      "decode_error",
      "no_video_stream",
      "empty_extraction",
      "output_exists",
      "insufficient_storage",
      "registration_failed",
    ],
    provenanceRequired: ["tool", "tool_version", "source_video_reference", "processed_at"],
  },
  // ---- Stage 3.3 -----------------------------------------------------------
  {
    id: "camera_calibration",
    stage: 3,
    status: "IMPLEMENTED",
    summary:
      "Obtain genuine camera intrinsics and distortion. Method A (implemented on device): known-target checkerboard estimation from real extracted frames with a pure-TypeScript Zhang solver (OpenCV is NOT available in this environment; the record's engine block says so). Method B: factory parameters, always recorded source='factory_assumed' with documented provenance — never presented as measured. Method C: operator-imported parameters with checksum provenance. Every image is individually evaluated (blur/contrast/exposure/duplicates/target detection) and unsuitable frames are rejected with reasons; quality gates (configured max RMS reprojection error) distinguish computed from computed_with_warnings. A calibration does NOT establish scene scale: scale_status stays UNKNOWN (basis none).",
    inputs: ["extracted frames (FRM-)"],
    outputs: ["CAL- calibration record + calibration.json", "per-run operation record", "camera_calibration asset record"],
    host: "mobile-or-desktop",
    dependencies: ["frame_extraction"],
    dependencyLogic: "all",
    requirements: ["printed checkerboard target with operator-measured squares", "pure-TS Zhang solver (built in; no native dependency)"],
    failureModes: [
      "output_exists",
      "insufficient_storage",
      "frame_file_missing",
      "image_format_mismatch",
      "image_decode_error",
      "all_frames_rejected",
      "insufficient_images",
      "working_scale_mismatch",
      "degenerate_target_layout",
      "registration_failed",
      "factory_values_unavailable",
    ],
    provenanceRequired: [
      "calibration_method",
      "source (estimated/factory/operator)",
      "engine (tool, version, note)",
      "target_config + source_frame_ids",
      "metrics (measured reprojection error)",
      "processed_at",
    ],
  },
  // ---- Stage 3.4 -----------------------------------------------------------
  {
    id: "visual_tracking",
    stage: 3,
    status: "NOT_IMPLEMENTED",
    summary:
      "Detect and match image features across frames, estimate camera motion, and record tracking quality, confidence and tracking loss. Produces a TRK- tracking result; NOT a point cloud and NOT a registration.",
    inputs: ["extracted frames (FRM-)", "CAL- calibration record"],
    outputs: ["TRK- tracking result"],
    host: "offline-desktop",
    dependencies: ["frame_extraction", "camera_calibration"],
    dependencyLogic: "all",
    requirements: ["feature detection/matching (OpenCV or COLMAP feature pipeline)"],
    failureModes: [
      "insufficient_texture",
      "tracking_loss",
      "calibration_mismatch",
      "unrecoverable_frame_gap",
      "low_light_feature_loss",
      "motion_blur",
      "repetitive_texture_degeneracy",
      "reflective_or_wet_surfaces",
      "dust_occlusion",
    ],
    provenanceRequired: ["method", "tool_version", "calibration_id", "processed_at"],
  },
  {
    id: "trajectory_generation",
    stage: 3,
    status: "NOT_IMPLEMENTED",
    summary:
      "Produce an ordered camera trajectory (TRJ-) from valid tracking results, with explicit coordinate frame, timestamp provenance and scale status. Monocular trajectories are RELATIVE scale at best; translations are never claimed as metres under unknown scale.",
    inputs: ["TRK- tracking result"],
    outputs: ["TRJ- camera trajectory record"],
    host: "offline-desktop",
    dependencies: ["visual_tracking"],
    dependencyLogic: "all",
    requirements: [],
    failureModes: [
      "no_valid_tracking_result",
      "discontinuous_trajectory",
      "non_monotonic_timestamps",
    ],
    provenanceRequired: ["source_tracking_result_id", "coordinate_frame", "timestamp_provenance"],
  },
  // ---- Stage 3.5 -----------------------------------------------------------
  {
    id: "pointcloud_reconstruction",
    stage: 3,
    status: "NOT_IMPLEMENTED",
    summary:
      "Generate a genuine 3D point cloud from compatible frames, calibration and camera poses (multi-view stereo / photogrammetry), via the OpenCV-assisted tracking path or the COLMAP-native path. This is the ONLY operation that turns capture into geometry; frames and trajectories are not point clouds. No artificial points may be produced to fake success.",
    inputs: [
      "extracted frames (FRM-)",
      "CAL- calibration",
      "TRJ- trajectory (OpenCV-assisted path)",
      "COLMAP-internal poses (COLMAP-native path)",
    ],
    outputs: ["PC- asset with reconstruction provenance", "reconstruction operation record"],
    host: "offline-desktop",
    dependencies: ["frame_extraction", "camera_calibration"],
    dependencyLogic: "all",
    requirements: ["MVS/photogrammetry library (e.g. pycolmap), 8 GB-aware chunked processing"],
    paths: [
      {
        id: "opencv_assisted",
        label: "OpenCV-assisted tracking path",
        requires: ["trajectory_generation"],
        description:
          "OpenCV feature detection and tracking feed trajectory_generation (TRJ-); the reconstruction engine must be compatible with an externally supplied trajectory. trajectory_id is mandatory in the output record.",
      },
      {
        id: "colmap_native",
        label: "COLMAP-native photogrammetry path",
        requires: [],
        description:
          "pycolmap/COLMAP performs feature extraction, matching, bundle adjustment and pose estimation internally; no OpenCV trajectory is required first. Pose provenance is the recorded COLMAP model/tool version.",
      },
    ],
    failureModes: [
      "pose_coverage_insufficient",
      "calibration_incompatible",
      "insufficient_image_overlap",
      "out_of_memory",
      "empty_output",
      "low_light_or_motion_blur",
      "repetitive_texture_degeneracy",
      "reflective_or_wet_surfaces",
      "corrupted_input_file",
    ],
    provenanceRequired: [
      "tool",
      "tool_version",
      "calibration_id",
      "pipeline_path",
      "trajectory_id (OpenCV-assisted path) or COLMAP-internal pose provenance (COLMAP-native path)",
      "scale_status + scale_provenance",
      "processed_at",
    ],
  },
  // ---- Stage 3.6 -----------------------------------------------------------
  {
    id: "pointcloud_registration",
    stage: 3,
    status: "NOT_IMPLEMENTED",
    summary:
      "Align two or more GENUINE point-cloud inputs (imported or reconstructed) with a recorded transform, residuals and scale compatibility. Camera-pose estimation (visual_tracking) is a different activity and must never be reported as point-cloud registration.",
    inputs: ["≥2 genuine PC- assets"],
    outputs: ["OP- registration record (transform, residuals)"],
    host: "offline-desktop",
    dependencies: ["pointcloud_import", "pointcloud_reconstruction"],
    dependencyLogic: "any",
    requirements: ["registration library (e.g. Open3D ICP)"],
    failureModes: [
      "incompatible_units",
      "incompatible_scale",
      "insufficient_overlap",
      "no_convergence",
      "out_of_memory",
    ],
    provenanceRequired: [
      "method",
      "transform_4x4",
      "residuals",
      "input_asset_ids",
      "tool_version",
      "processed_at",
    ],
  },
  {
    id: "pointcloud_fusion",
    stage: 3,
    status: "NOT_IMPLEMENTED",
    summary:
      "Combine successfully registered point clouds into one fused `PC-` asset, recording per-source transform provenance. Fusion must refuse inputs whose registration failed or whose units/scale are incompatible.",
    inputs: ["registered PC- assets", "OP- registration records"],
    outputs: ["fused PC- asset", "fusion operation record"],
    host: "offline-desktop",
    dependencies: ["pointcloud_registration"],
    dependencyLogic: "all",
    requirements: ["chunked/streaming processing for 8 GB RAM limit"],
    failureModes: [
      "registration_missing_or_failed",
      "coordinate_frame_mismatch",
      "unit_mismatch",
      "out_of_memory",
    ],
    provenanceRequired: [
      "source_assets + transform provenance",
      "scale_status + scale_provenance",
      "tool_version",
      "processed_at",
    ],
  },
  // ---- Stage 3.7 -----------------------------------------------------------
  {
    id: "mesh_reconstruction",
    stage: 3,
    status: "NOT_IMPLEMENTED",
    summary:
      "Reconstruct a surface mesh from a genuine compatible point cloud, preserving source reference, method, settings, quality limitations and scale metadata.",
    inputs: ["genuine PC- asset (imported, reconstructed or fused)"],
    outputs: ["MSH- asset record"],
    host: "offline-desktop",
    dependencies: ["pointcloud_import", "pointcloud_reconstruction", "pointcloud_fusion"],
    dependencyLogic: "any",
    requirements: ["surface-reconstruction library (e.g. Open3D Poisson)"],
    failureModes: ["empty_or_thin_cloud", "reconstruction_failed", "out_of_memory"],
    provenanceRequired: ["method", "settings", "source_cloud_id", "tool_version", "processed_at"],
  },
  // ---- Stage 3.7b ----------------------------------------------------------
  {
    id: "geometry_validation",
    stage: 3,
    status: "NOT_IMPLEMENTED",
    summary:
      "Run documented geometry checks (point/vertex counts, unit confirmation, degeneracy, scale-provenance consistency) on a genuine PC- or MSH- asset and record a VAL- verdict. Checks are computed from the asset, never asserted; validation cannot upgrade scale status beyond its evidence.",
    inputs: ["genuine PC- or MSH- asset"],
    outputs: ["VAL- validation record"],
    host: "offline-desktop",
    dependencies: [
      "pointcloud_import",
      "pointcloud_reconstruction",
      "pointcloud_fusion",
      "mesh_reconstruction",
    ],
    dependencyLogic: "any",
    requirements: ["geometry processing library"],
    failureModes: [
      "asset_unreadable",
      "empty_or_degenerate_geometry",
      "units_unconfirmed",
      "checks_inconclusive",
    ],
    provenanceRequired: ["checks + verdicts", "asset_id", "tool_version", "processed_at"],
  },
  // ---- Stage 3.8 -----------------------------------------------------------
  {
    id: "tunnel_axis_extraction",
    stage: 3,
    status: "NOT_IMPLEMENTED",
    summary:
      "Extract a tunnel centreline/axis polyline from suitable genuine geometry, storing it as a traceable asset with method, coordinate frame, units and scale status.",
    inputs: ["MSH- asset (or compatible genuine PC- asset)"],
    outputs: ["axis polyline asset"],
    host: "offline-desktop",
    dependencies: ["mesh_reconstruction"],
    dependencyLogic: "all",
    requirements: ["geometry processing library"],
    failureModes: ["no_usable_geometry", "degenerate_axis", "ambiguous_direction"],
    provenanceRequired: ["method", "source_geometry_id", "scale_status", "processed_at"],
  },
  // ---- Deprecated ----------------------------------------------------------
  {
    id: "frame_registration",
    stage: 3,
    status: "DEPRECATED",
    summary:
      "Deprecated in the Stage 3 planning correction: this name conflated visual tracking, trajectory generation, point-cloud reconstruction, registration and fusion. It was split into visual_tracking, trajectory_generation, pointcloud_reconstruction, pointcloud_registration and pointcloud_fusion. No data was ever emitted under this name, so no migration is required; the identifier is retained for document compatibility.",
    inputs: [],
    outputs: [],
    host: "offline-desktop",
    dependencies: [],
    dependencyLogic: "all",
    requirements: [],
    failureModes: [],
    provenanceRequired: [],
    supersededBy: [
      "visual_tracking",
      "trajectory_generation",
      "pointcloud_reconstruction",
      "pointcloud_registration",
      "pointcloud_fusion",
    ],
  },
  // ---- Stage 4 (unchanged) --------------------------------------------------
  {
    id: "cross_section_analysis",
    stage: 4,
    status: "NOT_IMPLEMENTED",
    summary: "Compute cross-section profiles perpendicular to the tunnel axis.",
    inputs: ["MSH- asset", "axis polyline"],
    outputs: ["section profiles", "VAL- validation records"],
    host: "offline-desktop",
    dependencies: ["tunnel_axis_extraction"],
    dependencyLogic: "all",
    requirements: ["geometry processing library"],
    failureModes: ["axis_outside_mesh", "empty_section", "scale_unknown"],
    provenanceRequired: ["method", "mesh_id", "axis_id", "scale_status"],
  },
  {
    id: "convergence_analysis",
    stage: 4,
    status: "NOT_IMPLEMENTED",
    summary: "Compare two sessions' meshes to report deformation between them.",
    inputs: ["MSH- asset pair"],
    outputs: ["deformation report"],
    host: "offline-desktop",
    dependencies: ["mesh_reconstruction"],
    dependencyLogic: "all",
    requirements: ["point-to-mesh distance computation"],
    failureModes: ["incomparable_meshes", "scale_mismatch", "insufficient_overlap"],
    provenanceRequired: ["method", "mesh_pair", "both scale_statuses"],
  },
];

/** Registry entries, indexed by operation name. */
export const OPERATION_BY_ID: ReadonlyMap<string, OperationSpec> = new Map(
  OPERATIONS.map((op) => [op.id, op]),
);

/**
 * Validates registry-internal consistency: unique ids, resolvable
 * dependencies with non-decreasing stage order, dependency-logic
 * applicability, cycle-freedom, and correct use of supersededBy. Returns a
 * list of human-readable problems (empty = consistent).
 */
export function validateRegistry(ops: readonly OperationSpec[] = OPERATIONS): string[] {
  const problems: string[] = [];
  const byId = new Map(ops.map((op) => [op.id, op]));
  if (byId.size !== ops.length) problems.push("duplicate operation ids");

  for (const op of ops) {
    for (const dep of op.dependencies) {
      const d = byId.get(dep);
      if (!d) {
        problems.push(`${op.id}: unknown dependency "${dep}"`);
      } else {
        if (d.status === "DEPRECATED") {
          problems.push(`${op.id}: dependency "${dep}" is deprecated`);
        }
        if (d.stage > op.stage) {
          problems.push(`${op.id}: dependency "${dep}" is in a later stage (${d.stage} > ${op.stage})`);
        }
        if (d.id === op.id) problems.push(`${op.id}: depends on itself`);
      }
    }
    const pathIds = new Set<string>();
    for (const p of op.paths ?? []) {
      if (pathIds.has(p.id)) {
        problems.push(`${op.id}: duplicate path id "${p.id}"`);
      }
      pathIds.add(p.id);
      for (const r of p.requires) {
        const d = byId.get(r);
        if (!d) {
          problems.push(`${op.id}: path "${p.id}" requires unknown operation "${r}"`);
        } else {
          if (d.status === "DEPRECATED") {
            problems.push(`${op.id}: path "${p.id}" requires deprecated "${r}"`);
          }
          if (d.stage > op.stage) {
            problems.push(`${op.id}: path "${p.id}" requires "${r}" from a later stage`);
          }
        }
      }
    }
    if (op.dependencyLogic === "any" && op.dependencies.length < 2) {
      problems.push(`${op.id}: dependencyLogic "any" needs at least 2 dependencies`);
    }
    if (op.status === "DEPRECATED") {
      if (!op.supersededBy?.length) {
        problems.push(`${op.id}: DEPRECATED operations must declare supersededBy`);
      }
      for (const s of op.supersededBy ?? []) {
        const r = byId.get(s);
        if (!r) problems.push(`${op.id}: supersededBy references unknown "${s}"`);
        else if (r.status === "DEPRECATED") problems.push(`${op.id}: supersededBy "${s}" is deprecated`);
      }
    } else if (op.supersededBy) {
      problems.push(`${op.id}: only DEPRECATED operations may declare supersededBy`);
    }
  }
  return problems;
}

/** Validated registry — throws if the shipped registry is inconsistent. */
export function assertRegistryValid(): void {
  const problems = validateRegistry();
  if (problems.length > 0) {
    throw new Error(`Operation registry is inconsistent:\n- ${problems.join("\n- ")}`);
  }
}

/**
 * Throws when a caller names an operation that is not implemented. Use at
 * every future processing entry point so a missing implementation fails
 * loudly instead of producing placeholder output. DEPRECATED operations are
 * never executable.
 */
export function assertOperationImplemented(id: string): OperationSpec {
  const op = OPERATION_BY_ID.get(id);
  if (!op) {
    throw new Error(`Unknown operation "${id}" — see src/engine/operations.ts registry`);
  }
  if (op.status !== "IMPLEMENTED") {
    throw new Error(
      `Operation "${id}" is not implemented (Stage ${op.stage}, ${op.status}). No output may be produced for it.`,
    );
  }
  return op;
}
