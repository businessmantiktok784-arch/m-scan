/**
 * Stage 3.2 — device-side frame extraction (the only expo-facing glue; the
 * whole pipeline logic lives in the pure `extraction-core.ts`).
 *
 * Decoder reality, stated plainly: this environment cannot integrate FFmpeg
 * (native-module packages are not installable here, and the original
 * ffmpeg-kit was retired). Frames are therefore decoded by the platform's
 * own media framework through Expo's `expo-video-thumbnails`
 * (Android MediaMetadataRetriever / iOS AVAssetImageGenerator) and converted
 * to the requested format with `expo-image-manipulator`. Consequences,
 * recorded in every provenance document:
 *   - decoding is seek-based (`seek_decode`); the decoded frame's own PTS is
 *     NOT exposed by the platform API, so pts_ms/time_base stay null;
 *   - sample times are the requested grid positions in source media time;
 *   - an FFmpeg-based decoder can be plugged into the same `FrameDecoder`
 *     seam later (offline-desktop path) and would fill PTS from showinfo.
 * Nothing here fabricates a frame, a timestamp or a version string.
 */
import { File, Directory, Paths } from "expo-file-system";
import * as VideoThumbnails from "expo-video-thumbnails";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import Constants from "expo-constants";

import { toRepoDb } from "../database/repo-db";
import { openDatabase } from "../database/db";
import { runExtraction, type ExtractionIo, type FrameDecoder, type ExtractionOutcome, type ExtractionHooks, MIN_FREE_BYTES } from "./extraction-core";
import { freeDiskBytes } from "../storage/session-store";
import { shortId } from "../models/models";
import type { ExtractionSettings } from "./models";

export { MIN_FREE_BYTES };
export type { ExtractionOutcome };

function projectRoot(projectId: string): string {
  return new Directory(Paths.document, `projects/${projectId}`).uri;
}

/** Ordinal of a segment filename (segment-0007.mp4 → 7), else null. */
export function parseSegmentIndex(relPath: string): number | null {
  const m = /segment-(\d+)\.mp4$/.exec(relPath.toLowerCase());
  return m ? parseInt(m[1], 10) : null;
}

// ---------------------------------------------------------------------------
// expo-file-system implementation of the pure ExtractionIo seam
// ---------------------------------------------------------------------------

function fileAt(path: string): File {
  return new File(path);
}

function dirAt(path: string): Directory {
  return new Directory(path);
}

const expoIo: ExtractionIo = {
  ensureDir(path) {
    const dir = dirAt(path);
    if (!dir.exists) dir.create({ intermediates: true });
  },
  exists(path) {
    try {
      return fileAt(path).exists || dirAt(path).exists;
    } catch {
      return false;
    }
  },
  removeTree(path) {
    try {
      const dir = dirAt(path);
      if (dir.exists) {
        dir.delete();
        return;
      }
    } catch {
      // fall through to the file case
    }
    try {
      const file = fileAt(path);
      if (file.exists) file.delete();
    } catch {
      // nothing to remove — cleanup is best-effort after failures
    }
  },
  md5(path) {
    const file = fileAt(path);
    return file.exists ? file.md5 : null;
  },
  byteSize(path) {
    const file = fileAt(path);
    return file.exists ? file.size : 0;
  },
  async readChunk(path, offset, length) {
    const file = fileAt(path);
    const handle = file.open();
    try {
      // FileHandle reads may return fewer bytes than requested — loop.
      const out = new Uint8Array(length);
      let filled = 0;
      handle.offset = offset;
      while (filled < length) {
        const chunk = await handle.readBytes(length - filled);
        if (chunk.length === 0) break;
        out.set(chunk, filled);
        filled += chunk.length;
        if (handle.offset >= file.size) break;
      }
      return filled === length ? out : out.subarray(0, filled);
    } finally {
      handle.close();
    }
  },
  writeJsonAtomic(path, value) {
    const file = fileAt(path);
    const dir = file.parentDirectory;
    const name = file.name;
    const tmp = dir.createFile(`${name}.tmp`, null);
    tmp.write(JSON.stringify(value, null, 2));
    if (file.exists) file.delete();
    tmp.rename(name);
  },
  appendJsonl(path, line) {
    const file = fileAt(path);
    if (!file.exists) file.parentDirectory.createFile(file.name, null);
    const handle = file.open();
    try {
      handle.offset = handle.size ?? 0;
      handle.writeBytesSync(new TextEncoder().encode(line + "\n"));
    } finally {
      handle.close();
    }
  },
};

// ---------------------------------------------------------------------------
// Platform-media decoder (FrameDecoder seam implementation)
// ---------------------------------------------------------------------------

export class RetrieverDecoder implements FrameDecoder {
  readonly tool = "expo-video-thumbnails (platform MediaMetadataRetriever / AVAssetImageGenerator)";
  readonly tool_version: string;
  readonly ffmpeg_version = null;
  readonly detail =
    "Seek-based decode: the frame at (or nearest to) each grid position is rendered by the OS media framework. " +
    "The platform API does not report the decoded frame's presentation timestamp, so pts_ms/time_base stay null. " +
    "FFmpeg is NOT integrated in this environment (native modules unavailable; ffmpeg-kit retired).";

  constructor() {
    const runtime = Constants.expoConfig?.runtimeVersion;
    this.tool_version = runtime ? `runtime ${String(runtime)}` : "runtime unknown";
  }

  async decodeAt(
    sourcePath: string,
    timeMs: number,
    outputDir: string,
    fileName: string,
    settings: ExtractionSettings,
  ): Promise<{ file_path: string; width: number | null; height: number | null; pts_ms: number | null; time_base: string | null; warnings: string[] }> {
    const wantsPng = settings.image_format === "png";
    const quality = wantsPng ? 1 : (settings.jpeg_quality ?? 90) / 100;
    const thumb = await VideoThumbnails.getThumbnailAsync(sourcePath, { time: timeMs, quality });
    const warnings: string[] = [];

    let uri = thumb.uri;
    let width = thumb.width ?? null;
    let height = thumb.height ?? null;

    if (wantsPng || (settings.max_dimension_px && (width === null || height === null || Math.max(width, height) > settings.max_dimension_px))) {
      const context = ImageManipulator.manipulate(uri);
      if (settings.max_dimension_px && width !== null && height !== null && Math.max(width, height) > settings.max_dimension_px) {
        const scale = settings.max_dimension_px / Math.max(width, height);
        context.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) });
        warnings.push(`image downscaled to fit max_dimension_px=${settings.max_dimension_px} (recorded in provenance)`);
      }
      const rendered = await context.renderAsync();
      try {
        const saved = await rendered.saveAsync({
          compress: quality,
          format: wantsPng ? SaveFormat.PNG : SaveFormat.JPEG,
        });
        width = rendered.width;
        height = rendered.height;
        uri = saved.uri;
      } finally {
        rendered.release();
      }
    }

    // Move the produced image into the extraction's frames/ directory under
    // the exact deterministic name (never left in the cache).
    const target = new File(dirAt(outputDir), fileName);
    const produced = new File(uri);
    if (target.exists) target.delete();
    produced.moveSync(target);
    if (!target.exists) throw new Error("decoded frame could not be moved into the extraction directory");

    return { file_path: target.uri, width, height, pts_ms: null, time_base: null, warnings };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ExtractionRequest {
  projectId: string;
  sessionId: string;
  /** camera_video assets (from the assets table) selected by the operator. */
  sources: { assetId: string; relPath: string }[];
  settings: ExtractionSettings;
  hooks?: ExtractionHooks;
}

/**
 * Runs one frame extraction job end-to-end. Sources must be camera_video
 * assets of the given session; the pipeline validates them all before
 * decoding, extracts the sampling grid per segment (segments are processed
 * one at a time — never merged), verifies every frame and registers the
 * frame set only on success.
 */
export async function startFrameExtraction(request: ExtractionRequest): Promise<ExtractionOutcome> {
  if (request.sources.length === 0) {
    throw new Error("no video segments selected");
  }
  const jobId = shortId("JOB", randomHex());
  const root = projectRoot(request.projectId);
  const outputRel = `sessions/${request.sessionId}/frames/${jobId}`;
  const db = toRepoDb(await openDatabase());
  const free = await freeDiskBytes();
  return runExtraction(
    {
      job_id: jobId,
      project_id: request.projectId,
      session_id: request.sessionId,
      sources: request.sources.map((s) => ({
        asset_id: s.assetId,
        abs_path: `${root}${s.relPath}`,
        rel_path: s.relPath,
        segment_index: parseSegmentIndex(s.relPath),
      })),
      settings: request.settings,
      output_dir_abs: `${root}${outputRel}`,
      free_bytes: free,
    },
    db,
    expoIo,
    new RetrieverDecoder(),
    request.hooks,
  );
}

function randomHex(): string {
  let out = "";
  while (out.length < 8) {
    out += Math.floor(Math.random() * 16).toString(16);
  }
  return out.slice(0, 8);
}
