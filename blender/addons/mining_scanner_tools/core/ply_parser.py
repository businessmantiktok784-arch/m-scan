"""Pure PLY point-cloud parser for the Mining Scanner Blender add-on.

Stage 3.1: ascii and binary_little_endian PLY with x/y/z vertices.
Deliberately free of any `bpy` import so it stays unit-testable with the
stdlib only (the Python suite runs it against the same committed synthetic
fixtures the mobile validator uses).

Behaviour contract (mirrors the mobile validator in
mining-scanner/src/pointcloud/, same boundaries, same refusals):

- coordinates are returned EXACTLY as stored — no unit conversion, no axis
  remap, no scale assumption;
- vertex colours are preserved as stored values (u8 stays 0-255; the
  importer normalises, the parser never guesses a range);
- normals are ignored (a mesh of points needs none); extra vertex
  properties are read and skipped;
- face elements are never imported — a warning states face data was
  skipped, so nothing is silently dropped;
- big-endian binaries, vertex elements that are not the first element, and
  unknown property types are `unsupported_variant` — never misread;
- non-finite coordinates are `parse_error`, never silently kept;
- a truncated payload is `parse_error`, never a short silent read.
"""

import math
import struct

SCALAR_TYPES = {
    # PLY name → (struct little-endian format, bytes)
    "char": ("b", 1),
    "int8": ("b", 1),
    "uchar": ("B", 1),
    "uint8": ("B", 1),
    "short": ("h", 2),
    "int16": ("h", 2),
    "ushort": ("H", 2),
    "uint16": ("H", 2),
    "int": ("i", 4),
    "int32": ("i", 4),
    "uint": ("I", 4),
    "uint32": ("I", 4),
    "float": ("f", 4),
    "float32": ("f", 4),
    "double": ("d", 8),
    "float64": ("d", 8),
}

COORD_NAMES = ("x", "y", "z")
COLOR_NAMES = ("red", "green", "blue")


class PlyError(Exception):
    """PLY parse failure with a machine-readable `code`.

    Codes match the mobile import verdicts: `parse_error`,
    `unsupported_variant`, `empty_cloud`.
    """

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class PlyData:
    """Parsed PLY content: coordinates always; colours when present."""

    __slots__ = ("vertex_count", "coordinates", "colors", "warnings")

    def __init__(self, vertex_count, coordinates, colors, warnings):
        self.vertex_count = vertex_count
        self.coordinates = coordinates
        self.colors = colors
        self.warnings = warnings


class _Property:
    __slots__ = ("type_name", "name", "data_type", "count_type", "item_type")

    def __init__(self, type_name, name, data_type=None, count_type=None, item_type=None):
        self.type_name = type_name  # "scalar" or "list"
        self.name = name
        self.data_type = data_type  # PLY scalar type name (scalar only)
        self.count_type = count_type
        self.item_type = item_type


class _Element:
    __slots__ = ("name", "count", "properties")

    def __init__(self, name, count):
        self.name = name
        self.count = count
        self.properties = []


def _parse_header(handle):
    """Reads header lines up to `end_header`; returns (format, elements)."""
    magic = handle.readline().strip()
    if magic != b"ply":
        raise PlyError("parse_error", "not a PLY file (header does not start with 'ply')")

    fmt = None
    elements = []
    while True:
        raw = handle.readline()
        if not raw:
            raise PlyError("parse_error", "PLY header ended without 'end_header'")
        line = raw.decode("ascii", "strict").strip()
        if not line or line.startswith("comment"):
            continue
        tokens = line.split()
        keyword = tokens[0]
        if keyword == "format":
            if len(tokens) < 2:
                raise PlyError("parse_error", "malformed 'format' line")
            fmt = tokens[1]
        elif keyword == "element":
            if len(tokens) < 3:
                raise PlyError("parse_error", "malformed 'element' line")
            try:
                count = int(tokens[2])
                if count < 0:
                    raise ValueError
            except ValueError:
                raise PlyError("parse_error", f"malformed element count in: {line}")
            elements.append(_Element(tokens[1], count))
        elif keyword == "property":
            if not elements:
                raise PlyError("parse_error", "property before any element declaration")
            if tokens[1] == "list":
                if len(tokens) < 5:
                    raise PlyError("parse_error", f"malformed list property: {line}")
                elements[-1].properties.append(_Property("list", tokens[4], count_type=tokens[2], item_type=tokens[3]))
            else:
                if len(tokens) < 3:
                    raise PlyError("parse_error", f"malformed property: {line}")
                if tokens[1] not in SCALAR_TYPES:
                    raise PlyError("unsupported_variant", f"unsupported property type '{tokens[1]}'")
                elements[-1].properties.append(_Property("scalar", tokens[2], data_type=tokens[1]))
        elif keyword == "end_header":
            break
        # 'comment' and unknown informational lines are ignored; the strict
        # keywords above are the only ones this parser consumes.

    if fmt not in ("ascii", "binary_little_endian"):
        if fmt == "binary_big_endian":
            raise PlyError("unsupported_variant", "binary_big_endian PLY is not supported (little-endian only)")
        raise PlyError("unsupported_variant", f"unsupported PLY format: {fmt!r}")
    return fmt, elements


def _find_vertex(elements):
    if not any(el.name == "vertex" for el in elements):
        raise PlyError("parse_error", "the PLY declares no 'vertex' element — nothing to import")
    if elements[0].name != "vertex":
        raise PlyError(
            "unsupported_variant",
            "the 'vertex' element must be the first element in the file (same boundary as the mobile validator)",
        )
    vertex = elements[0]
    for other in elements[1:]:
        if other.name == "vertex":
            raise PlyError("parse_error", "multiple 'vertex' elements are not supported")
    return vertex


def _validate_vertex_properties(vertex):
    prop_names = [p.name for p in vertex.properties]
    for axis in COORD_NAMES:
        if axis not in prop_names:
            raise PlyError("parse_error", f"vertex element is missing the '{axis}' coordinate property")
    if any(p.type_name == "list" for p in vertex.properties):
        raise PlyError("unsupported_variant", "list properties inside the vertex element are not supported")
    has_colors = all(c in prop_names for c in COLOR_NAMES)
    return has_colors


def read_ply(path: str) -> PlyData:
    """Reads a PLY file and returns its points. Raises PlyError on refusal."""
    with open(path, "rb") as handle:
        fmt, elements = _parse_header(handle)
        vertex = _find_vertex(elements)
        has_colors = _validate_vertex_properties(vertex)

        if vertex.count == 0:
            raise PlyError("empty_cloud", "the PLY declares 0 vertices — nothing to import")

        if fmt == "ascii":
            return _read_ascii(handle, vertex, has_colors, elements)
        return _read_binary_little_endian(handle, vertex, has_colors, elements)


def _read_ascii(handle, vertex, has_colors, elements_after_vertex):
    prop_names = [p.name for p in vertex.properties]
    x_i, y_i, z_i = (prop_names.index(a) for a in COORD_NAMES)
    c_idx = [prop_names.index(c) for c in COLOR_NAMES] if has_colors else None
    width = len(prop_names)

    coordinates = []
    colors = [] if has_colors else None
    warnings = []

    def tokens():
        for raw in handle:
            line = raw.strip()
            if line:
                yield line.split()

    stream = tokens()
    try:
        for _ in range(vertex.count):
            row = next(stream)
            if len(row) < width:
                raise PlyError("parse_error", "ascii payload ends before all declared vertices were read")
            coordinates.append((float(row[x_i]), float(row[y_i]), float(row[z_i])))
            if has_colors:
                colors.append((float(row[c_idx[0]]), float(row[c_idx[1]]), float(row[c_idx[2]])))
        # Remaining elements (e.g. faces) are skipped line by line: each
        # ascii line carries exactly one element instance, lists included.
        for element in elements_after_vertex:
            if element.name == "face":
                warnings.append("face data present in the file was skipped (points are imported, faces never)")
            for _ in range(element.count):
                row = next(stream, None)
                if row is None:
                    break
    except StopIteration:
        raise PlyError("parse_error", "ascii payload ends before all declared elements were read")
    except ValueError:
        raise PlyError("parse_error", "ascii payload contains a value that is not a number")

    _check_finite(coordinates)
    return PlyData(len(coordinates), coordinates, colors, warnings)


def _read_binary_little_endian(handle, vertex, has_colors, elements):
    prop_names = [p.name for p in vertex.properties]
    formats = [SCALAR_TYPES[p.data_type][0] for p in vertex.properties]
    row_fmt = "<" + "".join(formats)
    row_size = struct.calcsize(row_fmt)
    x_i, y_i, z_i = (prop_names.index(a) for a in COORD_NAMES)
    c_idx = [prop_names.index(c) for c in COLOR_NAMES] if has_colors else None

    payload = handle.read()
    needed = vertex.count * row_size
    if len(payload) < needed:
        raise PlyError(
            "parse_error",
            f"binary payload ends early: header declares {vertex.count} vertices of {row_size} bytes each "
            f"({needed} bytes) but only {len(payload)} bytes follow the header",
        )

    coordinates = []
    colors = [] if has_colors else None
    for i in range(vertex.count):
        values = struct.unpack_from(row_fmt, payload, i * row_size)
        coordinates.append((float(values[x_i]), float(values[y_i]), float(values[z_i])))
        if has_colors:
            colors.append((float(values[c_idx[0]]), float(values[c_idx[1]]), float(values[c_idx[2]])))

    warnings = []
    if any(element.name == "face" for element in elements[1:]):
        warnings.append("face data present in the file was skipped (points are imported, faces never)")

    _check_finite(coordinates)
    return PlyData(len(coordinates), coordinates, colors, warnings)


def _check_finite(coordinates):
    for point in coordinates:
        if not all(math.isfinite(v) for v in point):
            raise PlyError("parse_error", f"non-finite coordinate encountered: {point!r} — the file is not a valid point cloud")
