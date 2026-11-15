"""Validate Mining Scanner project metadata (``.miningscan.json``).

This is the Blender-side implementation of
``schemas/project-metadata.schema.json`` (v1). It must stay in sync with the
TypeScript models in ``src/models/models.ts`` and the JSON Schema, which is
the referee when implementations disagree.

Honesty rules: a file that is missing, malformed, or carries an unsupported
schema version raises :class:`ProjectMetadataError` — nothing is guessed,
defaulted into existence, or silently repaired.
"""

from __future__ import annotations

import re

from typing import Any, Dict

PROJECT_ID_PATTERN = re.compile(r"^MS-[0-9a-f]{8}$")
SUPPORTED_SCHEMA_VERSION = 1
ALLOWED_STATUSES = ("active", "archived")

MAX_NAME_LEN = 80
MAX_SITE_NAME_LEN = 120
MAX_NOTES_LEN = 2000


class ProjectMetadataError(ValueError):
    """Raised when project metadata is missing, malformed or unsupported."""


def _is_iso8601_utc(value: str) -> bool:
    # Minimal structural check: full date, T separator, time and a UTC
    # designator (Z or ±hh:mm). Full parsing happens in the mobile validator;
    # here we only refuse obvious garbage.
    if not isinstance(value, str) or "T" not in value:
        return False
    date_part, _, rest = value.partition("T")
    if len(date_part) != 10 or date_part.count("-") != 2:
        return False
    return rest.endswith("Z") or rest[-6] in "+-" and rest[-3] == ":"


def _require_string(record: Dict[str, Any], key: str, *, max_len: int, allow_empty: bool = False) -> str:
    value = record.get(key)
    if not isinstance(value, str):
        raise ProjectMetadataError(f"{key} must be a string")
    if not allow_empty and not value.strip():
        raise ProjectMetadataError(f"{key} must not be empty")
    if len(value) > max_len:
        raise ProjectMetadataError(f"{key} exceeds maximum length of {max_len}")
    return value


def parse_project_metadata(data: Any) -> Dict[str, Any]:
    """Validate a parsed ``.miningscan.json`` document and return it.

    Raises :class:`ProjectMetadataError` with a descriptive message when the
    document does not match the v1 contract.
    """
    if not isinstance(data, dict):
        raise ProjectMetadataError("project metadata must be a JSON object")

    for key in ("project_id", "schema_version", "name", "status", "created_at", "updated_at"):
        if key not in data:
            raise ProjectMetadataError(f"missing required field: {key}")

    project_id = data["project_id"]
    if not isinstance(project_id, str) or not PROJECT_ID_PATTERN.match(project_id):
        raise ProjectMetadataError("project_id must match MS-XXXXXXXX (8 hex characters)")

    if data["schema_version"] != SUPPORTED_SCHEMA_VERSION:
        raise ProjectMetadataError(
            f"unsupported schema_version: {data['schema_version']!r} (this build supports v{SUPPORTED_SCHEMA_VERSION})"
        )

    _require_string(data, "name", max_len=MAX_NAME_LEN)
    _require_string(data, "status", max_len=20)
    if data["status"] not in ALLOWED_STATUSES:
        raise ProjectMetadataError(f"status must be one of {', '.join(ALLOWED_STATUSES)}")

    if not _is_iso8601_utc(data["created_at"]):
        raise ProjectMetadataError("created_at must be an ISO 8601 UTC timestamp")
    if not _is_iso8601_utc(data["updated_at"]):
        raise ProjectMetadataError("updated_at must be an ISO 8601 UTC timestamp")

    # Optional fields.
    site_name = data.get("site_name", "")
    if not isinstance(site_name, str) or len(site_name) > MAX_SITE_NAME_LEN:
        raise ProjectMetadataError(f"site_name must be a string of at most {MAX_SITE_NAME_LEN} characters")
    notes = data.get("notes", "")
    if not isinstance(notes, str) or len(notes) > MAX_NOTES_LEN:
        raise ProjectMetadataError(f"notes must be a string of at most {MAX_NOTES_LEN} characters")

    return {
        "project_id": project_id,
        "schema_version": data["schema_version"],
        "name": data["name"],
        "site_name": site_name,
        "notes": notes,
        "status": data["status"],
        "created_at": data["created_at"],
        "updated_at": data["updated_at"],
    }
