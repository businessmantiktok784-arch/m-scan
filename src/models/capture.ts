/**
 * Stage 2 capture data models — TypeScript mirror of the Stage 2 JSON Schemas
 * in `schemas/` (capture-config, camera-recording, sensor-stream,
 * capture-manifest, tracking-status) and the v1.1 extension of
 * `sensor-capability`.
 *
 * Pure TypeScript (no React Native imports) so everything here is testable
 * off-device with `bun test`.
 *
 * Honesty rules inherited from Stage 1: sample counts, durations and storage
 * figures are recorded only after the data exists. A session that ended
 * abnormally is never marked `collected`.
 */
import { z } from "zod";

/** Explicit capability states (v1.1 of sensor-capability / live probing). */
import { capabilityStateSchema } from "./models";
export { capabilityStateSchema };
export type CapabilityState = z.infer<typeof capabilityStateSchema>;

// ---------------------------------------------------------------------------
// Timestamps (single documented source — see docs/capture-pipeline.md)
// ---------------------------------------------------------------------------

/**
 * Every recorded event carries BOTH clocks. They are never assumed to be
 * synchronized with each other or across devices:
 * - `epoch_ms`: wall clock (Date.now), milliseconds since Unix epoch UTC.
 *   Can jump when the OS or user changes the clock — provenance only.
 * - `monotonic_ms`: device monotonic clock (performance.now origin),
 *   milliseconds since an arbitrary point. Never jumps backwards; the basis
 *   for durations and cross-stream alignment within one boot.
 */
export const timestampPairSchema = z.object({
  epoch_ms: z.number().int().nonnegative(),
  monotonic_ms: z.number().nonnegative(),
  /** Which monotonic implementation produced `monotonic_ms`. */
  monotonic_source: z.enum(["performance.now"]),
});
export type TimestampPair = z.infer<typeof timestampPairSchema>;

// ---------------------------------------------------------------------------
// Capture configuration (fixed at session start, stored in the session record)
// ---------------------------------------------------------------------------

const cameraConfigSchema = z.strictObject({
  facing: z.enum(["back", "front"]).default("back"),
  /** Chunked segments: one video file per chunk, seconds. */
  segment_duration_s: z.number().positive().max(600).default(60),
  video_quality: z.enum(["480p", "720p", "1080p"]).default("720p"),
  /** Audio is NOT recorded: underground capture is video+IMU only. */
  mute: z.literal(true).default(true),
});

const sensorsConfigSchema = z.strictObject({
  accelerometer_hz: z.number().positive().max(200).default(50),
  gyroscope_hz: z.number().positive().max(200).default(50),
  magnetometer_hz: z.number().positive().max(100).default(10),
});

// `.default({})` bypasses the inner defaults in zod (it substitutes the raw
// value), so the fallback is the FULLY-PARSED default object, computed once.
const cameraDefaults = cameraConfigSchema.parse({});
const sensorsDefaults = sensorsConfigSchema.parse({});

export const captureConfigSchema = z.strictObject({
  // Defaulted so `parse({})` yields the documented defaults; stored config
  // records always carry the explicit 1 after parsing.
  schema_version: z.literal(1).default(1),
  camera: cameraConfigSchema.default(cameraDefaults),
  sensors: sensorsConfigSchema.default(sensorsDefaults),
});
export type CaptureConfig = z.infer<typeof captureConfigSchema>;

/** The documented defaults, e.g. for UI pre-fill and DB config_json. */
export const captureConfigDefaults: CaptureConfig = captureConfigSchema.parse({});

// ---------------------------------------------------------------------------
// Camera recording (one video segment on disk)
// ---------------------------------------------------------------------------

export const cameraRecordingSchema = z.object({
  recording_id: z.string().regex(/^VID-[0-9a-f]{8}$/),
  session_id: z.string().regex(/^SES-[0-9a-f]{8}$/),
  project_id: z.string().regex(/^MS-[0-9a-f]{8}$/),
  /** Path relative to the project directory. */
  file_path: z.string().min(1),
  media_type: z.literal("video/mp4"),
  byte_size: z.number().int().nonnegative(),
  /** MD5 of the finalized file, null while the segment is still open. */
  checksum_md5: z.string().regex(/^[0-9a-f]{32}$/).nullable(),
  started_at: timestampPairSchema,
  ended_at: timestampPairSchema.nullable(),
  /** Seconds, measured on the monotonic clock — never estimated. */
  duration_s: z.number().nonnegative().nullable(),
  /** OS-provided metadata when reported; never invented. */
  width_px: z.number().int().positive().nullable(),
  height_px: z.number().int().positive().nullable(),
  camera_facing: z.enum(["back", "front"]),
});
export type CameraRecording = z.infer<typeof cameraRecordingSchema>;

// ---------------------------------------------------------------------------
// Sensor streams (JSONL files; one line = one validated sample)
// ---------------------------------------------------------------------------

export const sensorKindSchema = z.enum(["accelerometer", "gyroscope", "magnetometer"]);
export type SensorKind = z.infer<typeof sensorKindSchema>;

/** Units are fixed per kind and documented in docs/capture-pipeline.md. */
export const SENSOR_UNITS: Record<SensorKind, string> = {
  accelerometer: "g (1 g = 9.80665 m/s^2), device frame",
  gyroscope: "rad/s, device frame",
  magnetometer: "microtesla (uT), device frame",
};

const axesSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
});

export const sensorSampleSchema = z.object({
  kind: sensorKindSchema,
  t: timestampPairSchema,
  axes: axesSchema,
  /** Measured interval to the previous accepted sample of the same stream, ms. */
  delta_ms: z.number().nonnegative().nullable(),
});
export type SensorSample = z.infer<typeof sensorSampleSchema>;

export const sensorStreamSchema = z.object({
  stream_id: z.string().regex(/^SNS-[0-9a-f]{8}$/),
  session_id: z.string().regex(/^SES-[0-9a-f]{8}$/),
  project_id: z.string().regex(/^MS-[0-9a-f]{8}$/),
  kind: sensorKindSchema,
  /** Path relative to the project directory (JSONL). */
  file_path: z.string().min(1),
  media_type: z.literal("application/x-ndjson"),
  units: z.string().min(1),
  requested_interval_ms: z.number().positive(),
  /** Set only from real subscription callbacks, never estimated. */
  sample_count: z.number().int().nonnegative(),
  byte_size: z.number().int().nonnegative(),
  checksum_md5: z.string().regex(/^[0-9a-f]{32}$/).nullable(),
  first_sample_at: timestampPairSchema.nullable(),
  last_sample_at: timestampPairSchema.nullable(),
  /** True once the file was finalized cleanly (handle closed, hash computed). */
  finalized: z.boolean(),
});
export type SensorStream = z.infer<typeof sensorStreamSchema>;

// ---------------------------------------------------------------------------
// Capture manifest (one per session; written atomically, last)
// ---------------------------------------------------------------------------

export const captureManifestSchema = z.object({
  schema_version: z.literal(1),
  session_id: z.string().regex(/^SES-[0-9a-f]{8}$/),
  project_id: z.string().regex(/^MS-[0-9a-f]{8}$/),
  config: captureConfigSchema,
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
  final_state: z.enum(["capturing", "paused", "stopped", "failed", "aborted"]),
  /** Wall-clock cover of the whole session, for provenance only. */
  started_at: timestampPairSchema.nullable(),
  ended_at: timestampPairSchema.nullable(),
  /** Cumulative time spent in the `capturing` state, monotonic basis. */
  active_duration_s: z.number().nonnegative(),
  interruptions: z.array(
    z.object({
      at: timestampPairSchema,
      reason: z.string().max(200),
      /** What the session did next: paused, failed or aborted. */
      action: z.enum(["paused", "failed", "aborted"]),
    })
  ),
  camera_recordings: z.array(z.string()).default([]), // recording ids, details in DB + files
  sensor_streams: z.array(z.string()).default([]),
  /** Written even when empty — an explicit list beats an absent one. */
  warnings: z.array(z.string().max(500)).default([]),
});
export type CaptureManifest = z.infer<typeof captureManifestSchema>;

// ---------------------------------------------------------------------------
// Tracking / registration status (explicitly NOT IMPLEMENTED in Stage 2)
// ---------------------------------------------------------------------------

export const trackingStatusSchema = z.object({
  schema_version: z.literal(1),
  visual_odometry: z.literal("NOT_IMPLEMENTED"),
  camera_calibration: z.literal("NOT_IMPLEMENTED"),
  feature_tracking: z.literal("NOT_IMPLEMENTED"),
  pose_estimation: z.literal("NOT_IMPLEMENTED"),
  visual_inertial_tracking: z.literal("NOT_IMPLEMENTED"),
  /** Recorded raw camera/IMU data is the input a future stage will consume. */
  note: z.string(),
});
export type TrackingStatus = z.infer<typeof trackingStatusSchema>;

export const trackingStatus: TrackingStatus = {
  schema_version: 1,
  visual_odometry: "NOT_IMPLEMENTED",
  camera_calibration: "NOT_IMPLEMENTED",
  feature_tracking: "NOT_IMPLEMENTED",
  pose_estimation: "NOT_IMPLEMENTED",
  visual_inertial_tracking: "NOT_IMPLEMENTED",
  note:
    "Stage 2 records genuine camera video and motion-sensor samples only. " +
    "No poses, trajectories or reconstructed geometry are produced. See " +
    "docs/tracking-evaluation.md for the candidate assessment.",
};
