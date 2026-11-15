/**
 * XYZ validator — the plain-text `x y z [nx ny nz] [r g b]` point list
 * documented in `docs/data-exchange.md` (Asset formats → Point clouds).
 *
 * Rules: one point per line, whitespace-separated, `#` comment lines and
 * blank lines allowed, at least three finite numeric tokens per point.
 * Colour interpretation in XYZ files is ambiguous (0–1 vs 0–255) and is
 * never guessed — a warning is recorded instead.
 */

import {
  finishReport,
  PointCloudValidationError,
  type ByteSource,
  type ValidateOptions,
  type ValidationIssue,
  type ValidationReport,
} from "./validate";

export function isXyzFilename(filename: string): boolean {
  return filename.toLowerCase().endsWith(".xyz");
}

/** Widen the closure-assigned firstBad back to its declared type (TS CFA
 * cannot see assignments made inside handleLine). */
function describeFirstBad(fb: { line: number; reason: string } | null): string | null {
  return fb ? `line ${fb.line}: ${fb.reason}` : null;
}

export async function validateXyz(source: ByteSource, options: ValidateOptions = {}): Promise<ValidationReport> {
  const { totalSize } = source;
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const chunkSize = options.chunkSize ?? 1 << 20;

  if (totalSize === 0) {
    return finishReport({
      format: "xyz", verdict: "invalid",
      errors: [{ code: "empty_file", message: "file is empty (0 bytes)" }],
      warnings, point_count: null, bounding_box: null, checked_bytes: 0, details: {},
    });
  }
  if (options.maxBytes !== undefined && totalSize > options.maxBytes) {
    throw new PointCloudValidationError(
      "file_too_large",
      `file is ${totalSize} bytes, above the configured import limit of ${options.maxBytes} bytes`,
      "unsupported",
    );
  }

  const decoder = new TextDecoder("utf-8", { fatal: false });
  let carry = "";
  let offset = 0;
  let count = 0;
  let colorishLines = 0;
  const bbox = {
    min: { x: Infinity, y: Infinity, z: Infinity },
    max: { x: -Infinity, y: -Infinity, z: -Infinity },
  };
  let firstBad: { line: number; reason: string } | null = null;
  let finiteFailures = 0;
  let truncatedLast = true; // decoder stream boundary handling

  const handleLine = (line: string, lineNo: number): void => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const tokens = trimmed.split(/\s+/);
    if (tokens.length < 3) {
      if (!firstBad) firstBad = { line: lineNo, reason: `${tokens.length} values, expected at least 3` };
      return;
    }
    if (tokens.length >= 6) colorishLines++;
    const x = Number(tokens[0]);
    const y = Number(tokens[1]);
    const z = Number(tokens[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      finiteFailures++;
      if (!firstBad) firstBad = { line: lineNo, reason: "non-finite coordinate" };
      return;
    }
    count++;
    bbox.min.x = Math.min(bbox.min.x, x);
    bbox.min.y = Math.min(bbox.min.y, y);
    bbox.min.z = Math.min(bbox.min.z, z);
    bbox.max.x = Math.max(bbox.max.x, x);
    bbox.max.y = Math.max(bbox.max.y, y);
    bbox.max.z = Math.max(bbox.max.z, z);
  };

  let lineNo = 0;
  while (offset < totalSize) {
    if (options.shouldAbort?.()) {
      throw new PointCloudValidationError("cancelled", "validation cancelled by operator", "not_verified");
    }
    const chunk = await source.readChunk(offset, Math.min(chunkSize, totalSize - offset));
    offset += chunk.length;
    const text = carry + decoder.decode(chunk, { stream: offset < totalSize });
    const lines = text.split(/\r?\n/);
    carry = lines.pop() ?? "";
    for (const line of lines) {
      lineNo++;
      handleLine(line, lineNo);
    }
    if (options.onProgress) options.onProgress(offset / totalSize);
  }
  truncatedLast = carry.length > 0;
  lineNo++;
  if (truncatedLast) handleLine(carry, lineNo);

  // firstBad is only assigned inside handleLine, so control-flow analysis
  // cannot see the assignment here — read it through a widening function.
  const firstBadMessage = describeFirstBad(firstBad as { line: number; reason: string } | null);
  if (firstBadMessage) errors.push({ code: "parse_error", message: firstBadMessage });
  if (finiteFailures > 0) {
    errors.push({ code: "parse_error", message: `${finiteFailures} points have non-finite coordinates (NaN/Infinity)` });
  }
  if (count === 0 && errors.length === 0) {
    errors.push({ code: "empty_cloud", message: "no coordinate rows found — the point cloud is empty" });
  }
  if (colorishLines > 0) {
    warnings.push({
      code: "xyz_color_interpretation_ambiguous",
      message: `${colorishLines} rows carry extra values that look like colours; XYZ colour scaling is ambiguous and is not interpreted`,
    });
  }
  warnings.push({
    code: "units_not_documented",
    message: "XYZ files carry no unit, coordinate-frame or CRS metadata; units are recorded as unknown",
  });

  const finiteBox = Number.isFinite(bbox.min.x) && Number.isFinite(bbox.max.x);
  return finishReport({
    format: "xyz",
    verdict: errors.length > 0 ? "invalid" : undefined,
    errors, warnings,
    point_count: count,
    bounding_box: finiteBox ? bbox : null,
    checked_bytes: offset,
    details: { comments_allowed: true, color_ambiguous_rows: colorishLines },
  });
}
