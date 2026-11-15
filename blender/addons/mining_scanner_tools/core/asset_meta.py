"""Sidecar provenance reader for the Mining Scanner Blender add-on.

Reads the app-managed asset records that travel with an imported point
cloud:

    <...>/PC-xxxxxxxx/
    ├── source/scan.ply          ← the file being imported
    └── metadata/asset.json      ← sidecar written by the mobile import
    └── metadata/validation.json ← optional validation report

Facts only, never defaults: a missing or malformed sidecar yields `None`
and the operator sees an explicit "no provenance available" warning —
units, scale and CRS are never invented by this add-on. Pure stdlib; no
`bpy` import.
"""

import json
import os

ASSET_DIR_PREFIX = "PC-"


def find_sidecar(ply_path: str):
    """Returns the asset.json path for a PLY inside an app-managed asset
    directory (…/PC-xxxxxxxx/source/file.ply), else None."""
    directory = os.path.dirname(os.path.abspath(ply_path))
    while True:
        parent = os.path.dirname(directory)
        if parent == directory:  # reached the filesystem root
            return None
        if os.path.basename(directory).startswith(ASSET_DIR_PREFIX):
            candidate = os.path.join(directory, "metadata", "asset.json")
            if os.path.isfile(candidate):
                return candidate
            return None
        directory = parent


def load_asset_meta(sidecar):
    """Parsed asset.json, or None when absent/malformed — never fabricated."""
    if not sidecar or not os.path.isfile(sidecar):
        return None
    try:
        with open(sidecar, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return None
    return data if isinstance(data, dict) else None


def load_validation_report(sidecar):
    """Parsed validation.json next to the sidecar, or None — optional."""
    if not sidecar:
        return None
    report_path = os.path.join(os.path.dirname(sidecar), "validation.json")
    if not os.path.isfile(report_path):
        return None
    try:
        with open(report_path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return None
    return data if isinstance(data, dict) else None


def provenance_lines(meta, validation):
    """Human-readable provenance lines for the operator. States missing
    provenance plainly instead of substituting defaults."""
    if meta is None:
        return [
            "Provenance: none available — this file was not imported through Mining Scanner, "
            "or its sidecar is missing or malformed.",
            "Units, scale status and CRS are NOT established by this import.",
        ]
    lines = [
        f"Asset: {meta.get('asset_id', 'unknown')} (project {meta.get('project_id', 'unknown')})",
        f"Format: {meta.get('format', 'unknown')} · units: {meta.get('coordinate_units', 'unit_unknown')}",
        f"Scale status: {meta.get('scale_status', 'UNKNOWN')}",
    ]
    if meta.get("original_filename"):
        lines.append(f"Original file: {meta['original_filename']}")
    content = meta.get("content") or {}
    if isinstance(content, dict):
        props = content.get("coordinate_properties")
        if props:
            lines.append(f"Coordinate properties: {', '.join(props)}")
        lines.append(f"CRS: {content.get('crs') or 'none recorded'}")
    if meta.get("checksum_md5"):
        lines.append(f"MD5: {meta['checksum_md5']}")
    if validation:
        verdict = validation.get("verdict")
        if verdict:
            lines.append(f"Import validation verdict: {verdict}")
    return lines
