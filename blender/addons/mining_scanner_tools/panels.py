# Panels for the Mining Scanner Tools add-on.
#
# Every panel reads only what was actually loaded from a project metadata
# file or an imported point cloud. An unset field shows a dash, never a
# guess.

import bpy


class MiningScannerProjectGroup(bpy.types.PropertyGroup):
    """Holds the project metadata loaded from a .miningscan.json file."""

    project_id: bpy.props.StringProperty(name="Project ID", default="")
    name: bpy.props.StringProperty(name="Name", default="")
    site_name: bpy.props.StringProperty(name="Site", default="")
    status: bpy.props.StringProperty(name="Status", default="")
    created_at: bpy.props.StringProperty(name="Created", default="")
    updated_at: bpy.props.StringProperty(name="Updated", default="")
    loaded: bpy.props.BoolProperty(name="Loaded", default=False)
    source_path: bpy.props.StringProperty(name="Source file", default="")


class MINING_SCANNER_PT_main(bpy.types.Panel):
    bl_label = "Mining Scanner"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Mining Scanner"

    def draw(self, context):
        layout = self.layout
        col = layout.column()
        col.label(text="Point-cloud import (PLY): available", icon="CHECKMARK")
        col.label(text="Mesh analysis: not implemented yet", icon="ERROR")
        col.label(text="Point-cloud processing: not implemented yet", icon="ERROR")


class MINING_SCANNER_PT_project_info(bpy.types.Panel):
    bl_label = "Project Information"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Mining Scanner"
    bl_options = {"DEFAULT_CLOSED"}

    def draw(self, context):
        project = context.scene.mining_scanner_project
        layout = self.layout

        if not project.loaded:
            layout.label(text="No project loaded", icon="QUESTION")
            layout.operator("mining_scanner.load_project", icon="FILE_FOLDER")
            return

        layout.label(text=f"ID: {project.project_id}")
        layout.label(text=f"Name: {project.name or '-'}")
        layout.label(text=f"Site: {project.site_name or '-'}")
        layout.label(text=f"Status: {project.status or '-'}")
        layout.label(text=f"Created: {project.created_at or '-'}")
        layout.label(text=f"Updated: {project.updated_at or '-'}")
        layout.separator()
        layout.label(text=f"Source: {project.source_path}", icon="FILE")


class MINING_SCANNER_PT_import(bpy.types.Panel):
    bl_label = "Point-Cloud Import"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Mining Scanner"

    def draw(self, context):
        layout = self.layout
        col = layout.column(align=True)
        col.operator("mining_scanner.import_pointcloud", icon="IMPORT")
        col.label(text="PLY (ascii / binary little-endian)", icon="DOT")
        col.label(text="Coordinates are imported exactly as stored", icon="INFO")

        obj = context.active_object
        if obj and obj.get("mining_scanner_asset_id"):
            layout.separator()
            layout.label(text="Imported asset provenance", icon="DOCUMENT")
            layout.label(text=f"Asset: {obj['mining_scanner_asset_id'] or '-'}")
            layout.label(text=f"Units: {obj.get('mining_scanner_units', 'unit_unknown')}")
            layout.label(text=f"Scale: {obj.get('mining_scanner_scale_status', 'UNKNOWN')}")


class MINING_SCANNER_PT_processing(bpy.types.Panel):
    bl_label = "Processing (future)"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Mining Scanner"
    bl_options = {"DEFAULT_CLOSED"}

    def draw(self, context):
        layout = self.layout
        col = layout.column(align=True)
        col.operator("mining_scanner.analyze_mesh", icon="MESH_DATA")
        col.label(text="Mesh analysis reports: not implemented yet", icon="ERROR")


CLASSES = (
    MiningScannerProjectGroup,
    MINING_SCANNER_PT_main,
    MINING_SCANNER_PT_project_info,
    MINING_SCANNER_PT_import,
    MINING_SCANNER_PT_processing,
)
