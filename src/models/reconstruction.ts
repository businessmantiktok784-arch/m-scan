/**
 * Stage 3 reconstruction data models — TypeScript mirror of the JSON Schemas
 * in `schemas/` (frame-extraction, camera-calibration, tracking-result,
 * pointcloud-reconstruction, registration-operation, pointcloud-fusion,
 * geometry-validation) plus the pointcloud-asset v1.2 fields mirrored in
 * `src/models/models.ts`.
 *
 * Pure TypeScript (no React Native imports) so everything here is testable
 * off-device with `bun test`.
 *
 * Honesty rules, as corrected by the Stage 3 planning review:
 * - Frame timestamps come from the video container (presentation
 *   timestamps). Wall-clock exposure time stays null unless independently
 *   established.
 * - Calibration values come from real estimation or are explicitly labelled
 *   `factory_assumed`. A calibration fixes camera geometry, NOT scene scale.
 * - A monocular camera trajectory does NOT provide metric scale. Scale
 *   provenance carries the real-world basis, and the refinements below
 *   enforce: UNKNOWN ⇔ no basis; operator-assumed scale is ESTIMATED at
 *   best; VALIDATED requires independent metric evidence.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Scale (the single most abuse-prone field — documented source required)
// ---------------------------------------------------------------------------

export const scaleStatusSchema = z.enum(["UNKNOWN", "RELATIVE", "ESTIMATED", "VALIDATED"]);
export type ScaleStatus = z.infer<typeof scaleStatusSchema>;

/**
 * Bases for a metric-scale claim, restricted to genuine evidence:
 * - `known_dimension`: a physically measured reference in the scene
 *   (tape-measured distance, calibration target of known size).
 * - `survey_control`: mine survey control points.
 * - `validated_depth`: depth measurements validated independently.
 * - `external_metric_scan`: compatible metric external scanner data.
 * - `operator_assumed`: an operator-supplied figure — ESTIMATED at best,
 *   never VALIDATED.
 * - `other_documented`: any other independently justified metric reference,
 *   documented in `detail`.
 */
export const scaleBasisSchema = z.enum([
  "none",
  "known_dimension",
  "survey_control",
  "validated_depth",
  "external_metric_scan",
  "operator_assumed",
  "other_documented",
]);
export type ScaleBasis = z.infer<typeof scaleBasisSchema>;

const INDEPENDENT_METRIC_BASES = new Set([
  "known_dimension",
  "survey_control",
  "validated_depth",
  "external_metric_scan",
]);

export const scaleProvenanceSchema = z
  .object({
    scale_status: scaleStatusSchema,
    basis: scaleBasisSchema,
    /** What was measured and how; required prose whenever a basis is claimed. */
    detail: z.string().max(2000).default(""),
    measured_by: z.string().max(120).default(""),
    created_at: z.string().datetime({ offset: true }),
  })
  .refine(
    (p) => (p.scale_status === "UNKNOWN") === (p.basis === "none"),
    {
      message:
        "scale_status UNKNOWN requires basis 'none'; any other status requires a concrete basis",
    },
  )
  .refine((p) => !(p.scale_status === "VALIDATED" && p.basis === "operator_assumed"), {
    message: "operator_assumed scale can never be VALIDATED",
  })
  .refine(
    (p) =>
      !(p.scale_status === "VALIDATED" && !INDEPENDENT_METRIC_BASES.has(p.basis)),
    {
      message:
        "VALIDATED requires independent metric evidence (known_dimension, survey_control, validated_depth or external_metric_scan)",
    },
  );
export type ScaleProvenance = z.infer<typeof scaleProvenanceSchema>;

/** Metre scale factor; only meaningful when provenance is attached. */
export const metricScaleSchema = z.object({
  /** metres per reconstruction unit; > 0 when scale is claimed. */
  metres_per_unit: z.number().positive(),
  provenance: scaleProvenanceSchema,
});
export type MetricScale = z.infer<typeof metricScaleSchema>;

/** Where a scale status may sit relative to the evidence. */
export const SCALE_RULES_DOC = Object.freeze({
  unknown: "No scale information (basis 'none').",
  relative: "Only up-to-an-unknown-factor scale (typical monocular result).",
  estimated:
    "Metric scale claimed from an operator assumption or weak evidence — UI must show it as estimated.",
  validated: "Metric scale confirmed against independent evidence; algorithm success alone is not validation.",
});

// ---------------------------------------------------------------------------
// Frame extraction (operation: frame_extraction)
// ---------------------------------------------------------------------------

export const frameExtractionJobSchema = z.object({
  job_id: z.string().regex(/^JOB-[0-9a-f]{8}$/),
  project_id: z.string().regex(/^MS-[0-9a-f]{8}$/),
  session_id: z.string().regex(/^SES-[0-9a-f]{8}$/),
  /** Asset id of the camera_video input, from the capture manifest. */
  source_asset_id: z.string().min(1),
  status: z.enum(["queued", "running", "done", "failed"]),
  requested_fps: z.number().positive().nullable(),
  output_directory: z.string().min(1),
  frames_extracted: z.number().int().nonnegative().nullable(),
  started_at: z.string().datetime({ offset: true }),
  finished_at: z.string().datetime({ offset: true }).nullable(),
  message: z.string().max(2000).default(""),
});
export type FrameExtractionJob = z.infer<typeof frameExtractionJobSchema>;

export const extractedFrameSchema = z.object({
  frame_id: z.string().regex(/^FRM-[0-9a-f]{8}$/),
  job_id: z.string().regex(/^JOB-[0-9a-f]{8}$/),
  file_path: z.string().min(1),
  frame_index: z.number().int().nonnegative(),
  /**
   * Video presentation timestamp in milliseconds — the only timestamp the
   * container truthfully provides. Wall-clock capture time for a frame is
   * NOT recoverable from phone video alone; leave null rather than guess.
   */
  pts_ms: z.number().nonnegative().nullable(),
  wall_clock_ms: z.number().int().nonnegative().nullable(),
  byte_size: z.number().int().nonnegative(),
});
export type ExtractedFrame = z.infer<typeof extractedFrameSchema>;

// ---------------------------------------------------------------------------
// Camera calibration (operation: camera_calibration)
// ---------------------------------------------------------------------------

export const cameraCalibrationSchema = z.object({
  calibration_id: z.string().regex(/^CAL-[0-9a-f]{8}$/),
  project_id: z.string().regex(/^MS-[0-9a-f]{8}$/),
  session_id: z.string().regex(/^SES-[0-9a-f]{8}$/).nullable(),
  camera_label: z.string().min(1).max(80),
  image_width: z.number().int().positive(),
  image_height: z.number().int().positive(),
  /**
   * v1 enum, extended additively in Stage 3.3: the shipped solver estimates
   * `opencv_radial_tangential_k1_k2_p1_p2_k3` (OpenCV order [k1,k2,p1,p2,k3]).
   * Older values remain valid — v1 documents still parse.
   */
  model: z.enum(["pinhole_radial_k1_k2_k3", "opencv_fisheye", "unspecified", "opencv_radial_tangential_k1_k2_p1_p2_k3", "none"]),
  fx: z.number().positive(),
  fy: z.number().positive(),
  cx: z.number().nonnegative(),
  cy: z.number().nonnegative(),
  /** Distortion coefficients, order documented by `model`. */
  distortion: z.array(z.number()).max(8),
  /** Where the numbers came from — the referee against invented values. */
  source: z.enum(["estimated_from_capture", "factory_assumed", "operator_provided"]),
  calibration_method: z.string().max(200).default(""),
  created_at: z.string().datetime({ offset: true }),
});
export type CameraCalibration = z.infer<typeof cameraCalibrationSchema>;

// ---------------------------------------------------------------------------
// Visual tracking (operation: visual_tracking) — NOT a trajectory, NOT geometry
// ---------------------------------------------------------------------------

export const trackingResultSchema = z.object({
  result_id: z.string().regex(/^TRK-[0-9a-f]{8}$/),
  project_id: z.string().regex(/^MS-[0-9a-f]{8}$/),
  session_id: z.string().regex(/^SES-[0-9a-f]{8}$/),
  method: z.enum([
    "orb_slam3_monocular",
    "colmap_feature_pipeline",
    "opencv_feature_trajectory",
    "other",
  ]),
  method_detail: z.string().max(200).default(""),
  status: z.enum(["succeeded", "partial", "failed"]),
  /** Frames with usable tracked motion vs total frames; null when unknown. */
  tracked_frame_count: z.number().int().nonnegative().nullable(),
  total_frame_count: z.number().int().nonnegative().nullable(),
  /** Frames where tracking was lost and motion is unknown. */
  lost_frame_count: z.number().int().nonnegative().nullable(),
  calibration_id: z.string().regex(/^CAL-[0-9a-f]{8}$/),
  /** Relative-motion quality summary; never an accuracy claim. */
  quality_note: z.string().max(1000).default(""),
  /**
   * Tracking output has at most RELATIVE scale — monocular motion is never
   * metric by itself. VALIDATED is structurally unreachable here because no
   * provenance basis exists at this point.
   */
  scale_status: z.literal("RELATIVE").or(z.literal("UNKNOWN")),
  created_at: z.string().datetime({ offset: true }),
});
export type TrackingResult = z.infer<typeof trackingResultSchema>;

// ---------------------------------------------------------------------------
// Camera trajectory (operation: trajectory_generation)
// ---------------------------------------------------------------------------

export const trajectoryPoseSchema = z.object({
  pose_id: z.string().regex(/^POSE-[0-9a-f]{8}$/),
  frame_id: z.string().regex(/^FRM-[0-9a-f]{8}$/).nullable(),
  pts_ms: z.number().nonnegative().nullable(),
  /** Position in reconstruction units — metric meaning comes from scale_status. */
  position: z.object({ x: z.number(), y: z.number(), z: z.number() }).nullable(),
  /** Rotation as unit quaternion (w, x, y, z). */
  rotation: z.object({ w: z.number(), x: z.number(), y: z.number(), z: z.number() }).nullable(),
  /** Tracking quality for this pose; false = unreliable, consumers must filter. */
  inlier: z.boolean(),
});
export type TrajectoryPose = z.infer<typeof trajectoryPoseSchema>;

export const cameraTrajectorySchema = z.object({
  trajectory_id: z.string().regex(/^TRJ-[0-9a-f]{8}$/),
  project_id: z.string().regex(/^MS-[0-9a-f]{8}$/),
  session_id: z.string().regex(/^SES-[0-9a-f]{8}$/),
  /** The tracking result this trajectory was generated from. */
  source_tracking_result_id: z.string().regex(/^TRK-[0-9a-f]{8}$/),
  /** Explicit coordinate frame, e.g. "first_camera_frame" or "arbitrary_world". */
  coordinate_frame: z.string().min(1).max(80),
  /** Where the pose timestamps come from; PTS-based by design. */
  timestamp_provenance: z.enum(["video_pts", "other_documented"]),
  timestamp_provenance_detail: z.string().max(500).default(""),
  poses: z.array(trajectoryPoseSchema).max(100000),
  /** Monocular trajectories are never metric without independent evidence. */
  scale_status: scaleStatusSchema,
  scale_provenance: scaleProvenanceSchema.nullable(),
  created_at: z.string().datetime({ offset: true }),
});
export type CameraTrajectory = z.infer<typeof cameraTrajectorySchema>;

// ---------------------------------------------------------------------------
// Point-cloud reconstruction (operation: pointcloud_reconstruction)
// ---------------------------------------------------------------------------

/**
 * Which declared reconstruction path produced a cloud. The two registry
 * paths (see `src/engine/operations.ts`) are architecturally valid
 * alternatives; provenance must state which one ran.
 */
export const pipelinePathSchema = z.enum([
  "opencv_assisted",
  "colmap_native",
  "other_documented",
]);
export type PipelinePath = z.infer<typeof pipelinePathSchema>;

export const pointcloudReconstructionRecordSchema = z.object({
  operation_id: z.string().regex(/^OP-[0-9a-f]{8}$/),
  project_id: z.string().regex(/^MS-[0-9a-f]{8}$/),
  session_ids: z.array(z.string().regex(/^SES-[0-9a-f]{8}$/)).min(1),
  calibration_id: z.string().regex(/^CAL-[0-9a-f]{8}$/),
  /**
   * Mandatory for the OpenCV-assisted path (the TRJ- trajectory is the pose
   * input). May be null on the COLMAP-native path, where COLMAP estimates
   * poses internally — the tool/tool_version provenance then identifies the
   * COLMAP model that produced them.
   */
  trajectory_id: z.string().regex(/^TRJ-[0-9a-f]{8}$/).nullable(),
  source_frame_job_ids: z.array(z.string().regex(/^JOB-[0-9a-f]{8}$/)).min(1),
  pipeline_path: pipelinePathSchema,
  method: z.enum([
    "colmap_mvs",
    "colmap_sfm_points",
    "trajectory_based_mvs",
    "other",
  ]),
  method_detail: z.string().max(200).default(""),
  output_asset_id: z.string().regex(/^PC-[0-9a-f]{8}$/).nullable(),
  point_count: z.number().int().nonnegative().nullable(),
  /** Processing provenance — recorded, never inferred. */
  tool: z.string().min(1).max(120),
  tool_version: z.string().min(1).max(60),
  settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  /** Positions are in reconstruction units until a scale basis is fused in. */
  scale_status: scaleStatusSchema,
  scale_provenance: scaleProvenanceSchema.nullable(),
  status: z.enum(["queued", "running", "done", "failed"]),
  started_at: z.string().datetime({ offset: true }),
  finished_at: z.string().datetime({ offset: true }).nullable(),
  message: z.string().max(2000).default(""),
})
  .refine(
    (r) => r.pipeline_path !== "opencv_assisted" || r.trajectory_id !== null,
    { message: "the OpenCV-assisted path requires a TRJ- trajectory record (trajectory_id)" },
  );
export type PointCloudReconstructionRecord = z.infer<typeof pointcloudReconstructionRecordSchema>;

// ---------------------------------------------------------------------------
// Point-cloud registration (operation: pointcloud_registration)
// ---------------------------------------------------------------------------

export const registrationOperationSchema = z.object({
  operation_id: z.string().regex(/^OP-[0-9a-f]{8}$/),
  project_id: z.string().regex(/^MS-[0-9a-f]{8}$/),
  method: z.enum(["icp_point_to_point", "icp_point_to_plane", "multiway", "other"]),
  method_detail: z.string().max(200).default(""),
  /** Registration aligns ≥2 genuine point clouds — never camera poses. */
  input_asset_ids: z.array(z.string().regex(/^PC-[0-9a-f]{8}$/)).min(2),
  /** The cloud the others were aligned onto, when applicable. */
  target_asset_id: z.string().regex(/^PC-[0-9a-f]{8}$/).nullable(),
  output_asset_id: z.string().regex(/^PC-[0-9a-f]{8}$/).nullable(),
  /** Explicit coordinate frame of the aligned result. */
  coordinate_frame: z.string().min(1).max(80).default("target_asset_frame"),
  /** Row-major 4x4 transform; null while queued/running/failed. */
  transform_4x4: z.array(z.number()).length(16).nullable(),
  residual: z
    .object({
      /** Root-mean-square correspondence distance in reconstruction units. */
      rmse: z.number().nonnegative(),
      correspondences: z.number().int().nonnegative(),
    })
    .nullable(),
  /** Whether the inputs' scale claims were compatible; null = unassessed. */
  scale_compatibility: z.enum(["compatible", "incompatible", "unassessed"]).nullable(),
  /** Metric scale applied to the aligned output, with provenance. */
  metric_scale: metricScaleSchema.nullable(),
  status: z.enum(["queued", "running", "done", "failed"]),
  started_at: z.string().datetime({ offset: true }),
  finished_at: z.string().datetime({ offset: true }).nullable(),
  message: z.string().max(2000).default(""),
});
export type RegistrationOperation = z.infer<typeof registrationOperationSchema>;

// ---------------------------------------------------------------------------
// Point-cloud fusion (operation: pointcloud_fusion)
// ---------------------------------------------------------------------------

export const fusionOperationSchema = z.object({
  operation_id: z.string().regex(/^OP-[0-9a-f]{8}$/),
  project_id: z.string().regex(/^MS-[0-9a-f]{8}$/),
  method: z.enum(["concatenate_aligned", "voxel_merged", "other"]),
  method_detail: z.string().max(200).default(""),
  /** Every source must carry its registration provenance. */
  sources: z
    .array(
      z.object({
        asset_id: z.string().regex(/^PC-[0-9a-f]{8}$/),
        registration_operation_id: z.string().regex(/^OP-[0-9a-f]{8}$/).nullable(),
        transform_4x4: z.array(z.number()).length(16).nullable(),
      }),
    )
    .min(2),
  output_asset_id: z.string().regex(/^PC-[0-9a-f]{8}$/).nullable(),
  coordinate_frame: z.string().min(1).max(80),
  point_count: z.number().int().nonnegative().nullable(),
  scale_status: scaleStatusSchema,
  scale_provenance: scaleProvenanceSchema.nullable(),
  status: z.enum(["queued", "running", "done", "failed"]),
  started_at: z.string().datetime({ offset: true }),
  finished_at: z.string().datetime({ offset: true }).nullable(),
  message: z.string().max(2000).default(""),
});
export type FusionOperation = z.infer<typeof fusionOperationSchema>;

// ---------------------------------------------------------------------------
// Geometry validation
// ---------------------------------------------------------------------------

export const geometryCheckSchema = z.object({
  name: z.string().min(1).max(80),
  status: z.enum(["pass", "warn", "fail", "not_run"]),
  detail: z.string().max(500).default(""),
});
export type GeometryCheck = z.infer<typeof geometryCheckSchema>;

export const geometryValidationSchema = z.object({
  validation_id: z.string().regex(/^VAL-[0-9a-f]{8}$/),
  project_id: z.string().regex(/^MS-[0-9a-f]{8}$/),
  /** PC- or MSH- asset the verdict applies to. */
  asset_id: z.string().regex(/^(PC|MSH)-[0-9a-f]{8}$/),
  checks: z.array(geometryCheckSchema).min(1),
  watertight: z.boolean().nullable(),
  degenerate_triangles: z.number().int().nonnegative().nullable(),
  /** True only after the unit was checked against the calibration/document. */
  units_confirmed: z.boolean(),
  scale_status: scaleStatusSchema,
  scale_provenance: scaleProvenanceSchema.nullable(),
  created_at: z.string().datetime({ offset: true }),
});
export type GeometryValidation = z.infer<typeof geometryValidationSchema>;
