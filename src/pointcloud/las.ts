/**
 * LAS validator — genuine public-header and VLR inspection for LAS 1.0–1.4
 * files (`.las`). Point PAYLOADS are not decoded: the header's counts,
 * scales, offsets and bounding box are recorded as file metadata with an
 * explicit "not independently verified" warning — they are never presented
 * as measurements computed from the data.
 *
 * LAZ (compressed LAS carrying a laszip VLR, or a `.laz` filename) is
 * rejected as UNSUPPORTED on device: no decompressor exists in the mobile
 * runtime. The message says so plainly instead of misreporting the file.
 *
 * Memory: header + VLR sections are small; the point payload is never read.
 */

import {
  finishReport,
  PointCloudValidationError,
  type ByteSource,
  type ValidateOptions,
  type ValidationIssue,
  type ValidationReport,
} from "./validate";

export interface LasHeader {
  versionMajor: number;
  versionMinor: number;
  headerSize: number;
  pointDataOffset: number;
  vlrCount: number;
  pointFormat: number;
  pointRecordLength: number;
  pointCount: number | null;
  scale: { x: number; y: number; z: number };
  offset: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
  min: { x: number; y: number; z: number };
  systemIdentifier: string;
  generatingSoftware: string;
  wktHeaderBit: boolean;
}

const VLR_HEADER_SIZE = 54;

export function isLasMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 4 &&
    bytes[0] === 0x4c && bytes[1] === 0x41 && bytes[2] === 0x53 && bytes[3] === 0x46; // "LASF"
}

function text(bytes: Uint8Array, start: number, len: number): string {
  let out = "";
  for (let i = 0; i < len; i++) {
    const b = bytes[start + i];
    if (b === 0) break;
    out += String.fromCharCode(b);
  }
  return out.trim();
}

function vec3(bytes: DataView, at: number): { x: number; y: number; z: number } {
  return { x: bytes.getFloat64(at, true), y: bytes.getFloat64(at + 8, true), z: bytes.getFloat64(at + 16, true) };
}

/** Parses a LAS public header block (first ≥ 375 bytes of the file). */
export function parseLasHeader(bytes: Uint8Array): LasHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const versionMajor = bytes[24];
  const versionMinor = bytes[25];
  const headerSize = view.getUint16(94, true);
  const pointDataOffset = view.getUint32(96, true);
  const vlrCount = view.getUint32(100, true);
  const pointFormat = bytes[104];
  const pointRecordLength = view.getUint16(105, true);
  const legacyCount = view.getUint32(107, true);
  return {
    versionMajor,
    versionMinor,
    headerSize,
    pointDataOffset,
    vlrCount,
    pointFormat,
    pointRecordLength,
    pointCount: legacyCount,
    scale: vec3(view, 131),
    offset: vec3(view, 155),
    max: vec3(view, 179),
    min: vec3(view, 203),
    systemIdentifier: text(bytes, 26, 32),
    generatingSoftware: text(bytes, 58, 32),
    wktHeaderBit: (view.getUint16(6, true) & 0x10) !== 0, // global encoding bit 4 = WKT CRS
  };
}

export async function validateLas(source: ByteSource, options: ValidateOptions = {}): Promise<ValidationReport> {
  const { totalSize } = source;
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const details: Record<string, string | number | boolean | null> = {};

  if (totalSize === 0) {
    return finishReport({
      format: "las", verdict: "invalid",
      errors: [{ code: "empty_file", message: "file is empty (0 bytes)" }],
      warnings, point_count: null, bounding_box: null, checked_bytes: 0, details,
    });
  }

  const head = await source.readChunk(0, Math.min(totalSize, 375));
  if (!isLasMagic(head)) {
    return finishReport({
      format: "las", verdict: "invalid",
      errors: [{ code: "parse_error", message: 'not a LAS file (missing "LASF" signature)' }],
      warnings, point_count: null, bounding_box: null, checked_bytes: head.length, details,
    });
  }
  const header = parseLasHeader(head);
  details.las_version = `1.${header.versionMinor}`;
  details.point_format = header.pointFormat;
  details.point_record_length = header.pointRecordLength;
  details.generating_software = header.generatingSoftware || null;
  details.system_identifier = header.systemIdentifier || null;

  if (header.versionMajor !== 1 || header.versionMinor > 4) {
    return finishReport({
      format: "las", verdict: "unsupported",
      errors: [{ code: "unsupported_variant", message: `LAS version 1.${header.versionMinor} is not supported (1.0–1.4 only)` }],
      warnings, point_count: null, bounding_box: null, checked_bytes: head.length, details,
    });
  }
  if (header.pointFormat > 10) {
    return finishReport({
      format: "las", verdict: "unsupported",
      errors: [{ code: "unsupported_variant", message: `point format ${header.pointFormat} is not defined by LAS 1.0–1.4` }],
      warnings, point_count: null, bounding_box: null, checked_bytes: head.length, details,
    });
  }
  if (header.scale.x === 0 || header.scale.y === 0 || header.scale.z === 0) {
    return finishReport({
      format: "las", verdict: "invalid",
      errors: [{ code: "parse_error", message: "coordinate scale factors must be non-zero" }],
      warnings, point_count: null, bounding_box: null, checked_bytes: head.length, details,
    });
  }
  details.scale_x = header.scale.x;
  details.scale_y = header.scale.y;
  details.scale_z = header.scale.z;
  details.offset_x = header.offset.x;
  details.offset_y = header.offset.y;
  details.offset_z = header.offset.z;

  const scaleKnown = header.scale.x === 0.001 && header.scale.y === 0.001 && header.scale.z === 0.001;
  details.scale_suggests_units = scaleKnown ? "millimetre_or_metre_scaled_grid (0.001 scale factor; unit not self-describing)" : "non-standard scale factor; unit unknown";

  warnings.push({
    code: "point_payload_not_decoded",
    message: "point payloads were not decoded; counts, scales and bounding box come from the file's own header and are not independently verified",
  });

  // ---- VLR scan (also detects compressed / LAZ and CRS records) ----
  let crsDescription: string | null = null;
  let compressed = false;
  if (header.vlrCount > 0) {
    let pos = header.headerSize;
    let remaining = header.vlrCount;
    const maxVlrBytes = Math.min(totalSize, header.headerSize + header.vlrCount * (VLR_HEADER_SIZE + 65535));
    while (remaining > 0 && pos + VLR_HEADER_SIZE <= totalSize) {
      if (options.shouldAbort?.()) {
        throw new PointCloudValidationError("cancelled", "validation cancelled by operator", "not_verified");
      }
      const vlr = await source.readChunk(pos, VLR_HEADER_SIZE);
      const view = new DataView(vlr.buffer, vlr.byteOffset, vlr.byteLength);
      const userId = text(vlr, 2, 16);
      const recordId = view.getUint16(18, true);
      const recordLength = view.getUint16(20, true);
      if (userId === "laszip encoded" || recordId === 22204) compressed = true;
      if (userId === "LASF_Projection" && recordId === 2112) crsDescription = "WKT CRS record present (LASF_Projection / 2112)";
      if (userId === "LASF_Projection" && recordId === 2111) crsDescription = crsDescription ?? "GeoTIFF keys CRS record present (LASF_Projection / 2111)";
      pos += VLR_HEADER_SIZE + recordLength;
      remaining--;
      if (pos > maxVlrBytes) break;
    }
    if (remaining > 0) {
      errors.push({ code: "parse_error", message: "VLR section is truncated — the file is incomplete or corrupt" });
    }
  }
  details.crs = crsDescription;
  if (!crsDescription && !header.wktHeaderBit) {
    warnings.push({
      code: "crs_absent",
      message: "no CRS metadata found; coordinates are project-local and are never georeferenced by this importer",
    });
  }
  if (header.wktHeaderBit && !crsDescription) {
    details.crs = "WKT flag set in header but no WKT VLR found";
  }

  // LAZ: compressed payload, unsupported on device. (Filename-based `.laz`
  // rejection happens earlier in the import service; here we catch LAS-signed
  // files that carry a laszip VLR.)
  if (compressed) {
    return finishReport({
      format: "laz", verdict: "unsupported",
      errors: [{ code: "unsupported_variant", message: "compressed LAS (laszip / LAZ) requires a decompressor that is not available on this device; convert to PLY or uncompressed LAS on a workstation first" }],
      warnings, point_count: null, bounding_box: null, checked_bytes: totalSize, details,
    });
  }

  // ---- structural completeness ----
  const expectedEnd = header.pointDataOffset + (header.pointCount ?? 0) * header.pointRecordLength;
  if (header.pointCount !== null && totalSize < expectedEnd) {
    return finishReport({
      format: "las", verdict: "incomplete",
      errors: [{ code: "parse_error", message: `truncated point payload: file ends at ${totalSize} bytes but header implies ${expectedEnd}` }],
      warnings, point_count: null,
      bounding_box: isFiniteBox(header) ? { min: header.min, max: header.max } : null,
      checked_bytes: totalSize, details,
    });
  }
  let pointCount: number | null = header.pointCount;
  if (pointCount === 0 && header.versionMinor >= 4) {
    pointCount = null;
    warnings.push({
      code: "point_count_in_evlr",
      message: "LAS 1.4 legacy point count is 0; the authoritative count lives in an EVLR this validator does not read",
    });
  } else if (pointCount === 0) {
    return finishReport({
      format: "las", verdict: "invalid",
      errors: [{ code: "empty_cloud", message: "header declares 0 point records — the point cloud is empty" }],
      warnings, point_count: 0, bounding_box: null, checked_bytes: head.length, details,
    });
  }

  return finishReport({
    format: "las",
    verdict: undefined,
    errors, warnings,
    point_count: pointCount,
    bounding_box: isFiniteBox(header) ? { min: header.min, max: header.max } : null,
    checked_bytes: totalSize,
    details,
  });
}

function isFiniteBox(header: LasHeader): boolean {
  const { min, max } = header;
  return [min.x, min.y, min.z, max.x, max.y, max.z].every(Number.isFinite);
}
