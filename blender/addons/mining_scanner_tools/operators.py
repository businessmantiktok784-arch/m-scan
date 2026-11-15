# Operators for the Mining Scanner Tools add-on.
#
# Real work (Stage 3.1): load_project (project metadata) and
# import_pointcloud (genuine PLY import — ascii + binary_little_endian,
# streamed, coordinates exactly as stored, optional sidecar provenance).
#
# analyze_mesh remains an honest placeholder: it does nothing and says so.
# Distinct outcomes are reported distinctly: imported / imported with
# warnings / unsupported / failed. Nothing is ever invented.

import json

import bpy

from .core.project_meta import parse_project_metadata, ProjectMetadataError
from .core import ply_parser
from .core import asset_meta


class MINING_SCANNER_OT_load_project(bpy.types.Operator):
    """Load a Mining Scanner project metadata file (.miningscan.json)"""

    bl_idname = "mining_scanner.load_project"
    bl_label = "Load Project Metadata"

    filepath: bpy.props.StringProperty(subtype="FILE_PATH")  # noqa: A003

    def execute(self, context):
        try:
            with open(self.filepath, "r", encoding="utf-8") as handle:
                raw = json.load(handle)
            meta = parse_project_metadata(raw)
        except FileNotFoundError:
            self.report({"ERROR"}, "File not found")
            return {"CANCELLED"}
        except (json.JSONDecodeError, ProjectMetadataError) as err:
            self.report({"ERROR"}, f"Invalid project file: {err}")
            return {"CANCELLED"}

        project = context.scene.mining_scanner_project
        project.project_id = meta["project_id"]
        project.name = meta["name"]
        project.site_name = meta.get("site_name", "")
        project.status = meta.get("status", "")
        project.created_at = meta.get("created_at", "")
        project.updated_at = meta.get("updated_at", "")
        project.source_path = self.filepath
        project.loaded = True

        self.report({"INFO"}, f"Loaded project {meta['project_id']}")
        return {"FINISHED"}

    def invoke(self, context, _event):
        context.window_manager.fileselect_add(self)
        return {"RUNNING_MODAL"}


class MINING_SCANNER_OT_import_pointcloud(bpy.types.Operator):
    """Import a PLY point cloud exported or managed by Mining Scanner.

    Coordinates are imported exactly as stored: no unit conversion, no axis
    remap, no scale assumption. Provenance (units, scale status, checksum,
    CRS) is read from the Mining Scanner sidecar when the file lives inside
    an app-managed asset directory.
    """

    bl_idname = "mining_scanner.import_pointcloud"
    bl_label = "Import Point Cloud (PLY)"

    filepath: bpy.props.StringProperty(subtype="FILE_PATH")  # noqa: A003

    def execute(self, context):
        path = self.filepath
        if not path.lower().endswith(".ply"):
            # Distinct verdicts are never conflated: a wrong file type is
            # UNSUPPORTED, not a generic failure.
            self.report(
                {"ERROR"},
                "Unsupported file: this importer reads PLY (ascii / binary_little_endian) only. "
                "Convert XYZ/LAS to PLY first; LAZ is not supported.",
            )
            return {"CANCELLED"}

        try:
            data = ply_parser.read_ply(path)
        except ply_parser.PlyError as err:
            if err.code in ("unsupported_variant",):
                self.report({"ERROR"}, f"Unsupported PLY: {err}")
            else:
                self.report({"ERROR"}, f"PLY import failed ({err.code}): {err}")
            return {"CANCELLED"}
        except OSError as err:
            self.report({"ERROR"}, f"PLY import failed: {err}")
            return {"CANCELLED"}

        if data.vertex_count == 0:
            self.report({"ERROR"}, "PLY contains 0 decoded vertices — nothing imported")
            return {"CANCELLED"}

        mesh = bpy.data.meshes.new(_object_name(path))
        vertex_count = data.vertex_count
        flat = []
        for triple in data.coordinates:
            flat.extend(triple)
        mesh.vertices.add(vertex_count)
        mesh.vertices.foreach_set("co", flat)
        mesh.update()
        mesh.validate(verbose=False)

        warnings = list(data.warnings)

        if data.colors is not None:
            try:
                attr = mesh.color_attributes.new(
                    name="source_color", type="BYTE_COLOR", domain="POINT"
                )
                flat_colors = []
                for triple in data.colors:
                    # Values stored as 0-255 u8 are normalised; f32 values
                    # pass through unchanged. The sidecar records which.
                    flat_colors.extend(self._as_float_color(v) for v in triple)
                attr.data.foreach_set("color", flat_colors)
            except (RuntimeError, ValueError) as err:
                warnings.append(f"colour attribute could not be imported: {err}")

        obj = bpy.data.objects.new(mesh.name, mesh)
        context.collection.objects.link(obj)

        # Provenance from the sidecar (facts only; never defaults).
        sidecar = asset_meta.find_sidecar(path)
        meta = asset_meta.load_asset_meta(sidecar) if sidecar else None
        validation = asset_meta.load_validation_report(sidecar) if sidecar else None
        if meta is None:
            warnings.append("no Mining Scanner sidecar found — units, scale and CRS are NOT established by this import")
        obj["mining_scanner_asset_id"] = meta.get("asset_id", "") if meta else ""
        obj["mining_scanner_units"] = meta.get("coordinate_units", "unit_unknown") if meta else "unit_unknown"
        obj["mining_scanner_scale_status"] = meta.get("scale_status", "UNKNOWN") if meta else "UNKNOWN"

        for line in asset_meta.provenance_lines(meta, validation):
            print(f"[Mining Scanner] {line}")

        if warnings:
            self.report(
                {"WARNING"},
                f"Imported {vertex_count} points with {len(warnings)} warning(s): {warnings[0]}",
            )
        else:
            self.report({"INFO"}, f"Imported {vertex_count} points (coordinates stored as-is)")
        return {"FINISHED"}

    @staticmethod
    def _as_float_color(value):
        # u8 colours (0-255) are normalised to 0-1; f32 colours pass through.
        # The distinction is recorded from the file's own property type by the
        # parser; here we normalise only when the value range implies u8.
        value = float(value)
        if value > 1.0:
            return value / 255.0
        return value

    def invoke(self, context, _event):
        context.window_manager.fileselect_add(self)
        return {"RUNNING_MODAL"}


class MINING_SCANNER_OT_analyze_mesh(bpy.types.Operator):
    """Mesh analysis — not implemented yet"""

    bl_idname = "mining_scanner.analyze_mesh"
    bl_label = "Analyze Mesh (not implemented)"

    def execute(self, context):
        self.report(
            {"WARNING"},
            "Mesh analysis is not implemented yet. No engineering results are produced.",
        )
        return {"CANCELLED"}


def _object_name(path):
    import os

    base = os.path.splitext(os.path.basename(path))[0]
    return base or "pointcloud"


CLASSES = (
    MINING_SCANNER_OT_load_project,
    MINING_SCANNER_OT_import_pointcloud,
    MINING_SCANNER_OT_analyze_mesh,
)
