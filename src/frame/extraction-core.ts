/**
 * Stage 3.2 — frame-extraction core (pure orchestration).
 *
 * All file access, decoding and database work is injected behind three
 * seams, so the FULL lifecycle — preflight, per-segment validation, sampling
 * grid, decode, verify, register — runs unchanged on device (expo-file-system
 * + the platform media decoder) and in bun tests (node fs + a real host
 * FFmpeg decoder). There is deliberately no second implementation of the
 * pipeline logic.
 *
 * Honesty rules enforced here:
 * - Every source is validated BEFORE any frame is decoded; a job with one
 *   invalid segment fails without extracting anything from any segment.
 * - A frame is registered only after its file exists, is non-empty, and has
 *   a checksum (verified write).
 * - Failed frames are counted and recorded; the job never hides them.
 * - PTS/time-base are filled only from what the decoder reports; the
 *   platform decoder reports none, so they stay null and capture_time
 *   mapping is recorded as "unavailable" — never fabricated.
 * - Success registers the frame set in ONE transaction (repository), so a
 *   failed or cancelled run leaves no asset behind.
 * - Output directories are per-job and never overwritten.
 */
import type { RepoDb } from "../database/import-repository";
import { frameRepository } from "../database/frame-repository";
import { validateVideo, type VideoValidationReport, type ValidationIssue } from "../video/video-validate";
import { probeMp4 } from "../video/mp4-probe";
import { computeSampleGrid, frameFileName } from "./sampling";
import { shortId } from "../models/models";
import type { ExtractionJob, ExtractionSettings, FrameRecord } from "./models";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

export interface ExtractionIo {
  ensureDir(path: string): void;
  /** True when the path exists (file or directory). */
  exists(path: string): boolean;
  removeTree(path: string): void;
  /** MD5 of a closed file; null when the platform cannot compute it. */
  md5(path: string): string | null;
  byteSize(path: string): number;
  /** Chunked random access for the MP4 box walk. */
  readChunk(path: string, offset: number, length: number): Promise<Uint8Array>;
  writeJsonAtomic(path: string, value: unknown): void;
  appendJsonl(path: string, line: string): void;
}

/** One decoded frame written to disk. */
export interface DecodedFrame {
  /** Absolute path of the written image file. */
  file_path: string;
  width: number | null;
  height: number | null;
  /** Decoded PTS when the decoder reports it; null on seek-based decoders. */
  pts_ms: number | null;
  time_base: string | null;
  warnings: string[];
}

export interface FrameDecoder {
  readonly tool: string;
  readonly tool_version: string;
  /** FFmpeg version, ONLY when this decoder actually is FFmpeg. */
  readonly ffmpeg_version: string | null;
  readonly detail: string;
  decodeAt(sourcePath: string, timeMs: number, outputDir: string, fileName: string, settings: ExtractionSettings): Promise<DecodedFrame>;
}

export interface ExtractionSourceInput {
  asset_id: string;
  /** Absolute path of the preserved recording. */
  abs_path: string;
  /** Project-relative path (for records). */
  rel_path: string;
  segment_index: number | null;
}

export interface ExtractionHooks {
  onStage?: (stage: "preflight" | "validating" | "extracting" | "finalizing" | "done", label: string) => void;
  onProgress?: (framesDone: number, framesTotal: number) => void;
  shouldCancel?: () => boolean;
}

export type ExtractionOutcome =
  | { kind: "succeeded"; job_id: string; frames_extracted: number; frames_failed: number; warnings: string[] }
  | { kind: "cancelled"; job_id: string }
  | { kind: "failed"; job_id: string; code: string; message: string };

/** Minimum free storage before starting an extraction (same headroom rule as capture/import). */
export const MIN_FREE_BYTES = 200 * 1024 * 1024;

export interface ExtractionInput {
  job_id: string;
  project_id: string;
  session_id: string;
  sources: ExtractionSourceInput[];
  settings: ExtractionSettings;
  /** Absolute base directory for outputs: .../frames/{job_id}. */
  output_dir_abs: string;
  /** Absolute free-space in bytes, or 0 when it cannot be verified. */
  free_bytes: number;
}

/**
 * Rough worst-case storage estimate per extracted image, used ONLY for the
 * free-space gate. It is an upper bound for an oversized frame, not a claim
 * about real file sizes (those are measured after each decode).
 */
const ESTIMATED_BYTES_PER_FRAME = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------

export async function runExtraction(
  input: ExtractionInput,
  db: RepoDb,
  io: ExtractionIo,
  decoder: FrameDecoder,
  hooks: ExtractionHooks = {},
): Promise<ExtractionOutcome> {
  const startedAt = new Date().toISOString();
  const warnings: string[] = [];
  const errors: string[] = [];
  let framesFailed = 0;
  const startedMonoS = Date.now() / 1000;

  const job: ExtractionJob = {
    job_id: input.job_id,
    project_id: input.project_id,
    session_id: input.session_id,
    status: "running",
    settings: input.settings,
    decoder: {
      tool: decoder.tool,
      tool_version: decoder.tool_version,
      ffmpeg_version: decoder.ffmpeg_version,
      detail: decoder.detail,
    },
    output_directory: input.output_dir_abs,
    sources: [],
    frames_extracted: null,
    frames_failed: 0,
    warnings: [],
    errors: [],
    started_at: startedAt,
    finished_at: null,
    processing_duration_s: null,
    message: "",
  };

  /** Set once the pipeline has created the output directory itself; a
   *  pre-existing directory found by the output_exists guard must NEVER be
   *  deleted (it belongs to a previous job). */
  let outputCreated = false;

  const fail = async (code: string, message: string): Promise<ExtractionOutcome> => {
    errors.push(`${code}: ${message}`);
    const finishedAt = new Date().toISOString();
    const failedJob: ExtractionJob = {
      ...job,
      status: "failed",
      errors,
      warnings,
      frames_failed: framesFailed,
      finished_at: finishedAt,
      processing_duration_s: Date.now() / 1000 - startedMonoS,
      message: `${code}: ${message}`,
    };
    if (outputCreated) io.removeTree(input.output_dir_abs); // failed runs leave nothing behind
    await frameRepository.markFailed(db, {
      jobId: input.job_id,
      status: "failed",
      message: `${code}: ${message}`,
      warnings,
      errors,
      finishedAt,
    });
    hooks.onStage?.("done", "failed");
    return { kind: "failed", job_id: input.job_id, code, message };
  };

  const cancelled = async (): Promise<ExtractionOutcome> => {
    const finishedAt = new Date().toISOString();
    if (outputCreated) io.removeTree(input.output_dir_abs);
    await frameRepository.markFailed(db, {
      jobId: input.job_id,
      status: "cancelled",
      message: "cancelled by operator",
      warnings,
      errors,
      finishedAt,
    });
    hooks.onStage?.("done", "cancelled");
    return { kind: "cancelled", job_id: input.job_id };
  };

  // ---- preflight ----------------------------------------------------------
  hooks.onStage?.("preflight", "checking storage");
  if (io.exists(input.output_dir_abs)) {
    return fail("output_exists", `output directory already exists — extractions are never overwritten (${input.output_dir_abs})`);
  }
  const maxFramesPerSource = input.settings.max_frames;
  const estimatedBytes = maxFramesPerSource * input.sources.length * ESTIMATED_BYTES_PER_FRAME;
  if (input.free_bytes !== 0 && input.free_bytes < Math.max(MIN_FREE_BYTES, estimatedBytes)) {
    return fail(
      "insufficient_storage",
      `free storage ${(input.free_bytes / 1e9).toFixed(2)} GB is below the extraction estimate ${(
        Math.max(MIN_FREE_BYTES, estimatedBytes) / 1e9
      ).toFixed(2)} GB (worst-case frame size × max_frames)`,
    );
  }

  // ---- validate every source BEFORE decoding anything ----------------------
  hooks.onStage?.("validating", `${input.sources.length} segment(s)`);
  const reports: { src: ExtractionSourceInput; report: VideoValidationReport }[] = [];
  for (const src of input.sources) {
    if (!io.exists(src.abs_path)) {
      return fail("segment_missing", `source video is gone: ${src.rel_path}`);
    }
    const report = await validateVideoFile(io, src);
    for (const w of report.warnings) warnings.push(`[${src.asset_id}] ${w.message}`);
    if (report.verdict !== "valid" && report.verdict !== "valid_with_warnings") {
      const first = report.errors[0];
      return fail(first?.code ?? "video_unreadable", `[${src.asset_id}] ${first?.message ?? `validation verdict: ${report.verdict}`}`);
    }
    reports.push({ src, report });
  }

  // ---- register the job before any bytes are written -----------------------
  job.sources = reports.map(({ src, report }) => ({
    asset_id: src.asset_id,
    file_path: src.rel_path,
    byte_size: io.byteSize(src.abs_path),
    checksum_md5: io.md5(src.abs_path),
    segment_index: src.segment_index,
  }));
  await frameRepository.beginExtraction(db, job);

  // ---- extract -------------------------------------------------------------
  const framesDir = `${input.output_dir_abs}/frames`;
  const metadataDir = `${input.output_dir_abs}/metadata`;
  const logsDir = `${input.output_dir_abs}/logs`;
  io.ensureDir(framesDir);
  io.ensureDir(metadataDir);
  io.ensureDir(logsDir);
  outputCreated = true;

  let framesExtracted = 0;
  const framesJsonl = `${metadataDir}/frames.jsonl`;

  hooks.onStage?.("extracting", `${reports.length} segment(s)`);
  // File names are numbered across the WHOLE job (segments share the frames/
  // directory, so per-segment numbering would silently overwrite files).
  let fileCounter = 0;
  for (const { src, report } of reports) {
    const track = report.probe?.video_track;
    if (!track) return fail("no_video_stream", `[${src.asset_id}] video track vanished between validation and extraction`);
    const startTimeS = track.start_time_s ?? 0;
    // The playable window is the edit list's segment duration when present,
    // not the raw media duration (media can extend past the edited playback).
    const grid = computeSampleGrid(track.playback_duration_s ?? track.duration_s ?? 0, startTimeS, input.settings);
    for (const w of grid.warnings) warnings.push(`[${src.asset_id}] ${w}`);
    if (grid.times_s.length === 0) {
      return fail("empty_extraction", `[${src.asset_id}] the sampling grid is empty — check duration and settings`);
    }

    for (let i = 0; i < grid.times_s.length; i++) {
      if (hooks.shouldCancel?.()) return cancelled();
      const timeS = grid.times_s[i];
      const fileName = frameFileName(fileCounter++, input.settings.image_format);
      try {
        const decoded = await decoder.decodeAt(src.abs_path, timeS * 1000, framesDir, fileName, input.settings);
        if (!io.exists(decoded.file_path)) {
          throw new Error("decoder reported success but the image file is missing");
        }
        const byteSize = io.byteSize(decoded.file_path);
        if (byteSize === 0) throw new Error("decoded image is 0 bytes");
        const checksum = io.md5(decoded.file_path);
        if (!checksum) throw new Error("checksum unavailable for the decoded image");
        const record: FrameRecord = {
          frame_id: shortId("FRM", randomHex()),
          job_id: input.job_id,
          project_id: input.project_id,
          session_id: input.session_id,
          source_video_asset_id: src.asset_id,
          source_video_segment_index: src.segment_index,
          frame_index: i,
          file_path: relPathOf(input.output_dir_abs, decoded.file_path),
          image_format: input.settings.image_format,
          width: decoded.width,
          height: decoded.height,
          sample_time_s: timeS,
          pts_ms: decoded.pts_ms,
          time_base: decoded.time_base,
          capture_time_mapping: "unavailable",
          capture_time_detail: CAPTURE_TIME_DETAIL,
          byte_size: byteSize,
          checksum_md5: checksum,
          extraction_method: decoded.pts_ms === null ? "seek_decode" : "pts_decode",
          validation_status: "pass",
          warnings: decoded.warnings,
          created_at: new Date().toISOString(),
        };
        await frameRepository.addFrame(db, record);
        io.appendJsonl(framesJsonl, JSON.stringify(record));
        framesExtracted++;
        hooks.onProgress?.(framesExtracted, totalFrames(reports, input.settings));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/cancel/i.test(message)) return cancelled();
        framesFailed++;
        errors.push(`[frame ${i} @ ${timeS}s] decode failed: ${message}`);
      }
    }
  }

  if (framesExtracted === 0) {
    return fail("empty_extraction", `no frame could be extracted (${framesFailed} failed) — the recording may be undecodable on this device`);
  }

  // ---- finalize: records + registration in one transaction ------------------
  hooks.onStage?.("finalizing", `${framesExtracted} frames`);
  const finishedAt = new Date().toISOString();
  const doneJob: ExtractionJob = {
    ...job,
    status: "done",
    frames_extracted: framesExtracted,
    frames_failed: framesFailed,
    warnings,
    errors,
    finished_at: finishedAt,
    processing_duration_s: Date.now() / 1000 - startedMonoS,
    message: `${framesExtracted} frames extracted${framesFailed > 0 ? `, ${framesFailed} failed` : ""}`,
  };

  try {
    io.writeJsonAtomic(`${metadataDir}/extraction.json`, doneJob);
    io.writeJsonAtomic(`${logsDir}/extraction-log.json`, {
      job_id: doneJob.job_id,
      decoder: doneJob.decoder,
      settings: doneJob.settings,
      sources: doneJob.sources,
      frames_extracted: framesExtracted,
      frames_failed: framesFailed,
      started_at: doneJob.started_at,
      finished_at: finishedAt,
      processing_duration_s: doneJob.processing_duration_s,
      warnings,
      errors,
    });
    await frameRepository.markSucceeded(db, {
      job: doneJob,
      framesExtracted,
      warnings,
      finishedAt,
    });
  } catch (err) {
    return fail("registration_failed", `writing extraction records failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  hooks.onStage?.("done", "finished");
  return { kind: "succeeded", job_id: doneJob.job_id, frames_extracted: framesExtracted, frames_failed: framesFailed, warnings };
}

// ---------------------------------------------------------------------------

/** Documented, honest statement attached to every frame record. */
export const CAPTURE_TIME_DETAIL =
  "sample_time_s is the requested seek position in source media time. The platform media decoder does not report the decoded frame's presentation timestamp, and phone recordings provide no measurable mapping from media time to wall-clock capture time (the recording start epoch and the first video frame differ by an unmeasurable warm-up delay). pts_ms and epoch capture time are therefore null, never invented.";

function totalFrames(reports: { report: VideoValidationReport }[], settings: ExtractionSettings): number {
  let total = 0;
  for (const { report } of reports) {
    const track = report.probe?.video_track;
    total += computeSampleGrid(track?.playback_duration_s ?? track?.duration_s ?? 0, track?.start_time_s ?? 0, settings).times_s.length;
  }
  return total;
}

async function validateVideoFile(
  io: ExtractionIo,
  src: ExtractionSourceInput,
): Promise<VideoValidationReport> {
  // Streamed box-walk over a chunked random-access view of the file.
  const totalSize = io.byteSize(src.abs_path);
  return validateVideo(src.rel_path, {
    totalSize,
    readChunk: async (offset, length) => io.readChunk(src.abs_path, offset, length),
  });
}

/** Project-relative path of an absolute file path under a base directory. */
function relPathOf(base: string, abs: string): string {
  const normBase = base.endsWith("/") ? base : `${base}/`;
  return abs.startsWith(normBase) ? abs.slice(normBase.length) : abs;
}

function randomHex(): string {
  let out = "";
  while (out.length < 8) {
    out += Math.floor(Math.random() * 16).toString(16);
  }
  return out.slice(0, 8);
}

// probeMp4 is re-exported so io implementations can build on the same parser.
export { probeMp4 };
