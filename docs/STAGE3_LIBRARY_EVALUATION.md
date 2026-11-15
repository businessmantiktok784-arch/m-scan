# Stage 3 processing library evaluation

Desktop-side processing libraries for the Stage 3 operations, evaluated
against the project's constraints: offline only, free/open-source, Windows
workstation with **8 GB RAM**, Python integration, Blender 5.1 as the
inspection environment. No candidate is adopted by implementation status
alone — selection is confirmed when each operation's implementation begins,
and the exact version used is recorded in every operation record's
provenance (`tool`, `tool_version`).

**Recommendation up front (minimal stack):**

| Functional group | Tool/package | Intended purpose |
|---|---|---|
| Video processing | **FFmpeg** | Frame extraction and video handling |
| Computer vision | **OpenCV** | Calibration, features and tracking |
| Photogrammetry | **COLMAP / pycolmap** | SfM, pose estimation and reconstruction |
| Point-cloud processing | **Open3D** | Registration, fusion, meshing and validation |
| Geospatial point-cloud I/O | **laspy** | LAS/LAZ file handling |
| LAZ compression | **lazrs** | LAZ compression support (laspy backend) |

This is **five functional groups and six named tools/packages** (laspy and
lazrs form one I/O group; COLMAP and its Python binding pycolmap form one
photogrammetry group) — **not four dependencies**, as an earlier revision of
this document stated. Blender itself is the inspection environment, not part
of the processing stack. Everything is replaceable behind the operation
registry: the mobile app's contracts (JSON Schemas, zod) never mention any
library — provenance records which one ran.

**Adoption status: proposed, not verified.** No package below is claimed
installed or workflow-tested. What has actually been checked in the current
development sandbox (Linux) is recorded in
`docs/STAGE3_COMPATIBILITY_MATRIX.md`; the Windows workstation columns are
NOT_TESTED until the operator machine runs that matrix.

---

## Candidate evaluations

### Open3D

| Criterion | Assessment |
|---|---|
| Exact name | `open3d` (PyPI) |
| Main responsibility | Point-cloud/mesh library: ICP registration, multiway registration, Poisson meshing, geometry I/O (PLY/XYZ/PCD), voxel down-sampling, quality checks |
| Formats in/out | PLY, XYZ, PCD, OBJ/STL/OFF/GLB (mesh); no LAS/LAZ |
| OS compatibility | Windows, macOS, Linux (wheels) |
| Python integration | First-class (pip, wheels for CPython); version support per release — confirm against the chosen Python |
| Version detection | `open3d.__version__` |
| Installation | `pip install open3d` |
| Blender integration | Complementary: Open3D processes, Blender imports the PLY/OBJ output; no plugin needed |
| License / commercial use | MIT — no restrictions for this project |
| Offline | Fully offline |
| Memory (8 GB) | Fine with chunking discipline; multiway registration of large clouds is the memory hot spot — use voxel down-sampling and pairwise-then-refine; a full multiway on millions of points will not fit 8 GB |
| Performance | C++/OpenMP core; fast ICP on down-sampled clouds |
| Known limitations | No LAS/LAZ; MVS/pose estimation out of scope; Poisson needs watertight-ish input quality |
| Installed & verified | **NOT_AVAILABLE** in the Linux dev sandbox (not installed); import untested elsewhere |
| Verdict | **Proposed** for registration, fusion, meshing, validation |

### OpenCV (opencv-python)

| Criterion | Assessment |
|---|---|
| Exact name | `opencv-python` (PyPI); imports as `cv2` |
| Main responsibility | Computer vision: calibration (chessboard/circle grids), feature detect/match (ORB/SIFT/AKAZE), optical flow, essential-matrix pose from pairs |
| Formats in/out | Images (frames); outputs are numeric results, not assets |
| OS compatibility | Windows, macOS, Linux |
| Python integration | pip wheels |
| Version detection | `cv2.__version__` |
| Installation | `pip install opencv-python` |
| Blender integration | Indirect (produces calibration/pose records consumed downstream); not assumed to run inside Blender's Python |
| License / commercial use | Apache-2.0 — fine |
| Offline | Fully offline |
| Memory (8 GB) | Fine; per-frame processing streams naturally |
| Performance | Very optimized C++ |
| Known limitations | opencv-python wheels do not include CUDA; SIFT/feature quality below a full SfM pipeline for weak texture; no bundle adjustment |
| Installed & verified | **VERIFIED** in the Linux dev sandbox: `import cv2` succeeds, 4.11.0 (import only — no workflow tested). **NOT_TESTED** on Windows |
| Verdict | **Proposed** for calibration (3.3) and the feature/tracking layer (3.4a Path A) |

### COLMAP / pycolmap

| Criterion | Assessment |
|---|---|
| Exact name | `pycolmap` (PyPI, Python bindings) and/or the `colmap` executable |
| Main responsibility | Full Structure-from-Motion (features → matches → bundle adjustment → sparse cloud + poses) and Multi-View Stereo (dense point cloud). pycolmap exposes most of it to Python. This is the **Path B (COLMAP-native)** engine and optionally the Path A reconstruction step |
| Formats in/out | Images in; COLMAP databases/text in; point clouds out (PLY via export) |
| OS compatibility | Windows (pre-built binaries), Linux, macOS; pycolmap wheels on PyPI |
| Python integration | pycolmap (BSD-3-Clause), active upstream; CUDA wheels optional (not assumed here) |
| Version detection | `pycolmap.__version__` or `colmap -h` banner |
| Installation | `pip install pycolmap` (wheels preferred over source builds); standalone COLMAP from the official releases |
| Blender integration | Exported PLY imports into Blender directly |
| License / commercial use | COLMAP and pycolmap are BSD-3-Clause. COLMAP itself is fine commercially, but building it with certain dependencies can change the aggregate license; using official binaries/pycolmap wheels keeps this simple. Citation of the paper is requested by the authors when used in research |
| Offline | Fully offline |
| Memory (8 GB) | The main constraint: large image sets need bounded `max_image_size`, vocabulary-tree matching, and per-chunk model merging. A short mine session (hundreds of frames at reduced resolution) is feasible; thousands of full-res frames will not fit 8 GB — the architecture must chunk by capture segment |
| Performance | CPU-only mode is usable but slow; GPU helps and is optional |
| Known limitations | Not aimed at survey-grade accuracy; feature quality depends on texture (mine walls are feature-poor in places — tracking loss must be expected and recorded); scale is arbitrary (up to the project's scale-provenance rules) |
| Installed & verified | **NOT_AVAILABLE** in the Linux dev sandbox (neither pycolmap nor colmap installed) |
| Verdict | **Proposed** as the reconstruction engine (3.5) and the recommended Path B workflow; also usable in Path A where a trajectory-conditioned method exists |

### FFmpeg

| Criterion | Assessment |
|---|---|
| Exact name | `ffmpeg` executable (CLI) + `ffprobe`; or the `imageio-ffmpeg` PyPI package which bundles a binary |
| Main responsibility | Video decode/encode — frame extraction with PTS timestamps (3.2) |
| Formats in/out | Practically every video container/codecs in; PNG/JPEG frames out with `-vf showinfo`/`ffprobe` for PTS |
| OS compatibility | Windows, macOS, Linux (static builds) |
| Python integration | Used as CLI (simplest, version-pinnable) or via `imageio-ffmpeg`'s bundled binary |
| Version detection | `ffmpeg -version` — record the full version string **and the configuration line** in operation provenance |
| Installation | System package manager or pinned static build; `imageio-ffmpeg` if a pip-managed binary is preferred |
| Blender integration | Blender bundles its own FFmpeg; no interaction needed |
| License / commercial use | **Depends on the build configuration — never assume.** See the licensing note below |
| Offline | Fully offline |
| Memory (8 GB) | Streams; constant memory |
| Performance | The standard |
| Known limitations | Version/codec drift between builds — pin and record the version; decode errors on damaged files must be caught (map to `video_unreadable`/`decode_error`) |
| Installed & verified | **VERIFIED in the Linux dev sandbox** (7.1.5, distro build). **NOT_TESTED** on the Windows workstation |
| Verdict | **Proposed** for frame extraction |

**FFmpeg licensing — configuration-dependent, reviewed per binary.**

- FFmpeg source is LGPL-2.1-or-later, but a **build** may be GPL-licensed
  (`--enable-gpl`) and optional components (x264/x265, certain codecs,
  filters, non-free additions) can introduce further obligations. Some
  components carry their own licences that only apply when enabled.
- The project must therefore **not assume every FFmpeg binary has the same
  licence**, and must not make a blanket "FFmpeg is LGPL" statement.
- The exact binary distribution, version, build configuration and resulting
  licence must be **recorded** for whichever build is used
  (`ffmpeg -version` prints the configuration line).
- **Before distributing FFmpeg with the application or the desktop tools,
  the selected build must undergo a licensing review.** Until then: use a
  system-installed ffmpeg locally, do not bundle or redistribute any
  unverified binary.
- Worked example: the Linux dev sandbox's distro ffmpeg 7.1.5 is built with
  `--enable-gpl` (libx264/libx265 enabled) and is therefore a GPL build —
  not LGPL. This is exactly why the configuration line must be recorded.

### laspy (+ lazrs)

| Criterion | Assessment |
|---|---|
| Exact name | `laspy` (PyPI) with the `lazrs` backend package for LAZ |
| Main responsibility | ASPRS LAS/LAZ read/write for `pointcloud_import` (3.1) |
| Formats in/out | LAS/LAZ (1.0–1.4) in/out |
| OS compatibility | Pure Python + optional Rust accel (lazrs), all OSes |
| Python integration | pip |
| Version detection | `laspy.__version__` / `lazrs.__version__` (where exposed) or `importlib.metadata.version` |
| Installation | `pip install laspy[lazrs]` |
| Blender integration | Convert to PLY for import, or write a small add-on importer later |
| License / commercial use | laspy BSD-2-Clause; lazrs (Apache-2.0/MIT dual) — fine; verify lazrs licence at adoption time |
| Offline | Fully offline |
| Memory (8 GB) | Native **chunked reading/writing** — designed exactly for large files on small RAM |
| Performance | Good; lazrs backend for LAZ |
| Known limitations | LAS always carries real-world coordinates and units — the importer must validate units/CRS metadata and fail on unknown, per the registry rules |
| Installed & verified | **NOT_AVAILABLE** in the Linux dev sandbox (neither installed) |
| Verdict | **Proposed** for LAS/LAZ import |

### Considered and not adopted (with reasons)

| Candidate | Reason not adopted |
|---|---|
| PDAL | Powerful but heavy point-cloud pipeline framework; laspy + Open3D cover our needs with far less surface area. Revisit only if E57 or CRS reprojection becomes a requirement |
| OpenMVG / OpenMVS | Capable SfM/MVS alternative, but weaker Windows wheels and smaller Python story than pycolmap; pycolmap preferred |
| CloudCompare CLI | GUI-first tool; its CLI exists but scripting quality/maintenance is worse than Open3D's Python API |
| PyTorch / TensorFlow / learned MVS (e.g. depth-estimation networks) | Large installs, heavy RAM/GPU appetite, hard to keep offline-light on 8 GB, and outputs are harder to attribute honestly. Not adopted; a trained model would also demand dataset licensing scrutiny. Revisit only with explicit justification |
| PCL (Point Cloud Library) | C++ with poor Python integration vs Open3D |
| ARRAS/commercial SDKs | Violate offline/free constraints outright |

## Modularity rule

Every operation implementation goes behind its registry seam
(`src/engine/reconstruction.ts` interfaces on the app side; the desktop
pipeline is a separate Python codebase that writes the schema-validated
records). Any library can be swapped without touching:

- the JSON Schemas / zod contracts,
- the operation registry,
- the mobile app,
- the Blender add-on metadata path.

When an implementation lands, the operation record MUST carry the exact
`tool` and `tool_version` that ran — recorded from the environment, never
hard-coded.
