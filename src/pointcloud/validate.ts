/**
 * Point-cloud validation — shared types and the byte-source abstraction.
 *
 * Stage 3.1 scope: external point-cloud IMPORT (registry operation
 * `pointcloud_import`, mobile-or-desktop host). This module is pure
 * TypeScript (no React Native / expo imports) so it runs off-device under
 * `bun test` against committed fixture files.
 *
 * Honesty rules (binding):
 * - A verdict is computed from the file bytes, never asserted.
 * - The distinct verdicts valid / valid_with_warnings / invalid /
 *   unsupported / incomplete / not_verified are never conflated: a warning
 *   is never upgraded to a success claim, and an unreadable file is never
 *   reported as valid.
 * - Coordinates are never transformed and units are never assumed. A file
 *   that does not document its units yields `unit_unknown`.
 */

export type ValidationVerdict =
  | "valid"
  | "valid_with_warnings"
  | "invalid"
  | "unsupported"
  | "incomplete"
  | "not_verified";

export type PointCloudFormat = "ply" | "xyz" | "las" | "laz";

export interface BoundingBox {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

export interface ValidationIssue {
  /** Stable machine-readable code; also used as registry failure modes. */
  code: string;
  message: string;
}

export interface ValidationReport {
  format: PointCloudFormat;
  verdict: ValidationVerdict;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  /** Counted from actual data, never copied from a header alone. */
  point_count: number | null;
  bounding_box: BoundingBox | null;
  /** How many bytes of the file the validator actually examined. */
  checked_bytes: number;
  checked_at: string;
  /** Format-specific facts (encoding, properties, CRS, ...). Values are facts, not estimates. */
  details: Record<string, string | number | boolean | null>;
}

/** Minimal random-access byte provider — the only I/O the validators need. */
export interface ByteSource {
  readonly totalSize: number;
  /** Must return exactly `min(length, totalSize - offset)` bytes. */
  readChunk(offset: number, length: number): Promise<Uint8Array>;
}

export function byteSourceFromBytes(bytes: Uint8Array): ByteSource {
  return {
    totalSize: bytes.length,
    async readChunk(offset: number, length: number): Promise<Uint8Array> {
      return bytes.subarray(offset, Math.min(offset + length, bytes.length));
    },
  };
}

export interface ValidateOptions {
  chunkSize?: number;
  /** Reject files larger than this before reading (registered failure mode `file_too_large`). */
  maxBytes?: number;
  /** Polling cancellation hook; checked between chunks. */
  shouldAbort?: () => boolean;
  onProgress?: (fraction: number) => void;
}

export class PointCloudValidationError extends Error {
  readonly code: string;
  readonly verdict: ValidationVerdict;
  constructor(code: string, message: string, verdict: ValidationVerdict = "invalid") {
    super(message);
    this.name = "PointCloudValidationError";
    this.code = code;
    this.verdict = verdict;
  }
}

/** Extension → format mapping; content is confirmed by magic bytes afterwards. */
export function formatFromFilename(filename: string): PointCloudFormat | null {
  const clean = filename.toLowerCase();
  if (clean.endsWith(".ply")) return "ply";
  if (clean.endsWith(".xyz")) return "xyz";
  if (clean.endsWith(".las")) return "las";
  if (clean.endsWith(".laz")) return "laz";
  return null;
}

/** Removes path separators and control characters; keeps the name readable. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "pointcloud";
  const clean = base.replace(/[\x00-\x1f\x7f]/g, "").trim();
  return (clean.length > 0 ? clean : "pointcloud").slice(0, 255);
}

/**
 * Final-verdict helper: invalid beats incomplete beats warning beats valid.
 * `unsupported` and `not_verified` are decided explicitly by callers, not
 * merged here.
 */
export function resolveVerdict(
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
): ValidationVerdict {
  if (errors.length > 0) return "invalid";
  if (warnings.length > 0) return "valid_with_warnings";
  return "valid";
}

export function finishReport(
  partial: Omit<ValidationReport, "checked_at" | "verdict"> & { verdict?: ValidationVerdict },
): ValidationReport {
  return {
    ...partial,
    verdict: partial.verdict ?? resolveVerdict(partial.errors, partial.warnings),
    checked_at: new Date().toISOString(),
  };
}
