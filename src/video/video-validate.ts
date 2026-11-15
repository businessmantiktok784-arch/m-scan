/**
 * Stage 3.2 — video-input validation.
 *
 * Validates genuine camera-video files (the MP4 segments the Stage 2
 * recorder produces) structurally, before any frame decoding is attempted.
 * A valid container is never treated as a decoding guarantee — the report
 * carries the structural facts and the decoder still can fail per frame.
 *
 * Verdicts reuse the Stage 3.1 vocabulary and stay distinct:
 *   valid / valid_with_warnings — structurally sound MP4 with a supported
 *                                 video track
 *   invalid                     — corrupt, empty, or no video stream
 *   unsupported_variant         — real but deliberately unsupported
 *                                 (other containers, other codecs)
 *   incomplete                  — moov box missing (recording cut short)
 */

import { probeMp4, VideoParseError, type Mp4Probe } from "./mp4-probe";

export type ValidationVerdict =
  | "valid"
  | "valid_with_warnings"
  | "invalid"
  | "unsupported"
  | "unsupported_variant"
  | "incomplete"
  | "not_verified";

export interface ValidationIssue {
  code: string;
  message: string;
}

export interface VideoValidationReport {
  format: "mp4";
  verdict: ValidationVerdict;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  probe: Mp4Probe | null;
  checked_bytes: number;
}

/** Containers the extractor does not support, with a meaningful message. */
const NON_MP4_EXTENSIONS: Record<string, string> = {
  ".avi": "AVI",
  ".mov": "QuickTime MOV",
  ".mkv": "Matroska",
  ".webm": "WebM",
  ".ts": "MPEG-TS",
  ".wmv": "Windows Media",
  ".flv": "Flash Video",
};

export function videoVerdictToAssetStatus(verdict: ValidationVerdict): "pass" | "warn" | "fail" {
  if (verdict === "valid") return "pass";
  if (verdict === "valid_with_warnings") return "warn";
  return "fail";
}

export async function validateVideo(
  filename: string,
  source: { totalSize: number; readChunk(offset: number, length: number): Promise<Uint8Array> },
): Promise<VideoValidationReport> {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const lower = filename.toLowerCase();

  if (source.totalSize === 0) {
    return {
      format: "mp4",
      verdict: "invalid",
      errors: [{ code: "zero_byte_file", message: "the video file is empty (0 bytes)" }],
      warnings,
      probe: null,
      checked_bytes: 0,
    };
  }

  for (const [ext, label] of Object.entries(NON_MP4_EXTENSIONS)) {
    if (lower.endsWith(ext)) {
      return {
        format: "mp4",
        verdict: "unsupported_variant",
        errors: [
          {
            code: "unsupported_container",
            message: `${label} containers are not supported; this stage validates the MP4 segments the recorder produces`,
          },
        ],
        warnings,
        probe: null,
        checked_bytes: 0,
      };
    }
  }

  let probe: Mp4Probe | null = null;
  try {
    probe = await probeMp4(source);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const noMoov = /moov/i.test(message) || message.includes("not an MP4");
    return {
      format: "mp4",
      verdict: noMoov ? "incomplete" : "invalid",
      errors: [
        noMoov
          ? { code: "incomplete_recording", message: `the recording has no moov (index) box — likely cut short or still open: ${message}` }
          : { code: "video_unreadable", message },
      ],
      warnings,
      probe: null,
      checked_bytes: source.totalSize,
    };
  }

  for (const w of probe.warnings) warnings.push({ code: "structural_warning", message: w });

  if (!probe.has_moov) {
    return {
      format: "mp4",
      verdict: "incomplete",
      errors: [{ code: "incomplete_recording", message: "the recording has no moov (index) box — likely cut short or still open" }],
      warnings,
      probe,
      checked_bytes: source.totalSize,
    };
  }

  const track = probe.video_track;
  if (!track) {
    errors.push({
      code: "no_video_stream",
      message: probe.audio_tracks > 0
        ? "the file has audio track(s) but no video stream"
        : "the file declares no video track",
    });
    return { format: "mp4", verdict: "invalid", errors, warnings, probe, checked_bytes: source.totalSize };
  }

  if (track.codec_tag && !/^(avc1|avc3)$/.test(track.codec_tag)) {
    return {
      format: "mp4",
      verdict: "unsupported_variant",
      errors: [
        {
          code: "unsupported_codec",
          message: `video codec '${track.codec_tag}' (${track.codec_name ?? "unknown"}) is outside the supported set (H.264/AVC, the recorder's output)`,
        },
      ],
      warnings,
      probe,
      checked_bytes: source.totalSize,
    };
  }

  // Warnings are facts an operator should see, never silent.
  if (probe.audio_tracks > 0) {
    warnings.push({
      code: "audio_stream_present",
      message: `${probe.audio_tracks} audio stream(s) present — the recorder is configured muted; audio is ignored for extraction`,
    });
  }
  if (track.constant_framerate === false) {
    warnings.push({
      code: "variable_frame_rate",
      message: "the track uses variable frame rate; extracted sample times come from the sampling grid, not from decoded PTS",
    });
  }
  if (track.start_time_s !== null && track.start_time_s > 0) {
    warnings.push({
      code: "nonzero_media_start",
      message: `the track's media composition starts at ${track.start_time_s}s (edit list) — sample times are relative to media start and the offset is preserved in provenance`,
    });
  }
  if (track.sync_sample_count !== null && track.sample_count !== null && track.sync_sample_count < track.sample_count) {
    warnings.push({
      code: "interframe_compression",
      message: `${track.sync_sample_count} of ${track.sample_count} frames are keyframes; seek-based extraction lands on the nearest decodable frame`,
    });
  }
  if (track.rotation_deg) {
    warnings.push({
      code: "rotation_metadata",
      message: `display matrix stores ${track.rotation_deg}° rotation; the platform decoder applies it and the extracted images carry the rotated content`,
    });
  }

  const verdict: ValidationVerdict = warnings.length > 0 ? "valid_with_warnings" : "valid";
  return { format: "mp4", verdict, errors, warnings, probe, checked_bytes: source.totalSize };
}
