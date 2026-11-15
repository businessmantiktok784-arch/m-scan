/**
 * Capture-manifest helpers (pure) — manifest construction, validation and
 * the safe index/file reconciliation policy from docs/hardware-verification.md
 * Part 3: stale entries are MARKED, never auto-deleted.
 */
import { captureManifestSchema, type CaptureManifest } from "../models/capture";

export function validateManifest(value: unknown): CaptureManifest {
  return captureManifestSchema.parse(value);
}

export interface StaleReport {
  missingFiles: string[];
  /** Index rows whose file still exists — untouched. */
  okCount: number;
}

/**
 * Read-only reconciliation: given the manifest/file index and the set of
 * paths that actually exist on disk, report which entries are stale. The
 * CALLER decides what to do (per policy: show "FILE MISSING" + a confirmed
 * remove action — never silent deletion).
 */
export function reconcileIndex(indexPaths: string[], existingPaths: ReadonlySet<string>): StaleReport {
  const missingFiles = indexPaths.filter((p) => !existingPaths.has(p));
  return { missingFiles, okCount: indexPaths.length - missingFiles.length };
}

/** Human-readable warning lines added to a manifest on interruption. */
export function interruptionWarning(reason: string, action: "paused" | "failed" | "aborted"): string {
  return `Interruption (${reason}): session ${action} — completeness not guaranteed; verify files before use.`;
}
