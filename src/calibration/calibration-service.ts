/**
 * Stage 3.3 — device-side camera calibration (the only expo-facing glue for
 * Stage 3.3; all pipeline logic lives in the pure `calibration-core.ts`,
 * which is also what the bun tests exercise directly).
 *
 * Engine reality, stated plainly: OpenCV is NOT available on device
 * (native modules are not installable in this environment). Calibration is
 * therefore the pure-TypeScript Zhang implementation in this repository,
 * labelled `mining-scanner calibration core (pure TypeScript Zhang)` in
 * provenance, with results marked `computed` / `computed_with_warnings`
 * and `validation_status: did_not_pass_checks_or_unverified` — never
 * "independently_validated". The service resolves frames from a Stage 3.2
 * frame set, enforces the same 200 MB storage headroom rule as capture,
 * import and extraction, and never overwrites an existing calibration.
 */
import { File, Directory, Paths } from "expo-file-system";
import Constants from "expo-constants";

import { toRepoDb } from "../database/repo-db";
import { openDatabase } from "../database/db";
import { frameRepository } from "../database/frame-repository";
import { calibrationRepository } from "../database/calibration-repository";
import { freeDiskBytes } from "../storage/session-store";
import { shortId } from "../models/models";
import {
  runCalibration,
  type CalibrationIo,
  type CalibrationOutcome,
  type CalibrationHooks,
} from "./calibration-core";
import {
  calibrationRunSettingsSchema,
  type CalibrationRecord,
  type CalibrationRunSettings,
  type CheckerboardTarget,
} from "./models";

export { MIN_FREE_BYTES } from "./calibration-core";
export type { CalibrationOutcome };

function projectRoot(projectId: string): string {
  return new Directory(Paths.document, `projects/${projectId}`).uri;
}

/** Real app version of the host, or "unknown" — never invented. */
function appVersion(): string {
  return Constants.expoConfig?.version ?? "unknown";
}

// ---------------------------------------------------------------------------
// expo-file-system implementation of the pure CalibrationIo seam
// ---------------------------------------------------------------------------

function fileAt(path: string): File {
  return new File(path);
}

function dirAt(path: string): Directory {
  return new Directory(path);
}

const expoIo: CalibrationIo = {
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
  /** Whole-file read (one image at a time; the core releases it per frame). */
  async readBytes(path) {
    const file = fileAt(path);
    const handle = file.open();
    try {
      const size = file.size;
      const out = new Uint8Array(size);
      let filled = 0;
      // FileHandle reads may return fewer bytes than requested — loop.
      while (filled < size) {
        const chunk = await handle.readBytes(size - filled);
        if (chunk.length === 0) break;
        out.set(chunk, filled);
        filled += chunk.length;
      }
      return filled === size ? out : out.subarray(0, filled);
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
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CalibrationRequest {
  projectId: string;
  /** The Stage 3.2 frame set (JOB-) whose passing frames feed calibration. */
  frameSetJobId: string;
  /** Operator label of the camera this calibration applies to. */
  cameraLabel: string;
  /** The known checkerboard target used during capture. */
  target: CheckerboardTarget;
  /** Optional overrides of quality-gate settings; all defaults documented. */
  settingsOverrides?: Partial<Omit<CalibrationRunSettings, "method" | "target">>;
  hooks?: CalibrationHooks;
}

/**
 * Runs one calibration end-to-end against a completed frame set. Frames are
 * resolved from the frame-extraction job (passing rows only, in stored
 * order); the pipeline itself evaluates suitability, detects the board,
 * solves Zhang and registers the CAL- asset only on success.
 */
export async function startCalibration(request: CalibrationRequest): Promise<CalibrationOutcome> {
  const db = toRepoDb(await openDatabase());

  // The frame set must be a completed extraction job.
  const job = await frameRepository.getExtraction(db, request.frameSetJobId);
  if (!job) {
    throw new Error(`frame set ${request.frameSetJobId} not found`);
  }
  if (job.status !== "done") {
    throw new Error(`frame set ${request.frameSetJobId} is ${job.status}, not done — calibrate only completed frame sets`);
  }
  const frames = (await frameRepository.listFrames(db, request.frameSetJobId)).filter((f) => f.validation_status === "pass");
  if (frames.length === 0) {
    throw new Error(`frame set ${request.frameSetJobId} has no passing frames to calibrate from`);
  }

  const settings = calibrationRunSettingsSchema.parse({
    method: "known_target_checkerboard",
    target: request.target,
    ...request.settingsOverrides,
  });

  const calibrationId = shortId("CAL", randomHex());
  const root = projectRoot(request.projectId);
  const outputRel = `calibrations/${calibrationId}`;
  const free = await freeDiskBytes();

  return runCalibration(
    {
      calibration_id: calibrationId,
      project_id: request.projectId,
      session_id: job.session_id,
      camera_label: request.cameraLabel,
      target: request.target,
      settings,
      frames: frames.map((f) => ({
        frame_id: f.frame_id,
        abs_path: `${job.output_directory}${job.output_directory.endsWith("/") ? "" : "/"}${f.file_path}`,
        rel_path: `sessions/${job.session_id}/frames/${job.job_id}/${f.file_path}`,
        image_format: f.image_format,
        width: f.width,
        height: f.height,
        checksum_md5: f.checksum_md5,
        source_video_asset_id: f.source_video_asset_id,
      })),
      output_dir_abs: `${root}${outputRel}`,
      free_bytes: free,
      app_version: appVersion(),
    },
    db,
    expoIo,
    request.hooks,
  );
}

/** Crash reconciliation: stale 'running' calibrations become 'interrupted'. */
export async function reconcileInterruptedCalibrations(): Promise<string[]> {
  const db = toRepoDb(await openDatabase());
  return calibrationRepository.interruptStaleCalibrations(db, new Date().toISOString());
}

/** Finished calibration records for a project (newest first). */
export async function listCalibrations(projectId: string): Promise<CalibrationRecord[]> {
  const db = toRepoDb(await openDatabase());
  return calibrationRepository.listCalibrations(db, projectId);
}

function randomHex(): string {
  let out = "";
  while (out.length < 8) {
    out += Math.floor(Math.random() * 16).toString(16);
  }
  return out.slice(0, 8);
}
