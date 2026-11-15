/**
 * Stage 3.1 — external point-cloud IMPORT service (the only expo-facing
 * glue; all parsing/validation logic lives in the pure sibling modules).
 *
 * Pipeline (each stage is reported to the UI and journalled):
 *   1. pick          — system document picker (no path guessing, no imports
 *                      outside the picker).
 *   2. preflight     — extension→format, byte-size gate (2 GB), free-space
 *                      gate (file + 200 MB headroom).
 *   3. register      — processing_operations + pointcloud_imports rows
 *                      ('running'/'importing') BEFORE any bytes move.
 *   4. copy          — the source file is COPIED into
 *                      projects/{pid}/assets/pointclouds/{assetId}/source/
 *                      and PRESERVED unmodified (originals are never touched).
 *   5. validate      — streamed, chunked, cancellable validation of the
 *                      preserved copy; verdicts never asserted.
 *   6. finalize      — on valid/valid_with_warnings: asset.json,
 *                      validation.json and import-log.json written
 *                      atomically, then the assets row + 'succeeded' flip in
 *                      ONE transaction. On anything else: the temporary
 *                      directory is deleted and nothing is registered.
 *
 * Honesty rules: failed/interrupted/cancelled imports never register as
 * assets; units are never assumed (unit_unknown); scale is always recorded
 * as UNKNOWN/basis 'none' for imports; LAS payloads are not decoded.
 */
import * as DocumentPicker from "expo-document-picker";
import { File, Directory, Paths } from "expo-file-system";

import {
  formatFromFilename,
  sanitizeFilename,
  PointCloudValidationError,
  type ByteSource,
  type PointCloudFormat,
  type ValidationReport,
} from "./validate";
import { validatePly } from "./ply";
import { validateXyz } from "./xyz";
import { validateLas } from "./las";
import { pointCloudAssetSchema, shortId, type PointCloudAsset } from "../models/models";
import { importToolIdentity, type PointCloudImportRecord } from "../models/import";
import { openDatabase } from "../database/db";
import { importRepository } from "../database/import-repository";
import { toRepoDb } from "../database/repo-db";
import { fileMeta, freeDiskBytes, MIN_FREE_BYTES, writeJsonAtomic } from "../storage/session-store";

/** Hard byte cap for imports (registered failure mode `file_too_large`). */
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024 * 1024;

export type ImportStage = "picking" | "preflight" | "copying" | "validating" | "finalizing" | "done";

export interface PickedFile {
  uri: string;
  name: string;
  size: number | null;
}

export type ImportOutcome =
  | { kind: "succeeded"; assetId: string; operationId: string; verdict: ValidationReport["verdict"]; report: ValidationReport; asset: PointCloudAsset }
  | { kind: "failed"; assetId: string; operationId: string; code: string; message: string; report: ValidationReport | null }
  | { kind: "cancelled"; assetId: string; operationId: string };

export interface ImportCallbacks {
  onStage?: (stage: ImportStage, detail?: string) => void;
  onProgress?: (fraction: number) => void;
  /** Polling cancellation — checked between validation chunks. */
  shouldCancel?: () => boolean;
}

/** System document picker → a picked file, or null when cancelled. */
export async function pickPointCloudFile(): Promise<PickedFile | null> {
  const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
  if (result.canceled || !result.assets || result.assets.length === 0) return null;
  const asset = result.assets[0];
  return { uri: asset.uri, name: asset.name ?? "pointcloud", size: asset.size ?? null };
}

function projectPointcloudDir(projectId: string, assetId: string): Directory {
  return new Directory(Paths.document, `projects/${projectId}/assets/pointclouds/${assetId}`);
}

/** Wraps an expo file in the validators' ByteSource (chunked, seek-based). */
function byteSourceFromFile(file: File): { source: ByteSource; close: () => void } {
  const totalSize = file.size;
  let handle: import("expo-file-system").FileHandle | null = null;
  const ensure = () => {
    if (!handle) handle = file.open();
    return handle;
  };
  return {
    source: {
      totalSize,
      async readChunk(offset: number, length: number): Promise<Uint8Array> {
        const h = ensure();
        const want = Math.min(length, totalSize - offset);
        if (want <= 0) return new Uint8Array(0);
        h.offset = offset;
        const parts: Uint8Array[] = [];
        let got = 0;
        while (got < want) {
          const chunk = await h.readBytes(want - got);
          if (chunk.length === 0) break;
          parts.push(chunk);
          got += chunk.length;
        }
        if (parts.length === 1) return parts[0];
        const out = new Uint8Array(got);
        let at = 0;
        for (const p of parts) {
          out.set(p, at);
          at += p.length;
        }
        return out;
      },
    },
    close: () => {
      if (handle) {
        try {
          handle.close();
        } catch {
          /* already closed */
        }
        handle = null;
      }
    },
  };
}

/**
 * Runs the full import for an already-picked file. Throws only on
 * unexpected (non-domain) errors; domain outcomes are returned as values.
 */
export async function importPointCloud(input: {
  projectId: string;
  picked: PickedFile;
  appVersion: string | undefined;
  callbacks?: ImportCallbacks;
}): Promise<ImportOutcome> {
  const { projectId, picked } = input;
  const cb = input.callbacks ?? {};
  const now = () => new Date().toISOString();
  const assetId = shortId("PC", crypto.randomUUID().replace(/-/g, ""));
  const operationId = shortId("OP", crypto.randomUUID().replace(/-/g, ""));
  const validationId = shortId("VAL", crypto.randomUUID().replace(/-/g, ""));
  const originalName = sanitizeFilename(picked.name);

  const failDomain = async (code: string, message: string, report: ValidationReport | null): Promise<ImportOutcome> => {
    cb.onStage?.("done", code);
    return { kind: "failed", assetId, operationId, code, message, report };
  };

  cb.onStage?.("preflight", originalName);

  // ---- preflight: format, size, free space ----
  const format = formatFromFilename(originalName);
  if (format === "laz") {
    return failDomain(
      "unsupported_variant",
      "LAZ (compressed LAS) is not supported on device — no decompressor is available. Convert to PLY or uncompressed LAS on a workstation first.",
      null,
    );
  }
  if (!format) {
    return failDomain("unsupported_format", `Unsupported file type: "${originalName}". Supported: .ply, .xyz, .las (not .laz).`, null);
  }

  const sourceFile = new File(picked.uri);
  if (!sourceFile.exists) {
    return failDomain("source_missing", "The picked file is no longer accessible.", null);
  }
  const byteSize = sourceFile.size;
  if (byteSize > MAX_IMPORT_BYTES) {
    return failDomain(
      "file_too_large",
      `File is ${(byteSize / (1024 * 1024)).toFixed(1)} MB; the import limit is ${(MAX_IMPORT_BYTES / (1024 * 1024)).toFixed(0)} MB.`,
      null,
    );
  }
  const free = await freeDiskBytes();
  if (free > 0 && free < byteSize + MIN_FREE_BYTES) {
    return failDomain(
      "insufficient_storage",
      `Not enough free storage: ${(free / (1024 * 1024)).toFixed(0)} MB free, need at least ${((byteSize + MIN_FREE_BYTES) / (1024 * 1024)).toFixed(0)} MB.`,
      null,
    );
  }

  // ---- register the operation before any bytes move ----
  const startedAt = now();
  const { tool, tool_version } = importToolIdentity(input.appVersion);
  const db = toRepoDb(await openDatabase());
  const stagedRecord: PointCloudImportRecord = {
    asset_id: assetId,
    project_id: projectId,
    operation_id: operationId,
    original_filename: originalName,
    stored_rel_path: "", // filled after the copy lands
    format,
    byte_size: byteSize,
    checksum_md5: "", // filled after the copy lands
    validation_status: "not_verified",
    import_status: "importing",
    point_count: null,
    meta_json: "{}",
    created_at: startedAt,
    updated_at: startedAt,
  };
  await importRepository.beginImport(db, {
    operation: { operation_id: operationId, project_id: projectId, input_ref: originalName, tool, tool_version, started_at: startedAt },
    import: stagedRecord,
  });

  const cleanupDir = (): void => {
    try {
      const dir = projectPointcloudDir(projectId, assetId);
      if (dir.exists) dir.delete();
    } catch {
      /* best effort */
    }
  };

  const failImport = async (code: string, message: string, report: ValidationReport | null, detail: Record<string, unknown>): Promise<ImportOutcome> => {
    cleanupDir();
    await importRepository.markFailed(db, {
      assetId, operationId,
      opStatus: "failed",
      message,
      detailJson: JSON.stringify({ ...detail, report }, null, 2),
      at: now(),
    });
    return failDomain(code, message, report);
  };

  // ---- copy: preserve the original unmodified ----
  cb.onStage?.("copying", originalName);
  const baseDir = projectPointcloudDir(projectId, assetId);
  try {
    baseDir.create({ intermediates: true });
  } catch (err) {
    return failImport("storage_error", `Could not create the import directory: ${(err as Error).message}`, null, { stage: "copy" });
  }
  const sourceDir = baseDir.createDirectory("source");
  const metadataDir = baseDir.createDirectory("metadata");
  const logsDir = baseDir.createDirectory("logs");
  const storedFile = new File(sourceDir, originalName);
  try {
    sourceFile.copy(storedFile);
  } catch (err) {
    return failImport("storage_error", `Copy failed: ${(err as Error).message}`, null, { stage: "copy" });
  }
  const meta = fileMeta(storedFile);
  if (meta.checksum_md5 === null) {
    return failImport("checksum_mismatch", "Checksum of the copied file could not be computed; import aborted.", null, { stage: "copy" });
  }
  const storedRelPath = `projects/${projectId}/assets/pointclouds/${assetId}/source/${originalName}`;

  // ---- validate the preserved copy (streamed, cancellable) ----
  cb.onStage?.("validating", originalName);
  let report: ValidationReport;
  const opened = byteSourceFromFile(storedFile);
  try {
    const validator = format === "ply" ? validatePly : format === "xyz" ? validateXyz : validateLas;
    report = await validator(opened.source, {
      maxBytes: MAX_IMPORT_BYTES,
      shouldAbort: cb.shouldCancel,
      onProgress: (f) => cb.onProgress?.(f),
    });
  } catch (err) {
    if (err instanceof PointCloudValidationError) {
      if (err.verdict === "not_verified" && err.code === "cancelled") {
        cleanupDir();
        await importRepository.markFailed(db, {
          assetId, operationId,
          opStatus: "cancelled",
          message: "cancelled by operator during validation",
          detailJson: JSON.stringify({ code: "cancelled", stage: "validate" }),
          at: now(),
        });
        cb.onStage?.("done", "cancelled");
        return { kind: "cancelled", assetId, operationId };
      }
      return failImport(err.code, err.message, null, { stage: "validate" });
    }
    return failImport("unexpected_error", (err as Error).message, null, { stage: "validate" });
  } finally {
    opened.close();
  }

  if (cb.shouldCancel?.()) {
    cleanupDir();
    await importRepository.markFailed(db, {
      assetId, operationId,
      opStatus: "cancelled",
      message: "cancelled by operator after validation",
      detailJson: JSON.stringify({ code: "cancelled", stage: "finalize" }),
      at: now(),
    });
    cb.onStage?.("done", "cancelled");
    return { kind: "cancelled", assetId, operationId };
  }

  // ---- verdict dispatch: only valid / valid_with_warnings may register ----
  if (report.verdict !== "valid" && report.verdict !== "valid_with_warnings") {
    const first = report.errors[0];
    return failImport(
      first?.code ?? "validation_failed",
      first?.message ?? `Validation verdict: ${report.verdict}`,
      report,
      { stage: "validate", verdict: report.verdict },
    );
  }

  cb.onStage?.("finalizing", originalName);
  const finishedAt = now();

  // Units: no imported format documents a unit this importer can verify —
  // LAS carries scale factors but its units depend on the CRS, which is not
  // self-describing. unit_unknown is the only honest value.
  const coordinate_units: PointCloudAsset["coordinate_units"] = "unit_unknown";
  const asset: PointCloudAsset = {
    asset_id: assetId,
    project_id: projectId,
    session_id: null,
    file_path: storedRelPath,
    format,
    coordinate_units,
    coordinate_convention: "source_documented",
    point_count: report.point_count,
    byte_size: meta.byte_size,
    created_at: finishedAt,
    original_filename: originalName,
    content: {
      coordinate_properties: coordinateProperties(report),
      has_colors: report.details.has_colors === true,
      has_normals: report.details.has_normals === true,
      crs: typeof report.details.crs === "string" ? report.details.crs : null,
    },
    checksum_md5: meta.checksum_md5,
    provenance: { kind: "imported", operation_id: operationId, tool: `${tool} v${tool_version}` },
    scale_status: "UNKNOWN",
    scale_provenance: {
      scale_status: "UNKNOWN",
      basis: "none",
      detail:
        "External import: the file carries no trusted real-world scale or unit metadata that this importer can verify. " +
        "Never treat these coordinates as metric survey data until an independent scale basis is documented.",
      measured_by: "",
      created_at: finishedAt,
    },
    validation: {
      validation_id: validationId,
      verdict: report.verdict === "valid" ? "pass" : "warn",
    },
  };
  // Parse-check against the v1.3 schema mirror before anything is written.
  const checked = pointCloudAssetSchema.safeParse(asset);
  if (!checked.success) {
    return failImport("unexpected_error", `Internal record failed schema validation: ${checked.error.issues[0]?.message}`, report, { stage: "finalize" });
  }

  const validationDoc = { validation_id: validationId, asset_id: assetId, operation_id: operationId, ...report };
  const importLog = {
    asset_id: assetId,
    operation_id: operationId,
    tool,
    tool_version,
    original_filename: originalName,
    stored_rel_path: storedRelPath,
    byte_size: meta.byte_size,
    checksum_md5: meta.checksum_md5,
    started_at: startedAt,
    finished_at: finishedAt,
    verdict: report.verdict,
    warnings: report.warnings,
    errors: report.errors,
  };
  try {
    writeJsonAtomic(metadataDir, "asset.json", asset);
    writeJsonAtomic(metadataDir, "validation.json", validationDoc);
    writeJsonAtomic(logsDir, "import-log.json", importLog);
  } catch (err) {
    return failImport("storage_error", `Writing import records failed: ${(err as Error).message}`, report, { stage: "finalize" });
  }

  const record: PointCloudImportRecord = {
    ...stagedRecord,
    stored_rel_path: storedRelPath,
    checksum_md5: meta.checksum_md5,
    validation_status: report.verdict,
    point_count: report.point_count,
    meta_json: JSON.stringify(asset),
    updated_at: finishedAt,
  };
  try {
    await importRepository.markSucceeded(db, {
      import: record,
      asset: {
        asset_id: assetId,
        project_id: projectId,
        session_id: null,
        file_path: storedRelPath,
        byte_size: meta.byte_size,
        meta_json: JSON.stringify(asset),
        created_at: finishedAt,
      },
      message: `imported ${originalName} (${report.verdict}, ${report.point_count ?? "unknown"} points)`,
    });
  } catch (err) {
    return failImport("storage_error", `Registering the import failed: ${(err as Error).message}`, report, { stage: "finalize" });
  }

  cb.onStage?.("done", report.verdict);
  return { kind: "succeeded", assetId, operationId, verdict: report.verdict, report, asset };
}

function coordinateProperties(report: ValidationReport): string[] {
  const props = report.details.vertex_properties;
  if (Array.isArray(props) && props.length > 0) return props.map(String);
  if (report.format === "xyz") return ["x", "y", "z"]; // positional columns, documented as positional
  if (report.format === "las") return ["X", "Y", "Z"]; // scaled integers per LAS header
  return [];
}

/**
 * Crash reconciliation — call once when the app (re)gains focus and no
 * import is actually running. Stale 'importing' rows become 'interrupted'.
 */
export async function reconcileInterruptedImports(): Promise<string[]> {
  const db = toRepoDb(await openDatabase());
  return importRepository.interruptStaleImports(db, new Date().toISOString());
}
