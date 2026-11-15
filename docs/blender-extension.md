# Blender extension — mining_scanner_tools

A Blender 4.2+ extension (manifest format) that will let an operator load a
Mining Scanner project, inspect its metadata and — in later stages — import
point clouds and meshes for analysis.

**Status (Stage 3.1):** panels and the metadata loader work; the point-cloud
import operator is now a **real PLY importer** (v0.2.0, matching the
mobile `pointcloud_import` — see docs/blender-pointcloud-import.md): PLY
ascii/binary-LE only, coordinates exactly as stored, sidecar provenance
loaded onto the imported object. `mesh_reconstruction`,
`tunnel_axis_extraction`, `cross_section_analysis` and
`convergence_analysis` remain NOT_IMPLEMENTED in the registry
(`schemas/operations.registry.json`) and their operators still report
`CANCELLED` with a `WARNING`. The Stage 3 planning correction deprecated
`frame_registration` (split into tracking, trajectory, reconstruction,
registration and fusion operations) — the add-on never emitted data under
it, so nothing changes here except the planned operator set below.

## Install (on the operator's Windows machine)

1. Install **Blender 5.1** (or any 4.2+ build; 5.1 is the supported target).
2. Zip the add-on folder so that `blender_manifest.toml` is at the root of the
   archive:
   ```
   cd mining-scanner/blender/addons/mining_scanner_tools
   # from a shell with zip available, or 7-Zip / Explorer "Send to → Compressed folder"
   zip -r ../mining_scanner_tools-0.2.0.zip .
   ```
   (zip the *contents* of `mining_scanner_tools/`, not the parent folder.)
3. In Blender: `Edit → Preferences → Get Extensions → ⌄ (top right) →
   Install from Disk…` and pick the zip.
4. Enable it if not auto-enabled: Preferences → Add-ons → search
   "Mining Scanner Tools".

## Verify the install

1. Open the **3D Viewport**, press `N` — a **Mine Scanner** tab appears in the
   sidebar with four panels: Project, Project Info, Import, Processing.
2. Click **Load Project (.miningscan.json)** and choose a project directory's
   `.miningscan.json`. A valid file populates the Project Info panel; an
   invalid one shows a `WARNING` and changes nothing.
3. **Import external point cloud (PLY)** — Stage 3.1: imports a PLY
   (ascii or binary little-endian) as a point cloud. Other formats show a
   distinct "unsupported" message. If the file sits in a mining-scanner
   asset directory, its provenance (units, scale status, validation verdict)
   is printed and stored as object properties; without a sidecar you get an
   explicit "no provenance available" warning. **Not yet verified in
   Blender** — no Blender binary in the build environment; run the
   acceptance steps in docs/stage3.1-test-results.md.
4. (Later stages only) Analyse mesh — still a stub with an honest "not
   implemented" warning until its registry operation is implemented.

## Files

| File | Role |
|---|---|
| `blender_manifest.toml` | Extension manifest (id `mining_scanner_tools`, v0.2.0, GPL-3.0) |
| `__init__.py` | bl_info legacy block + register/unregister |
| `panels.py` | `MiningScannerProjectGroup` PropertyGroup + sidebar panels (Project, Project Info, Import, Processing) |
| `operators.py` | Load Project (working), Import external point cloud (real PLY importer, Stage 3.1), Analyse Mesh (explicit stub) |
| `core/project_meta.py` | `parse_project_metadata()` — validates `.miningscan.json` against the v1 rules |
| `core/ply_parser.py` | Pure PLY reader (no bpy): ascii + binary-LE, vertex-first boundary, streamed reads |
| `core/asset_meta.py` | Sidecar discovery + `asset.json` / `validation.json` reader for import provenance |

## Testing

- Automated static tests (compilation, manifest keys, metadata parser) run in
  `tests/python/test_stage1.py` — 12 tests, all passing.
- **In-Blender install/panel verification was NOT run** in this environment
  (no Blender binary available) and must be done on the operator's machine
  following the steps above.

## Uninstall

Preferences → Add-ons → Mining Scanner Tools → Remove. No preferences or
scene data persist after removal beyond loaded panel state in the current
session.

## Planned Blender-side integration (Stage 3, not started)

When Stage 3 processing begins, the add-on grows read/inspection surfaces
for its outputs. Planned, **not implemented** — no panel or operator below
exists yet:

- **Point-cloud panels** for imported (`pointcloud_import`), reconstructed
  (`pointcloud_reconstruction`) and fused (`pointcloud_fusion`) clouds:
  source session ids, point count, format, units, coordinate frame,
  scale status with its provenance (UNKNOWN / RELATIVE / ESTIMATED /
  VALIDATED + basis and detail), checksum, and processing history.
- **Mesh panels** for `mesh_reconstruction` output: generation method,
  source cloud id, vertex/face counts, validation status.
- **Trajectory display** for `trajectory_generation` output: camera poses
  drawn as an axis polyline in the viewport, labelled with the `TRJ-` id,
  coordinate frame and timestamp provenance — inspection only, never a
  claim of metric accuracy.
- **Metadata/provenance surfaces** for every loaded asset: the registry
  operation that produced it, tool and tool version, processing timestamps,
  the reconstruction `pipeline_path` (OpenCV-assisted vs COLMAP-native),
  and validation records (`VAL-`).
- **Scale honesty in the UI:** until a cloud's `scale_status` is VALIDATED
  with independent metric provenance, every measurement display carries a
  visible "relative/estimated — not validated" annotation.

Rule that carries over unchanged: an add-on operator flips from stub to
working **only when the corresponding registry operation becomes
IMPLEMENTED** in `schemas/operations.registry.json`.

**Integration boundary (Stage 3.0 finalization).** The division of labour
is fixed and deliberately simple:

1. **Mobile capture** — the Expo app records video + sensor streams
   (implemented, Stage 2).
2. **External processing tools** — a separate desktop Python codebase runs
   the Stage 3 operations (FFmpeg/OpenCV/COLMAP/Open3D/laspy) and writes
   schema-validated records and asset files.
3. **Blender inspection and visualization** — the add-on loads project
   metadata, assets, provenance and validation verdicts for human review;
   it runs **no processing engine of its own**.
4. **Shared project metadata and asset formats** — the JSON Schemas,
   operation registry and documented file formats are the only interface
   between the three.

Blender receives imported / reconstructed / registered / fused point
clouds, reconstructed meshes, tunnel-axis polylines, coordinate-frame and
scale metadata, operation provenance, and processing warnings through those
shared files — never through a private pipeline. No duplicate processing
engine may be introduced inside Blender when an external tool can do the
work and exchange standardized assets. The existing metadata loader is
preserved unchanged.

Reconstruction
itself runs in desktop Python outside Blender (see
`docs/STAGE3_LIBRARY_EVALUATION.md`); Blender is the operator's
inspection and QA surface.
