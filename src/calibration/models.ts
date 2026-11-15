/**
 * Stage 3.3 — camera-calibration data models (pure zod, no react-native
 * imports; mirrored by `schemas/camera-calibration.schema.json` v2).
 *
 * Honesty rules encoded here:
 * - `source` separates `estimated_from_capture` (genuine target-based
 *   calibration), `factory_assumed` (documented vendor values — NEVER
 *   presented as measured) and `operator_provided` (imported, provenance
 *   retained).
 * - A computed calibration is `computed`, not `validated`: independent
 *   validation is a separate state that requires evidence this app cannot
 *   invent.
 * - Calibration fixes camera geometry in PIXELS; it never establishes scene
 *   scale, so `scale_status` stays UNKNOWN (basis `none`) unless an
 *   independent metric basis is documented elsewhere.
 * - Target dimensions are operator-measured in the unit the operator
 *   declares; nothing here invents millimetres.
 */

import { z } from "zod";

/** Distortion models this app actually estimates or documents. */
export const distortionModelSchema = z.enum([
  /** OpenCV order: [k1, k2, p1, p2, k3] — the model the solver estimates. */
  "opencv_radial_tangential_k1_k2_p1_p2_k3",
  /** No distortion; coefficients must be []. */
  "none",
  /** Vendor/factory parameters whose model is documented elsewhere. */
  "unspecified",
]);
export type DistortionModel = z.infer<typeof distortionModelSchema>;

/** Calibration methods, kept distinguishable end-to-end. */
export const calibrationMethodSchema = z.enum([
  /** Known calibration target (e.g. checkerboard) estimated from real frames. */
  "known_target_checkerboard",
  /** Documented factory/vendor parameters, explicitly labelled as assumed. */
  "factory_assumed",
  /** Imported calibration file, validated against this schema. */
  "imported",
]);
export type CalibrationMethod = z.infer<typeof calibrationMethodSchema>;

export const calibrationSourceSchema = z.enum([
  "estimated_from_capture",
  "factory_assumed",
  "operator_provided",
]);

/**
 * Calibration-target configuration. `square_size` is in the operator's
 * declared unit — the app never converts or assumes a length unit.
 */
export const checkerboardTargetSchema = z.object({
  type: z.literal("checkerboard"),
  /** Inner corners per row and column (square counts minus one). */
  corner_columns: z.number().int().min(2).max(30),
  corner_rows: z.number().int().min(2).max(30),
  square_size: z.number().positive(),
  unit: z.string().min(1).max(16),
  /** Free-text identification (e.g. "printed A3 board #2"). */
  identification: z.string().min(1).max(200),
});
export type CheckerboardTarget = z.infer<typeof checkerboardTargetSchema>;

/** Per-image suitability verdict — distinct from the calibration verdict. */
export const imageSuitabilitySchema = z.enum([
  "accepted",
  "accepted_with_warnings",
  "rejected",
  "not_evaluated",
]);
export type ImageSuitability = z.infer<typeof imageSuitabilitySchema>;

export const frameSuitabilitySchema = z.object({
  frame_id: z.string().regex(/^FRM-[0-9a-f]{8}$/),
  file_path: z.string().min(1),
  suitability: imageSuitabilitySchema,
  /** Machine-readable reasons (e.g. "blur_high", "target_detection_failed"). */
  reasons: z.array(z.string().min(1).max(80)).max(16),
  /** Detected inner-corner count when target detection ran. */
  detected_corners: z.number().int().nonnegative().nullable(),
});
export type FrameSuitability = z.infer<typeof frameSuitabilitySchema>;

/** Engine identity — filled from the real implementation, never invented. */
export const calibrationEngineSchema = z.object({
  tool: z.string().min(1).max(120),
  tool_version: z.string().min(1).max(80),
  /** The library this engine replaces on device (OpenCV is NOT available). */
  note: z.string().min(1).max(500),
});
export type CalibrationEngine = z.infer<typeof calibrationEngineSchema>;

/** Quality metrics — measured from the actual run, null when not computed. */
export const calibrationMetricsSchema = z.object({
  input_frames: z.number().int().nonnegative(),
  frames_accepted: z.number().int().nonnegative(),
  frames_rejected: z.number().int().nonnegative(),
  frames_with_warnings: z.number().int().nonnegative(),
  /** Total detected target points across accepted images. */
  detected_points: z.number().int().nonnegative(),
  /** RMS reprojection error in pixels (null when not computed). */
  reprojection_error_px: z.number().nonnegative().nullable(),
  /** Per-image RMS reprojection error in pixels, aligned to accepted frames. */
  per_image_error_px: z.array(z.number().nonnegative()),
  /** Coverage: fraction of image area the target plane spans across views. */
  coverage_note: z.string().max(500),
  /** Solver converged (LM refinement completed within its iteration budget). */
  converged: z.boolean().nullable(),
});
export type CalibrationMetrics = z.infer<typeof calibrationMetricsSchema>;

/** Explicit, documented factory-parameter provenance (method B). */
export const factoryProvenanceSchema = z.object({
  parameter_source: z.string().min(1).max(200),
  device_model: z.string().max(120).nullable(),
  camera_id: z.string().max(120).nullable(),
  source_documentation: z.string().min(1).max(1000),
  retrieved_at: z.string().datetime({ offset: true }).nullable(),
  assumptions: z.array(z.string().max(300)).max(16),
});
export type FactoryProvenance = z.infer<typeof factoryProvenanceSchema>;

/** Imported-calibration provenance (method C). */
export const importProvenanceSchema = z.object({
  original_format: z.string().min(1).max(80),
  original_filename: z.string().min(1).max(200),
  source_documentation: z.string().max(1000),
  /** MD5 of the imported file, for traceability. */
  checksum_md5: z.string().regex(/^[0-9a-f]{32}$/),
});
export type ImportProvenance = z.infer<typeof importProvenanceSchema>;

export const calibrationStatusSchema = z.enum([
  "computed",
  "computed_with_warnings",
  "failed",
]);
export const validationStatusSchema = z.enum([
  /** Internal quality gates configured for THIS run were met. */
  "passed_configured_checks",
  "did_not_pass_configured_checks",
  /** Never evaluated — e.g. factory-assumed parameters. */
  "not_evaluated",
  /** Independent validation (targeted measurement) — NOT implemented. */
  "independently_validated",
]);

/**
 * The calibration record. Keys `calibration_id … calibration_method,
 * created_at` keep the Stage 2.1 v1 contract (backward compatible); v2 adds
 * metrics, engine identity, provenance blocks and statuses.
 */
export const calibrationRecordSchema = z
  .object({
    calibration_id: z.string().regex(/^CAL-[0-9a-f]{8}$/),
    project_id: z.string().regex(/^MS-[0-9a-f]{8}$/),
    session_id: z.string().regex(/^SES-[0-9a-f]{8}$/).nullable(),
    camera_label: z.string().min(1).max(80),

    image_width: z.number().int().positive(),
    image_height: z.number().int().positive(),
    /** fx, fy, cx, cy in PIXELS (v1 fields, unchanged). */
    fx: z.number().positive(),
    fy: z.number().positive(),
    cx: z.number().nonnegative(),
    cy: z.number().nonnegative(),
    model: distortionModelSchema,
    /** Coefficients in `model` order; [] when model is "none". */
    distortion: z.array(z.number()).max(8),

    source: calibrationSourceSchema,
    calibration_method: calibrationMethodSchema,
    created_at: z.string().datetime({ offset: true }),

    // ---- v2 additions ----
    engine: calibrationEngineSchema,
    metrics: calibrationMetricsSchema,
    target_config: checkerboardTargetSchema.nullable(),
    source_frame_ids: z.array(z.string().regex(/^FRM-[0-9a-f]{8}$/)).max(10000),
    source_video_asset_ids: z.array(z.string()).max(1000),
    frame_evaluations: z.array(frameSuitabilitySchema).max(10000),
    factory_provenance: factoryProvenanceSchema.nullable(),
    import_provenance: importProvenanceSchema.nullable(),
    calibration_status: calibrationStatusSchema,
    validation_status: validationStatusSchema,
    /** Calibration is pixel geometry: never a scene-scale claim. */
    scale_status: z.literal("UNKNOWN"),
    scale_provenance: z.object({
      basis: z.literal("none"),
      detail: z.string().min(1).max(500),
    }),
    coordinate_convention: z
      .string()
      .min(1)
      .max(200)
      .default("opencv_pinhole: x right, y down, z forward from camera; K row-major [[fx,0,cx],[0,fy,cy],[0,0,1]]"),
    operation_id: z.string().regex(/^CAL-[0-9a-f]{8}$/),
    warnings: z.array(z.string().max(500)).max(100),
    errors: z.array(z.string().max(500)).max(100),
  })
  .refine((r) => r.source === "estimated_from_capture" || r.target_config === null || r.target_config.type === "checkerboard", {
    message: "a target configuration is only recorded for target-based estimation",
  })
  .refine((r) => r.source !== "factory_assumed" || r.factory_provenance !== null, {
    message: "factory_assumed parameters require documented factory_provenance",
  })
  .refine((r) => r.source !== "operator_provided" || r.import_provenance !== null, {
    message: "imported calibration requires import_provenance (original format, checksum)",
  })
  .refine(
    (r) =>
      r.model !== "opencv_radial_tangential_k1_k2_p1_p2_k3" ||
      r.distortion.length === 5,
    { message: "opencv_radial_tangential model requires exactly 5 coefficients [k1,k2,p1,p2,k3]" },
  )
  .refine((r) => r.model !== "none" || r.distortion.length === 0, {
    message: 'model "none" requires an empty distortion array',
  })
  .refine(
    (r) =>
      r.validation_status !== "independently_validated" ||
      (r.calibration_status !== "computed" && r.calibration_status !== "computed_with_warnings"),
    {
      message:
        "a computed calibration can never claim independently_validated — computed ≠ validated; only an external targeted measurement can validate",
    },
  );
export type CalibrationRecord = z.infer<typeof calibrationRecordSchema>;

/** Settings for one target-based calibration run. */
export const calibrationRunSettingsSchema = z.object({
  method: z.literal("known_target_checkerboard"),
  target: checkerboardTargetSchema,
  /** Reject images blurrier than this Laplacian-variance threshold (0 disables). */
  blur_variance_min: z.number().nonnegative().default(40),
  /** Min mean-luminance contrast (std of gray) required (0 disables). */
  contrast_std_min: z.number().nonnegative().default(12),
  /** Fraction of pixels considered blown out / crushed for exposure checks. */
  overexposure_fraction_max: z.number().min(0).max(1).default(0.25),
  underexposure_fraction_max: z.number().min(0).max(1).default(0.25),
  /** Duplicate detection: aHash distance above this counts as distinct. */
  duplicate_hash_distance: z.number().int().min(0).max(64).default(6),
  /** Min accepted images before the solver runs (Zhang needs ≥3 distinct views). */
  min_images: z.number().int().min(3).max(100).default(6),
  /** Warn when accepted views span fewer distinct target orientations. */
  orientation_buckets: z.number().int().min(3).max(24).default(8),
  /** Optional working scale: images decoded at ≤ this long-edge size. */
  max_working_dimension_px: z.number().int().positive().max(8192).nullable().default(null),
  /**
   * Quality gate on final RMS reprojection error (px). Rationale: with
   * subpixel-refined corners of a printed checkerboard, RMS above ~2 px
   * usually means detection trouble, motion blur, or a poor lens model;
   * exceeding this marks the calibration computed_with_warnings and
   * validation_status did_not_pass. Configurable, never silent.
   */
  max_reprojection_error_px: z.number().positive().default(2.0),
});
export type CalibrationRunSettings = z.infer<typeof calibrationRunSettingsSchema>;
