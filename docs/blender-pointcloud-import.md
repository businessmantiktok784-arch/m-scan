# Blender add-on — importing a Stage 3.1 point cloud (v0.2.0)

The add-on (`mining_scanner_tools`) gains a real PLY import operator in
v0.2.0. It shares the same committed synthetic fixtures and the same honesty
rules as the mobile importer.

## What works

- **PLY only** — ascii and binary_little_endian, vertex element first. Other
  formats (XYZ, LAS, LAZ, big-endian PLY) are refused with a distinct,
  explicit message; the operator never falls back to a guess.
- **Coordinates exactly as stored** — no unit conversion, no axis remap, no
  origin shift. If the file was exported in unknown units, that is what the
  Blender scene shows (Blender scene unit scale is untouched).
- **Colours** — when red/green/blue are present they are applied via
  `mesh.color_attributes.new(..., 'BYTE_COLOR', 'POINT')` with the same
  u8→1.0 normalization heuristic; a failure here degrades to a warning, not
  a failed import.
- **Faces** — never imported; a warning states face data was skipped.
- **Provenance** — if the imported file lives inside a mining-scanner asset
  directory, the add-on finds and loads the sidecar `asset.json` /
  `validation.json` (`core/asset_meta.py`), prints the provenance (asset id,
  units, scale status, validation verdict) and stores it as custom
  properties on the new object. A file with **no sidecar** imports with an
  explicit "no provenance available" warning — defaults are never invented.

## Where it lives in the UI

Import panel (N-sidebar → Mining Scanner → Import):
"Import external point cloud (PLY)". Progress is batched in 100 000-record
reads; large files stream without holding the whole cloud twice in memory.

## What is still a stub

`analyze_mesh` remains a stub (Stage 4 scope). The add-on does not create,
modify or validate mesh geometry; it imports points.

## Verification status

**NOT RUN** — this sandbox has no Blender binary. The parser and sidecar
logic are pure Python (no `bpy` import) and are covered by
`tests/python/test_stage3_1.py` against the same fixtures the mobile
validator uses. Operator-side acceptance: install the add-on in Blender
5.1, run the import on a fixture and on a real external PLY, and confirm
the panel, warnings and provenance properties (see stage3.1-test-results.md).
