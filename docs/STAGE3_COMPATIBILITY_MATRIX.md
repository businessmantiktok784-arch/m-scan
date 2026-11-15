# Stage 3 compatibility matrix

**What has actually been verified versus what is merely proposed.** A
documented installation command is not proof that a package works; a
successful import is not proof that a full processing workflow works; a
unit test is not proof of real-world mining suitability. Every row below
carries an explicit status.

Status legend: **VERIFIED** (actually executed/observed in a named
environment) · **FAILED** (executed and did not work) · **NOT_TESTED**
(environment available in principle, check not yet run) ·
**NOT_AVAILABLE** (tool/package absent from the environment) ·
**NOT_APPLICABLE** (does not apply).

---

## A. Development environment — VERIFIED (Linux sandbox, this project's dev container)

| Attribute | Value | Status |
|---|---|---|
| OS | Linux (Debian-based, kernel 6.1.189, x86_64) — **not Windows** | VERIFIED |
| CPU architecture | x86_64 | VERIFIED |
| Available RAM | 7.8 GiB total (~5.9 GiB available at probe time) | VERIFIED |
| Available storage | 109 GB volume, 99 GB free | VERIFIED |
| Python | 3.13.14 | VERIFIED |
| pip | 26.2.2 | VERIFIED |
| bun | 1.4.4 | VERIFIED |
| ffmpeg / ffprobe | 7.1.5-0+deb13u1 (Debian distro build, **`--enable-gpl`** configuration — see licensing note in `docs/STAGE3_LIBRARY_EVALUATION.md`) | VERIFIED |
| Blender | — | NOT_AVAILABLE |
| COLMAP executable | — | NOT_AVAILABLE |

**Windows workstation (the Stage 3 target machine): NOT_TESTED.** Windows
version, CPU, RAM, storage, Python version, package manager and required
executables are all NOT_TESTED until the operator runs this matrix there.
The 8 GB planning figure is consistent with the sandbox's 7.8 GiB, but the
Windows numbers must be recorded, not assumed.

## B. Python dependencies

Import-tested in the Linux dev sandbox (Python 3.13.14). An import is the
*only* claim made — no processing workflow has run.

| Package | Import | Version seen | Status | Notes |
|---|---|---|---|---|
| `opencv-python` (`cv2`) | yes | 4.11.0 | VERIFIED (import only) | |
| `numpy` | yes | 2.3.5 | VERIFIED (import only) | OpenCV/Open3D/pycolmap dependency surface |
| `open3d` | no | — | NOT_AVAILABLE | Proposed; not installed |
| `pycolmap` | no | — | NOT_AVAILABLE | Proposed; not installed |
| `laspy` | no | — | NOT_AVAILABLE | Proposed; not installed |
| `lazrs` | no | — | NOT_AVAILABLE | Proposed; not installed |

**Joint compatibility: NOT_TESTED.** The packages have never been installed
together here, so co-installation conflicts (e.g. numpy ABI pinning between
OpenCV, Open3D and pycolmap wheels on the chosen Python) are UNVERIFIED.
Do not assume the six packages work together because each is individually
available. The Windows Python version must be chosen first, then the whole
set installed and import-tested together, then a minimal end-to-end
exercise (see §D) before any "compatible" claim.

## C. Blender 5.1

| Check | Status |
|---|---|
| Blender 5.1 installed | NOT_AVAILABLE (no Blender binary in any sandbox used so far) |
| Add-on install + panels | NOT_TESTED (needs Blender; checklist in `docs/blender-extension.md` and `docs/hardware-verification.md`) |
| Blender's bundled Python version and package compatibility | NOT_TESTED |
| Whether processing libraries can run inside Blender's Python | NOT_TESTED — and **deliberately not planned**: external processing runs outside Blender and exchanges files through the documented interfaces |
| Existing metadata loader still functional | VERIFIED at the code level (Python compile + static tests pass); in-Blender behaviour NOT_TESTED |

**Boundary (binding):** mobile capture · external processing tools ·
Blender inspection/visualization · shared project metadata and asset
formats. No processing dependency is forced into Blender's Python.

## D. Hardware and memory (~8 GB RAM) verification strategy — all UNVERIFIED

No benchmark below has been run. Every number is a plan, not a result.

| Check | Planned method | Status |
|---|---|---|
| Small dataset (tens of frames / ≤1 M points) | Extract → reconstruct → register a genuine small recording end-to-end; record peak RSS and wall time | NOT_TESTED |
| Medium dataset (hundreds of frames / 1–10 M points) | Same, with segment chunking; record peak RSS per chunk | NOT_TESTED |
| Large dataset (thousands of frames / >10 M points) | Chunk-by-capture-segment with per-chunk limits; expected to require explicit quality settings | NOT_TESTED |
| Frame-extraction limits | Max frames per job and disk watermark before extraction refuses | UNVERIFIED (design figure only) |
| Point-cloud chunking | Streaming/chunked read-modify-write for import, registration, fusion | UNVERIFIED |
| Incremental processing | Resume from last completed chunk/job after interruption | UNVERIFIED |
| Temporary-file cleanup | Temp dirs removed on success, failure and cancellation; free-space gate before start | UNVERIFIED |
| Cancellation and recovery | User-cancel mid-operation leaves a failed record, no partial asset, no orphan index row | UNVERIFIED |
| Memory monitoring | Peak-RSS recorder attached to every processing job; written into the operation record | UNVERIFIED |
| Storage-space monitoring | Free-space check before and during long jobs (Stage 2's 200 MB gate is the pattern) | UNVERIFIED |

**Quality-reduction rule (binding):** no resolution, frame-count, point
density or mesh quality may be silently reduced to dodge memory errors. Any
reduction is explicit, configurable, and recorded in the operation record's
`settings`. When a job exceeds the machine's practical capability, that is
reported, not hidden.

## E. What is NOT claimed

- No package compatibility is claimed beyond the import checks listed
  above.
- No processing performance, capacity or accuracy figure is claimed
  anywhere.
- The Windows workstation, Blender 5.1, and joint-package behaviour are
  NOT_TESTED and must be verified on the operator machine before Stage 3
  processing is trusted there.
