/**
 * Core data models, mirrored from the shared JSON Schemas in `/schemas`.
 *
 * These modules are deliberately pure (no React Native imports) so they can
 * be unit-tested off-device with `bun test`, and so the Blender Python
 * toolkit can rely on the same documented shapes.
 *
 * Coordinate convention (binding for every model that carries coordinates):
 *   - Units: metres, always.
 *   - Axes: right-handed, +X east, +Y north, +Z up, relative to the project's
 *     own local origin.
 *   - A local origin is NEVER treated as a geographic reference. Geographic
 *     referencing, when it arrives in a later stage, is a separate explicit
 *     transform, never an assumption.
 *   - Timestamps: ISO 8601 UTC strings.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Project metadata
// ---------------------------------------------------------------------------

export const projectStatusSchema = z.enum(["active", "archived"]);

export const projectMetadataSchema = z.object({
  /** Documented project identifier: `MS-` + 8 hex characters. */
  project_id: z.string().regex(/^MS-[0-9a-f]{8}$/, "project_id must match MS-XXXXXXXX"),
  schema_version: z.literal(1),
  name: z.string().min(1).max(80),
  /** Mine or site label; free text, never parsed for meaning. */
  site_name: z.string().max(120).default(""),
  notes: z.string().max(2000).default(""),
  status: projectStatusSchema,
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
});

export type ProjectMetadata = z.infer<typeof projectMetadataSchema>;

// ---------------------------------------------------------------------------
// Scan-session metadata
// ---------------------------------------------------------------------------

export const scanSessionStatusSchema = z.enum(["planned", "collecting", "collected", "aborted"]);

export const scanSessionSchema = z.object({
  session_id: z.string().regex(/^SES-[0-9a-f]{8}$/),
  project_id: z.string().regex(/^MS-[0-9a-f]{8}$/),
  label: z.string().min(1).max(80),
  status: scanSessionStatusSchema,
  started_at: z.string().datetime({ offset: true }),
  ended_at: z.string().datetime({ offset: true }).nullable(),
  notes: z.string().max(2000).default(""),
});

export type ScanSession = z.infer<typeof scanSessionSchema>;

// ---------------------------------------------------------------------------
// Sensor capability information
// ---------------------------------------------------------------------------

/**
 * Explicit capability states (v1.1 extension — optional so every v1 record
 * still validates; see schemas/sensor-capability.schema.json revision note).
 */
export const capabilityStateSchema = z.enum([
  "AVAILABLE",
  "UNAVAILABLE",
  "PERMISSION_DENIED",
  "UNKNOWN",
  "NOT_IMPLEMENTED",
]);

export const sensorCapabilitySchema = z.object({
  platform: z.enum(["android", "ios"]),
  /** True only when verified by an actual API check, never assumed. */
  camera_available: z.boolean().nullable(),
  /** Depth/LiDAR presence is only ever `true` after a verified probe. */
  depth_sensor_available: z.boolean().nullable(),
  imu_available: z.boolean().nullable(),
  /** Free-text hardware notes (e.g. model name) for the operator. */
  device_description: z.string().max(200).default(""),
  checked_at: z.string().datetime({ offset: true }),
  // ---- v1.1 additions (all optional; real probes fill them in) ----
  camera: capabilityStateSchema.optional(),
  camera_permission: capabilityStateSchema.optional(),
  accelerometer: capabilityStateSchema.optional(),
  gyroscope: capabilityStateSchema.optional(),
  magnetometer: capabilityStateSchema.optional(),
});

export type SensorCapability = z.infer<typeof sensorCapabilitySchema>;

// ---------------------------------------------------------------------------
// Asset metadata (point clouds, meshes) — files live on disk, never in rows
// ---------------------------------------------------------------------------

export const pointCloudAssetSchema = z.object({
  asset_id: z.string().regex(/^PC-[0-9a-f]{8}$/),
  project_id: z.string().regex(/^MS-[0-9a-f]{8}$/),
  session_id: z.string().regex(/^SES-[0-9a-f]{8}$/).nullable(),
  /** Path RELATIVE to the project's storage directory. */
  file_path: z.string().min(1),
  format: z.enum(["ply", "xyz", "las", "laz", "e57"]),
  /**
   * v1.3: widened from a metre-only literal. `unit_unknown` is REQUIRED for
   * imported files whose format does not document a unit (XYZ, most PLY) —
   * units are never assumed. `metre` stays valid and is claimed only when
   * the source format forces a unit (e.g. LAS integer scaling context) or a
   * documented transform established it.
   */
  coordinate_units: z.enum(["metre", "unit_unknown"]),
  /**
   * v1.3: widened. For IMPORTED files the value is always
   * `source_documented`, meaning: coordinates are stored exactly as the
   * source file documents (or, when it documents no convention, exactly as
   * stored) — the app applied no transform and asserts no axis mapping.
   * The explicit default string is reserved for clouds this app produced,
   * where the convention is genuinely established by the pipeline.
   */
  coordinate_convention: z.enum([
    "right-handed +X east +Y north +Z up, local origin",
    "source_documented",
  ]),
  point_count: z.number().int().nonnegative().nullable(),
  byte_size: z.number().int().nonnegative(),
  created_at: z.string().datetime({ offset: true }),
  // --- v1.3 (Stage 3.1) — all optional, backward compatible with v1–v1.2 ---
  /** Original file name as imported (≤255 chars). */
  original_filename: z.string().min(1).max(255).optional(),
  /** Content facts read from the file itself (never guessed). */
  content: z
    .object({
      /** Property names the file itself uses for coordinates (e.g. x/y/z). */
      coordinate_properties: z.array(z.string().min(1).max(40)).max(8),
      has_colors: z.boolean(),
      has_normals: z.boolean(),
      /** CRS identifier/description from the file, or null when absent. */
      crs: z.string().max(500).nullable(),
    })
    .optional(),
  // --- v1.1 (Stage 2.1) — all optional, backward compatible with v1 ---
  /** Capture sessions that contributed to this cloud. */
  source_session_ids: z.array(z.string().regex(/^SES-[0-9a-f]{8}$/)).optional(),
  /** MD5 of the file bytes, computed when the record is written. */
  checksum_md5: z.string().regex(/^[0-9a-f]{32}$/).optional(),
  provenance: z
    .object({
      kind: z.enum(["imported", "fused", "reconstructed"]),
      operation_id: z.string().regex(/^OP-[0-9a-f]{8}$/).nullable().optional(),
      input_asset_ids: z.array(z.string().min(1)).optional(),
      tool: z.string().max(200).optional(),
    })
    .optional(),
  /** v1.2 — full reconstruction provenance; required when provenance.kind is 'reconstructed'.
   *  Stage 3.0: trajectory_id is nullable (the COLMAP-native path estimates
   *  poses internally — no TRJ- record); pipeline_path states which declared
   *  reconstruction path produced the cloud. */
  reconstruction: z
    .object({
      method: z.string().min(1).max(80),
      calibration_id: z.string().regex(/^CAL-[0-9a-f]{8}$/),
      trajectory_id: z.string().regex(/^TRJ-[0-9a-f]{8}$/).nullable(),
      pipeline_path: z.enum(["opencv_assisted", "colmap_native", "other_documented"]).optional(),
      source_frame_job_ids: z.array(z.string().regex(/^JOB-[0-9a-f]{8}$/)).optional(),
      tool: z.string().min(1).max(120),
      tool_version: z.string().min(1).max(60),
      processed_at: z.string().datetime({ offset: true }),
    })
    .refine((r) => r.pipeline_path !== "opencv_assisted" || r.trajectory_id !== null, {
      message: "opencv_assisted reconstruction requires a TRJ- trajectory_id",
    })
    .optional(),
  /** Absent means UNKNOWN; never silently assume real-world metre scale. */
  scale_status: z.enum(["UNKNOWN", "RELATIVE", "ESTIMATED", "VALIDATED"]).optional(),
  scale_provenance: z
    .object({
      scale_status: z.enum(["UNKNOWN", "RELATIVE", "ESTIMATED", "VALIDATED"]),
      basis: z.enum([
        "none",
        "known_dimension",
        "survey_control",
        "validated_depth",
        "external_metric_scan",
        "operator_assumed",
        "other_documented",
      ]),
      detail: z.string().max(2000).default(""),
      measured_by: z.string().max(120).default(""),
      created_at: z.string().datetime({ offset: true }),
    })
    .nullable()
    .optional(),
  validation: z
    .object({
      validation_id: z.string().regex(/^VAL-[0-9a-f]{8}$/),
      verdict: z.enum(["pass", "warn", "fail", "not_run"]),
    })
    .nullable()
    .optional(),
});

export type PointCloudAsset = z.infer<typeof pointCloudAssetSchema>;

export const meshAssetSchema = z.object({
  asset_id: z.string().regex(/^MSH-[0-9a-f]{8}$/),
  project_id: z.string().regex(/^MS-[0-9a-f]{8}$/),
  session_id: z.string().regex(/^SES-[0-9a-f]{8}$/).nullable(),
  file_path: z.string().min(1),
  format: z.enum(["obj", "stl", "fbx", "ply"]),
  coordinate_units: z.literal("metre"),
  coordinate_convention: z.literal("right-handed +X east +Y north +Z up, local origin"),
  vertex_count: z.number().int().nonnegative().nullable(),
  triangle_count: z.number().int().nonnegative().nullable(),
  byte_size: z.number().int().nonnegative(),
  created_at: z.string().datetime({ offset: true }),
});

export type MeshAsset = z.infer<typeof meshAssetSchema>;

// ---------------------------------------------------------------------------
// Processing-operation metadata
// ---------------------------------------------------------------------------

export const processingOperationSchema = z.object({
  operation_id: z.string().regex(/^OP-[0-9a-f]{8}$/),
  project_id: z.string().regex(/^MS-[0-9a-f]{8}$/),
  /** Machine-readable operation name from the registry (src/engine/operations.ts, mirrored in schemas/operations.registry.json). */
  operation: z.string().min(1).max(80),
  status: z.enum(["queued", "running", "done", "failed", "cancelled"]),
  started_at: z.string().datetime({ offset: true }),
  finished_at: z.string().datetime({ offset: true }).nullable(),
  /** Human-readable result or failure reason. Never fabricated numbers. */
  message: z.string().max(2000).default(""),
});

export type ProcessingOperation = z.infer<typeof processingOperationSchema>;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** Parses and validates; throws a descriptive error on invalid input. */
export function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(`${issue.path.join(".") || "record"}: ${issue.message}`);
  }
  return result.data;
}

/** 8 hex chars from any hex-grade random source. */
export function shortId(prefix: string, hex: string): string {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "").slice(0, 8).toLowerCase();
  if (clean.length !== 8) throw new Error("shortId needs exactly 8 hex characters");
  return `${prefix}-${clean}`;
}
