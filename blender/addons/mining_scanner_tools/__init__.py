# Mining Scanner Tools — Blender add-on.
#
# Blender is a desktop inspection and processing tool for scan assets the
# mobile app produces or imports. Nothing here runs on the phone.
#
# Stage 3.1 scope: project-information panel, load/read of a Mining Scanner
# project metadata file, and GENUINE PLY point-cloud import (ascii +
# binary little-endian, streamed, coordinates exactly as stored, optional
# sidecar provenance). Mesh analysis and point-cloud processing remain
# placeholders that report their unavailability honestly.

bl_info = {
    "name": "Mining Scanner Tools",
    "author": "Mining Scanner project",
    "version": (0, 2, 0),
    "blender": (4, 2, 0),
    "location": "3D Viewport → sidebar (N) → Mining Scanner",
    "description": "Inspect Underground Mining Scanner projects and scan assets",
    "doc_url": "",
    "category": "Import-Export",
}

import bpy  # noqa: E402  (only imported inside Blender)

from . import operators, panels  # noqa: E402

_CLASSES = panels.CLASSES + operators.CLASSES


def register() -> None:
    for cls in _CLASSES:
        bpy.utils.register_class(cls)
    # Scene storage for the loaded project metadata, so panels can read it.
    # Registered only inside register(), after the PropertyGroup exists.
    bpy.types.Scene.mining_scanner_project = bpy.props.PointerProperty(
        type=panels.MiningScannerProjectGroup
    )


def unregister() -> None:
    del bpy.types.Scene.mining_scanner_project
    for cls in reversed(_CLASSES):
        bpy.utils.unregister_class(cls)
