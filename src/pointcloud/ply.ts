/**
 * PLY validator — genuine header parsing plus streamed vertex checking.
 *
 * Supported variants (explicit, everything else is rejected with a clear
 * error rather than guessed at):
 * - `format ascii 1.0`
 * - `format binary_little_endian 1.0`
 * - vertex element first, scalar (non-list) properties, containing x, y, z
 * - optional additional elements after vertex (faces, …) are recorded from
 *   the header but their payloads are NOT decoded — always reported as a
 *   warning, never silently ignored.
 *
 * Rejected: binary_big_endian (unsupported), headers without a vertex
 * element, vertices without x/y/z, list properties inside the vertex
 * element, truncated payloads (incomplete), non-finite coordinates,
 * zero-vertex clouds (empty_cloud).
 *
 * Memory: the file is read in chunks through a `ByteSource`; only one chunk
 * plus one carry record is held at any time. Nothing is loaded whole.
 */

import {
  finishReport,
  PointCloudValidationError,
  resolveVerdict,
  type ByteSource,
  type BoundingBox,
  type ValidateOptions,
  type ValidationIssue,
  type ValidationReport,
} from "./validate";

type PlyScalarType =
  | "char" | "uchar" | "short" | "ushort" | "int" | "uint" | "float" | "double";

const ALIASES: Record<string, PlyScalarType> = {
  char: "char", int8: "char",
  uchar: "uchar", uint8: "uchar",
  short: "short", int16: "short",
  ushort: "ushort", uint16: "ushort",
  int: "int", int32: "int",
  uint: "uint", uint32: "uint",
  float: "float", float32: "float",
  double: "double", float64: "double",
};

const SIZE_OF: Record<PlyScalarType, number> = {
  char: 1, uchar: 1, short: 2, ushort: 2, int: 4, uint: 4, float: 4, double: 8,
};

export interface PlyListProperty {
  kind: "list";
  name: string;
  countType: PlyScalarType;
  itemType: PlyScalarType;
}

export interface PlyScalarProperty {
  kind: "scalar";
  name: string;
  type: PlyScalarType;
}

export type PlyProperty = PlyScalarProperty | PlyListProperty;

export interface PlyElement {
  name: string;
  count: number;
  properties: PlyProperty[];
}

export interface PlyHeader {
  format: "ascii" | "binary_little_endian";
  elements: PlyElement[];
  vertex: PlyElement;
  /** Byte length of the header including the end_header terminator line. */
  headerByteLength: number;
}

export function isPlyMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0x70 && bytes[1] === 0x6c && bytes[2] === 0x79; // "ply"
}

function decodeLatin1(bytes: Uint8Array): string {
  let out = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return out;
}

function parseScalarType(token: string, lineNo: number): PlyScalarType {
  const t = ALIASES[token.toLowerCase()];
  if (!t) {
    throw new PointCloudValidationError(
      "unsupported_variant",
      `PLY line ${lineNo}: unsupported property type "${token}"`,
      "unsupported",
    );
  }
  return t;
}

/** Parses a PLY header from the start of `bytes` (must contain end_header). */
export function parsePlyHeader(bytes: Uint8Array): PlyHeader {
  const text = decodeLatin1(bytes);
  const endMarker = text.indexOf("end_header");
  if (endMarker < 0) {
    throw new PointCloudValidationError(
      "parse_error",
      "PLY header is not terminated by an end_header line",
    );
  }
  let headerEnd = text.indexOf("\n", endMarker);
  if (headerEnd < 0) {
    throw new PointCloudValidationError("parse_error", "PLY header end_header line is not newline-terminated");
  }
  headerEnd += 1;

  const lines = text.slice(0, headerEnd).split(/\r?\n/);
  if (!lines[0] || !lines[0].startsWith("ply")) {
    throw new PointCloudValidationError("parse_error", "not a PLY file (missing 'ply' magic line)");
  }

  const formatLine = lines.find((l) => l.startsWith("format"));
  if (!formatLine) {
    throw new PointCloudValidationError("parse_error", "PLY header has no format line");
  }
  const formatParts = formatLine.trim().split(/\s+/);
  if (formatParts.length !== 3 || formatParts[2] !== "1.0") {
    throw new PointCloudValidationError("parse_error", `unsupported PLY format line: "${formatLine}"`);
  }
  let format: PlyHeader["format"];
  if (formatParts[1] === "ascii") format = "ascii";
  else if (formatParts[1] === "binary_little_endian") format = "binary_little_endian";
  else if (formatParts[1] === "binary_big_endian") {
    throw new PointCloudValidationError(
      "unsupported_variant",
      "binary_big_endian PLY is not supported by this importer",
      "unsupported",
    );
  } else {
    throw new PointCloudValidationError("parse_error", `unknown PLY format "${formatParts[1]}"`);
  }

  const elements: PlyElement[] = [];
  let current: PlyElement | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("comment") || line.startsWith("obj_info")) continue;
    const tokens = line.split(/\s+/);
    if (tokens[0] === "format" || tokens[0] === "ply" || tokens[0] === "end_header") continue;
    if (tokens[0] === "element") {
      if (tokens.length !== 3) {
        throw new PointCloudValidationError("parse_error", `PLY line ${i + 1}: malformed element declaration`);
      }
      const count = Number(tokens[2]);
      if (!Number.isInteger(count) || count < 0) {
        throw new PointCloudValidationError("parse_error", `PLY line ${i + 1}: element count must be a non-negative integer`);
      }
      current = { name: tokens[1], count, properties: [] };
      elements.push(current);
    } else if (tokens[0] === "property") {
      if (!current) {
        throw new PointCloudValidationError("parse_error", `PLY line ${i + 1}: property before any element`);
      }
      if (tokens[1] === "list") {
        if (tokens.length !== 5) {
          throw new PointCloudValidationError("parse_error", `PLY line ${i + 1}: malformed list property`);
        }
        current.properties.push({
          kind: "list",
          name: tokens[4],
          countType: parseScalarType(tokens[2], i + 1),
          itemType: parseScalarType(tokens[3], i + 1),
        });
      } else {
        if (tokens.length !== 3) {
          throw new PointCloudValidationError("parse_error", `PLY line ${i + 1}: malformed property`);
        }
        current.properties.push({ kind: "scalar", name: tokens[2], type: parseScalarType(tokens[1], i + 1) });
      }
    } else {
      throw new PointCloudValidationError("parse_error", `PLY line ${i + 1}: unrecognized keyword "${tokens[0]}"`);
    }
  }

  const vertex = elements.find((e) => e.name === "vertex");
  if (!vertex) {
    throw new PointCloudValidationError(
      "parse_error",
      "PLY has no vertex element — nothing to import",
    );
  }
  if (vertex.properties.some((p) => p.kind === "list")) {
    throw new PointCloudValidationError(
      "unsupported_variant",
      "list properties inside the vertex element are not supported",
      "unsupported",
    );
  }
  const names = vertex.properties.map((p) => p.name);
  for (const axis of ["x", "y", "z"]) {
    if (!names.includes(axis)) {
      throw new PointCloudValidationError(
        "parse_error",
        `vertex element has no "${axis}" coordinate property`,
      );
    }
  }
  if (elements.length > 0 && elements[0].name !== "vertex") {
    throw new PointCloudValidationError(
      "unsupported_variant",
      `vertex element must come first (found "${elements[0].name}" before it)`,
      "unsupported",
    );
  }
  return { format, elements, vertex, headerByteLength: headerEnd };
}

function readerFor(type: PlyScalarType): (view: DataView, offset: number) => number {
  switch (type) {
    case "char": return (v, o) => v.getInt8(o);
    case "uchar": return (v, o) => v.getUint8(o);
    case "short": return (v, o) => v.getInt16(o, true);
    case "ushort": return (v, o) => v.getUint16(o, true);
    case "int": return (v, o) => v.getInt32(o, true);
    case "uint": return (v, o) => v.getUint32(o, true);
    case "float": return (v, o) => v.getFloat32(o, true);
    case "double": return (v, o) => v.getFloat64(o, true);
  }
}

interface Accumulator {
  count: number;
  bbox: BoundingBox;
  finiteFailures: number;
  firstBadVertex: { index: number; reason: string } | null;
}

function newAccumulator(): Accumulator {
  return {
    count: 0,
    bbox: { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } },
    finiteFailures: 0,
    firstBadVertex: null,
  };
}

function accumulate(acc: Accumulator, index: number, x: number, y: number, z: number): void {
  acc.count++;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    acc.finiteFailures++;
    if (!acc.firstBadVertex) acc.firstBadVertex = { index, reason: "non-finite coordinate" };
    return;
  }
  acc.bbox.min.x = Math.min(acc.bbox.min.x, x);
  acc.bbox.min.y = Math.min(acc.bbox.min.y, y);
  acc.bbox.min.z = Math.min(acc.bbox.min.z, z);
  acc.bbox.max.x = Math.max(acc.bbox.max.x, x);
  acc.bbox.max.y = Math.max(acc.bbox.max.y, y);
  acc.bbox.max.z = Math.max(acc.bbox.max.z, z);
}

function isNiceBbox(bbox: BoundingBox): boolean {
  return Number.isFinite(bbox.min.x) && Number.isFinite(bbox.max.x);
}

/** Validates a PLY file end-to-end by streaming it through `source`. */
export async function validatePly(source: ByteSource, options: ValidateOptions = {}): Promise<ValidationReport> {
  const { totalSize } = source;
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const chunkSize = options.chunkSize ?? 1 << 20;
  const maxBytes = options.maxBytes;

  if (totalSize === 0) {
    return finishReport({
      format: "ply", verdict: "invalid",
      errors: [{ code: "empty_file", message: "file is empty (0 bytes)" }],
      warnings, point_count: null, bounding_box: null,
      checked_bytes: 0, details: {},
    });
  }
  if (maxBytes !== undefined && totalSize > maxBytes) {
    throw new PointCloudValidationError(
      "file_too_large",
      `file is ${totalSize} bytes, above the configured import limit of ${maxBytes} bytes`,
      "unsupported",
    );
  }

  // ---- header ----
  // The header window must always be large enough to contain a full PLY
  // header, even when the caller asked for 1-byte chunks.
  const headerWindow = await source.readChunk(0, Math.min(totalSize, Math.max(chunkSize, 4096)));
  if (!isPlyMagic(headerWindow)) {
    return finishReport({
      format: "ply", verdict: "invalid",
      errors: [{ code: "parse_error", message: "not a PLY file (missing 'ply' magic)" }],
      warnings, point_count: null, bounding_box: null,
      checked_bytes: headerWindow.length, details: {},
    });
  }
  let header: PlyHeader;
  try {
    header = parsePlyHeader(headerWindow);
  } catch (err) {
    if (err instanceof PointCloudValidationError) {
      return finishReport({
        format: "ply", verdict: err.verdict,
        errors: [{ code: err.code, message: err.message }],
        warnings, point_count: null, bounding_box: null,
        checked_bytes: headerWindow.length, details: {},
      });
    }
    throw err;
  }

  const vertexProps = header.vertex.properties as PlyScalarProperty[];
  const coordIdx = ["x", "y", "z"].map((a) => vertexProps.findIndex((p) => p.name === a));
  const colorIdx = ["red", "green", "blue"].map((a) => vertexProps.findIndex((p) => p.name === a));
  const hasColors = colorIdx.every((i) => i >= 0);
  const normalIdx = ["nx", "ny", "nz"].map((a) => vertexProps.findIndex((p) => p.name === a));
  const hasNormals = normalIdx.every((i) => i >= 0);
  if (hasColors) warnings.push({ code: "colors_unverified_range", message: "colour values were detected but their range interpretation is not verified" });
  const faceElement = header.elements.find((e) => e.name === "face");
  if (faceElement && faceElement.count > 0) {
    warnings.push({ code: "face_data_not_decoded", message: `face element declares ${faceElement.count} faces; face payloads were not decoded or verified` });
  }
  const trailing = header.elements.slice(1).filter((e) => e.count > 0);
  if (trailing.length > 0) {
    warnings.push({ code: "trailing_elements_not_decoded", message: `element data after the vertices (${trailing.map((e) => e.name).join(", ")}) was not decoded or verified` });
  }

  const declaredCount = header.vertex.count;
  if (declaredCount === 0) {
    return finishReport({
      format: "ply", verdict: "invalid",
      errors: [{ code: "empty_cloud", message: "vertex element declares 0 vertices — the point cloud is empty" }],
      warnings, point_count: 0, bounding_box: null,
      checked_bytes: header.headerByteLength,
      details: { encoding: header.format, vertex_properties: vertexProps.map((p) => p.name).join(","), has_colors: hasColors, has_normals: hasNormals },
    });
  }

  const acc = newAccumulator();
  let bytesExamined = header.headerByteLength;

  if (header.format === "ascii") {
    // ---- streamed ASCII scan ----
    const decoder = new TextDecoder("utf-8", { fatal: false });
    let carry = "";
    let offset = header.headerByteLength;
    let done = false;
    while (!done && offset < totalSize) {
      if (options.shouldAbort?.()) throw new PointCloudValidationError("cancelled", "validation cancelled by operator", "not_verified");
      const chunk = await source.readChunk(offset, Math.min(chunkSize, totalSize - offset));
      offset += chunk.length;
      bytesExamined = offset;
      const text = carry + decoder.decode(chunk, { stream: offset < totalSize });
      const lines = text.split(/\r?\n/);
      carry = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("comment")) continue;
        if (acc.count >= declaredCount) break; // remaining lines: trailing elements, skipped
        const tokens = trimmed.split(/\s+/);
        const needed = Math.max(...coordIdx) + 1;
        if (tokens.length < needed) {
          if (!acc.firstBadVertex) acc.firstBadVertex = { index: acc.count, reason: `vertex line has ${tokens.length} values, expected at least ${needed}` };
        }
        const x = Number(tokens[coordIdx[0]]);
        const y = Number(tokens[coordIdx[1]]);
        const z = Number(tokens[coordIdx[2]]);
        accumulate(acc, acc.count, x, y, z);
        if (options.onProgress && declaredCount > 0) options.onProgress(acc.count / declaredCount);
        if (acc.count >= declaredCount) { done = true; break; }
      }
    }
    if (acc.count < declaredCount) {
      errors.push({ code: "parse_error", message: `file ended after ${acc.count} of ${declaredCount} declared vertices`, });
    }
    if (acc.firstBadVertex) {
      errors.push({ code: "parse_error", message: `vertex ${acc.firstBadVertex.index}: ${acc.firstBadVertex.reason}` });
    }
    if (acc.finiteFailures > 0) {
      errors.push({ code: "parse_error", message: `${acc.finiteFailures} vertices have non-finite coordinates (NaN/Infinity) — the cloud is corrupt` });
    }
  } else {
    // ---- streamed binary scan ----
    const readers = coordIdx.map((i) => ({ read: readerFor(vertexProps[i].type), offset: vertexProps.slice(0, i).reduce((s, p) => s + SIZE_OF[p.type], 0) }));
    const recordSize = vertexProps.reduce((s, p) => s + SIZE_OF[p.type], 0);
    const expectedSpan = header.headerByteLength + declaredCount * recordSize;
    if (totalSize < expectedSpan) {
      return finishReport({
        format: "ply", verdict: "incomplete",
        errors: [{ code: "parse_error", message: `truncated vertex data: file holds ${totalSize - header.headerByteLength} payload bytes, ${declaredCount * recordSize} declared` }],
        warnings, point_count: null, bounding_box: null,
        checked_bytes: totalSize, details: { encoding: "binary_little_endian", vertex_properties: vertexProps.map((p) => p.name).join(","), has_colors: hasColors, has_normals: hasNormals },
      });
    }

    let carryBuf: Uint8Array | null = null;
    let carryLen = 0;
    let fileOffset = header.headerByteLength;
    bytesExamined = fileOffset;
    while (acc.count < declaredCount && fileOffset < expectedSpan) {
      if (options.shouldAbort?.()) throw new PointCloudValidationError("cancelled", "validation cancelled by operator", "not_verified");
      const want = Math.min(chunkSize, expectedSpan - fileOffset);
      const chunk = await source.readChunk(fileOffset, want);
      fileOffset += chunk.length;
      bytesExamined = fileOffset;
      const combined: Uint8Array = carryBuf && carryLen > 0
        ? (() => { const c = new Uint8Array(carryLen + chunk.length); c.set(carryBuf.subarray(0, carryLen)); c.set(chunk, carryLen); return c; })()
        : chunk;
      let pos = 0;
      const view = new DataView(combined.buffer, combined.byteOffset, combined.byteLength);
      while (pos + recordSize <= combined.length && acc.count < declaredCount) {
        const base = pos;
        const x = readers[0].read(view, base + readers[0].offset);
        const y = readers[1].read(view, base + readers[1].offset);
        const z = readers[2].read(view, base + readers[2].offset);
        accumulate(acc, acc.count, x, y, z);
        pos += recordSize;
      }
      carryBuf = combined;
      carryLen = combined.length - pos;
      // Keep the carry for the next iteration without copying twice.
      if (carryLen > 0 && pos > 0) {
        carryBuf = combined.slice(pos);
      }
      if (options.onProgress) options.onProgress(Math.min(1, (fileOffset - header.headerByteLength) / (declaredCount * recordSize)));
    }
    if (acc.firstBadVertex) {
      errors.push({ code: "parse_error", message: `vertex ${acc.firstBadVertex.index}: ${acc.firstBadVertex.reason}` });
    }
    if (acc.finiteFailures > 0) {
      errors.push({ code: "parse_error", message: `${acc.finiteFailures} vertices have non-finite coordinates (NaN/Infinity) — the cloud is corrupt` });
    }
  }

  const verdict = resolveVerdict(errors, warnings);
  return finishReport({
    format: "ply",
    verdict: errors.length > 0 ? "invalid" : verdict,
    errors, warnings,
    point_count: acc.count,
    bounding_box: isNiceBbox(acc.bbox) ? acc.bbox : null,
    checked_bytes: bytesExamined,
    details: {
      encoding: header.format,
      vertex_properties: vertexProps.map((p) => p.name).join(","),
      has_colors: hasColors,
      has_normals: hasNormals,
      declared_vertex_count: declaredCount,
      face_count: faceElement ? faceElement.count : null,
      trailing_elements: header.elements.slice(1).map((e) => `${e.name}:${e.count}`).join(",") || null,
    },
  });
}
