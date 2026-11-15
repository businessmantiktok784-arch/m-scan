/**
 * Stage 3.2 frame-extraction data models.
 *
 * TypeScript mirror of `schemas/frame-extraction.schema.json` (v2) plus the
 * extraction settings contract. Pure TypeScript (no React Native imports)
 * so everything is testable off-device with `bun test`.
 *
 * Timestamp honesty (binding):
 * - `sample_time_s` is the requested seek position in source media time —
 *   the sampling grid, always recorded.
 * - `pts_ms` / `time_base` are set ONLY when the decoder reported the
 *   decoded frame's own presentation timestamp. The platform decoder used
 *   on device does not expose decoded PTS, so they stay null there; an
 *   FFmpeg-based decoder would fill them from showinfo. Never inferred.
 * - `capture_time_mapping` records whether a frame's media time could be
 *   tied to wall-clock capture time. Phone recordings cannot provide this
 *   mapping (the recording start epoch and the video's first frame differ by
 *   an unmeasurable warm-up delay), so it stays "unavailable" by design —
 *   never fabricated.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Extraction settings (operator-chosen, recorded verbatim in provenance)
// ---------------------------------------------------------------------------

export const extractionModeSchema = z.enum(["time_interval", "frame_rate"]);
export type ExtractionMode = z.infer<typeof extractionModeSchema>;

export const extractionSettingsSchema = z
  .object({
    mode: extractionModeSchema,
    /** Mode `time_interval`: one frame every N seconds of media time. */
    interval_s: z.number().positive().max(60).optional(),
    /** Mode `frame_rate`: requested average sampling rate in frames/second. */
    target_fps: z.number().positive().max(60).optional(),
    /** Hard cap on extracted frames per source video. */
    max_frames: z.number().int().positive().max(10000).default(1000),
    /** "png" for CV workflows; "jpeg" records an explicit quality. */
    image_format: z.enum(["png", "jpeg"]).default("png"),
    /** Mode `frame_rate` is realised as every-Nth-source-frame sampling. */
    /** Only meaningful for jpeg; recorded verbatim, never silently altered. */
    jpeg_quality: z.number().int().min(1).max(100).optional(),
    /** Optional down-scale bound (longest side), applied visibly. */
    max_dimension_px: z.number().int().positive().max(8192).optional(),
  })
  .refine((s) => s.mode !== "time_interval" || (s.interval_s !== undefined && s.interval_s > 0), {
    message: "time_interval mode requires a positive interval_s",
  })
  .refine((s) => s.mode !== "frame_rate" || (s.target_fps !== undefined && s.target_fps > 0), {
    message: "frame_rate mode requires a positive target_fps",
  })
  .refine((s) => s.image_format !== "jpeg" || s.jpeg_quality !== undefined, {
    message: "jpeg output requires an explicit jpeg_quality",
  })
  .refine((s) => s.image_format !== "png" || s.jpeg_quality === undefined, {
    message: "png output ignores jpeg_quality — drop the field so provenance stays exact",
  });
export type ExtractionSettings = z.infer<typeof extractionSettingsSchema>;

// ---------------------------------------------------------------------------
// Frame record (one extracted image)
// ---------------------------------------------------------------------------

export const frameRecordSchema = z.object({
  frame_id: z.string().regex(/^FRM-[0-9a-f]{8}$/),
  job_id: z.string().regex(/^JOB-[0-9a-f]{8}$/),
  project_id: z.string().regex(/^MS-[0-9a-f]{8}$/),
  session_id: z.string().regex(/^SES-[0-9a-f]{8}$/),
  /** The camera_video asset (VID-) this frame was decoded from. */
  source_video_asset_id: z.string().min(1),
  /** Ordinal of the segment within its session, where known. */
  source_video_segment_index: z.number().int().nonnegative().nullable(),
  frame_index: z.number().int().nonnegative(),
  /** Path of the image file relative to the job's output directory
   *  (join with job.output_directory to get the stored location). */
  file_path: z.string().min(1),
  image_format: z.enum(["png", "jpeg"]),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  /** Requested seek position in source media time, seconds. */
  sample_time_s: z.number().nonnegative(),
  /** Decoded frame presentation timestamp; null unless the decoder reports it. */
  pts_ms: z.number().nonnegative().nullable(),
  /** Decoder-reported time base (e.g. "1/90000"); null unless reported. */
  time_base: z.string().nullable(),
  /** Whether this frame's media time is tied to wall-clock capture time. */
  capture_time_mapping: z.enum(["unavailable", "other_documented"]),
  capture_time_detail: z.string().max(1000).default(""),
  byte_size: z.number().int().nonnegative(),
  checksum_md5: z.string().regex(/^[0-9a-f]{32}$/),
  /** How the image was produced: seek+decode (platform) or pts-decode (ffmpeg). */
  extraction_method: z.enum(["seek_decode", "pts_decode"]),
  validation_status: z.enum(["unverified", "pass", "failed"]),
  warnings: z.array(z.string().max(500)).default([]),
  created_at: z.string().datetime({ offset: true }),
});
export type FrameRecord = z.infer<typeof frameRecordSchema>;

// ---------------------------------------------------------------------------
// Extraction job record (operation frame_extraction)
// ---------------------------------------------------------------------------

export const decoderIdentitySchema = z.object({
  tool: z.string().min(1).max(120),
  tool_version: z.string().min(1).max(60),
  /** FFmpeg version when an FFmpeg-based decoder ran; null elsewhere. */
  ffmpeg_version: z.string().max(120).nullable(),
  /** What the decoder actually is, stated plainly. */
  detail: z.string().max(1000).default(""),
});
export type DecoderIdentity = z.infer<typeof decoderIdentitySchema>;

export const extractionSourceSchema = z.object({
  asset_id: z.string().min(1),
  file_path: z.string().min(1),
  byte_size: z.number().int().nonnegative(),
  checksum_md5: z.string().regex(/^[0-9a-f]{32}$/).nullable(),
  segment_index: z.number().int().nonnegative().nullable(),
});
export type ExtractionSource = z.infer<typeof extractionSourceSchema>;

export const extractionJobSchema = z.object({
  job_id: z.string().regex(/^JOB-[0-9a-f]{8}$/),
  project_id: z.string().regex(/^MS-[0-9a-f]{8}$/),
  session_id: z.string().regex(/^SES-[0-9a-f]{8}$/),
  status: z.enum(["queued", "running", "done", "failed", "cancelled", "interrupted"]),
  settings: extractionSettingsSchema,
  decoder: decoderIdentitySchema,
  /** Absolute or project-relative output directory, as stored. */
  output_directory: z.string().min(1),
  sources: z.array(extractionSourceSchema).min(1),
  frames_extracted: z.number().int().nonnegative().nullable(),
  frames_failed: z.number().int().nonnegative().default(0),
  warnings: z.array(z.string().max(500)).default([]),
  errors: z.array(z.string().max(500)).default([]),
  started_at: z.string().datetime({ offset: true }),
  finished_at: z.string().datetime({ offset: true }).nullable(),
  processing_duration_s: z.number().nonnegative().nullable(),
  message: z.string().max(2000).default(""),
});
export type ExtractionJob = z.infer<typeof extractionJobSchema>;
