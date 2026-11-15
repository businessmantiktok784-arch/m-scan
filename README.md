# Underground Mining Scanner

Offline-first scan-to-analysis tooling for underground mining:

- **Mobile app** (Expo / React Native): offline project management on-device
  (SQLite), capability probing, **real offline capture** (segmented muted
  camera video + accelerometer/gyroscope/magnetometer JSONL streams with
  dual-clock timestamps), review screen, **external point-cloud import**
  (Stage 3.1: PLY/XYZ/LAS → preserved copy + streamed validation + provenance),
  **frame extraction** (Stage 3.2: validated Stage 2 recordings → verified,
  provenance-carrying frames via the platform decoder), **camera
  calibration** (Stage 3.3: pure-TypeScript Zhang solver on real extracted
  frames of a printed checkerboard — OpenCV not available on device,
  computed-never-validated provenance) and an export screen.
  No tracking, poses, reconstruction or meshes — those stay labelled
  not-implemented in the UI.
- **Blender extension** (`blender/addons/mining_scanner_tools`): load and
  inspect project metadata inside Blender 4.2+ (target machine runs 5.1),
  plus a real PLY point-cloud import with sidecar provenance (v0.2.0).
- **Shared JSON Schemas** (`schemas/`): language-neutral contracts for
  project, session, capability, asset records — plus the Stage 3
  reconstruction contracts (frames, calibration, tracking-result v1.1,
  trajectory, point-cloud reconstruction, registration v1.1, fusion,
  pointcloud-asset v1.2, validation) and the machine-readable operation
  registry.

No fabricated data: the app never shows fake scans, measurements or progress.
Unimplemented features say "not implemented".

## Status

**Stage 3.3 — camera calibration implemented (software scope).** A completed
frame set filmed with a printed checkerboard can be calibrated on device:
every frame is individually evaluated (blur, contrast, exposure, duplicates,
target detection — rejections carry reasons), then the app's own
pure-TypeScript Zhang solver (DLT homographies, closed-form intrinsics,
LM refinement — OpenCV is NOT available on device) produces a `CAL-` record
with per-image metrics. Calibration is pixel geometry only: `scale_status`
stays UNKNOWN, and results are labelled computed, not independently
validated. See `docs/stage3.3-camera-calibration.md`; on-device acceptance
is open (`docs/stage3.3-test-results.md`).

**Stage 3.2 — frame extraction implemented (software scope).** The Media &
Export screen extracts frames from real Stage 2 recordings: every segment is
validated (streamed MP4 box-walk) before any decode, frames are sampled on
two explicit modes (`time_interval` / `frame_rate`, capped), verified
(exists, non-empty, checksummed) and registered — the `frame_set` asset row
only in the same transaction as the `done` flip. Timestamps are honest:
the platform decoder is seek-based and reports no PTS, so `pts_ms` stays
null and capture-time mapping is recorded as unavailable — never invented.
FFmpeg is NOT integrated on device (ffmpeg-kit retired; native modules not
installable here) — a documented `FrameDecoder` seam keeps the desktop FFmpeg
path open. See `docs/stage3.2-frame-extraction.md`;
on-device acceptance is open (`docs/stage3.2-test-results.md`).

**Stage 3.1 — external point-cloud import implemented (software scope).**
The Media & Export screen imports external PLY (ascii/binary little-endian),
XYZ and LAS files: streamed, cancellable validation, the original file
preserved unmodified, imports recorded with `unit_unknown` / documented
scale UNKNOWN, and failed or cancelled imports never register as assets.
LAZ is rejected as unsupported on device. See
`docs/stage3.1-pointcloud-import.md`. On-device and Blender acceptance are
still open (`docs/stage3.1-test-results.md`). All reconstruction operations
remain NOT_IMPLEMENTED.

**Stage 3.0 — final architecture corrections complete.** The Stage 2.1
audit corrected the operation registry; the Stage 3
planning correction separated tracking, trajectory generation, point-cloud
reconstruction, registration and fusion into distinct dependency-ordered
operations, deprecated `frame_registration` (superseded, no data ever
emitted under it — no migration) and tightened the metric-scale rules
calibration is not scene scale; VALIDATED requires independent metric
evidence). The Stage 3.0 finalization then added two declared alternative
reconstruction paths on `pointcloud_reconstruction` (OpenCV-assisted vs
COLMAP-native — COLMAP needs no OpenCV trajectory first), added
`geometry_validation` as its own operation, corrected the library stack to
five functional groups / six named tools, documented FFmpeg's
build-dependent licensing, and added a compatibility matrix and
underground failure-handling plan. **Stage 3 software development does not
wait for physical-device verification** — that remains a deferred
acceptance requirement before phone-derived results can be trusted
(`docs/hardware-verification.md`). It is **not** a 3D scanner: every
reconstruction operation is NOT_IMPLEMENTED
(`schemas/operations.registry.json`).

## Requirements

- Node.js 20+ and [bun](https://bun.sh)
- A device or the Expo dev-build workflow for on-device runs
- Blender 4.2+ (5.1 supported) for the desktop extension — Windows machine

## Run the mobile app

```bash
cd mining-scanner
bun install
bunx expo run:android --device            # dev build on a physical device
bunx expo run:android --device --variant release   # offline-verification build
# or: bunx expo run:ios (macOS + Xcode required)
```

Web export is not a supported target for this product; use a device or
emulator build.

## Run the tests

```bash
cd mining-scanner
bun test tests/mobile                # 201 model/migration/lifecycle/import/extraction/calibration/contract tests (pure TS, off-device)
python3 -m unittest discover -s tests/python   # 57 schema/add-on/registry/import tests (stdlib only)
```

What the tests do **not** cover: real camera/sensor hardware behaviour,
on-device SQLite persistence, navigation, Blender add-on installation (needs
a Blender binary), Android/iOS release builds. See `STAGE1_REPORT.md`,
`STAGE2_REPORT.md` and `docs/hardware-verification.md`.

## Documentation

- `docs/architecture.md` — components, seams, data flow, coordinate convention
- `docs/capture-pipeline.md` — Stage 2 capture: storage layout, timestamp
  synchronization rules, JSONL format, segment lifecycle
- `docs/tracking-evaluation.md` — why visual tracking is NOT IMPLEMENTED,
  and how the Stage 3 planning correction split the responsibilities
- `docs/data-exchange.md` — formats, units, operation registry, metric-scale
  rules, honesty rules
- `docs/blender-extension.md` — install & verification on the operator
  machine, planned Stage 3 inspection panels
- `docs/hardware-verification.md` — device/Blender verification checklists
- `docs/STAGE2_1_AUDIT_REPORT.md` — what the audit verified, fixed and removed
- `docs/STAGE3_READINESS.md` — final Stage 3 order, device-verification
  policy, 8 GB RAM discipline, Blender plan
- `docs/STAGE3_DEPENDENCY_MAP.md` — per-operation dependency and
  provenance tables for the 14-operation registry, two-path flow
- `docs/STAGE3_LIBRARY_EVALUATION.md` — processing library choices,
  licences (incl. FFmpeg build-dependence), rejected alternatives
- `docs/STAGE3_COMPATIBILITY_MATRIX.md` — what is actually verified vs
  proposed (environment, Python, Blender, 8 GB RAM strategy)
- `docs/STAGE3_FAILURE_HANDLING.md` — underground environment risks,
  failure conditions, rejection rules, provenance
- `docs/STAGE3_FINALIZATION_REPORT.md` — the Stage 3.0 correction record
- `docs/stage3.1-pointcloud-import.md` — Stage 3.1 import pipeline, provenance guarantees, verdict mapping
- `docs/pointcloud-formats.md` — per-format support matrix (PLY/XYZ/LAS/LAZ)
- `docs/pointcloud-storage.md` — asset directory layout, DB lifecycle tables, crash semantics
- `docs/pointcloud-validation.md` — streamed validators, verdicts, cancellation
- `docs/blender-pointcloud-import.md` — the add-on's real PLY import (v0.2.0)
- `docs/stage3.1-test-results.md` — what ran here vs operator acceptance
- `docs/stage3.2-frame-extraction.md` — Stage 3.2 pipeline, sampling modes, decoder reality
- `docs/video-input-validation.md` — MP4 probe facts, verdicts, warnings
- `docs/frame-timestamp-provenance.md` — what each time field means and why nulls stay null
- `docs/frame-storage.md` — job/frame storage layout, lifecycle, integrity rules
- `docs/ffmpeg-integration.md` — why FFmpeg is not on device, and the seam for later
- `docs/stage3.2-test-results.md` — what ran here vs device acceptance
- `docs/stage3.3-camera-calibration.md` — Stage 3.3 pipeline, detection, solver reality
- `docs/camera-models.md` — K + distortion conventions, the pure-TS Zhang internals
- `docs/calibration-quality.md` — per-image gates, thresholds, run metrics, RMS gate
- `docs/calibration-provenance.md` — the three declared sources and the validation ladder
- `docs/colmap-camera-compatibility.md` — exact conversions and refusals
- `docs/stage3.3-test-results.md` — what ran here vs device acceptance
- `schemas/*.schema.json` — the eighteen v1 / v1.1 / v1.2 / v1.3 / v2 record schemas
- `schemas/operations.registry.json` — operation registry (stages,
  dependencies, status)

## Dependencies & licences

Mobile app (Expo SDK 58): `expo`, `expo-router`, `react-native`, `expo-sqlite`,
`expo-file-system`, `expo-camera`, `expo-sensors`, `expo-crypto`,
`expo-video-thumbnails`, `expo-image-manipulator`, `zod`,
`lucide-react-native`, `react-native-safe-area-context`,
`react-native-screens`, plus standard Expo template dependencies —
MIT-licensed, per their respective repositories (details in
`mining-scanner/package.json`).

Blender extension: **GPL-3.0** (declared in `blender_manifest.toml`), matching
Blender's add-on licensing expectations.

JSON Schemas and project documentation: same licence as the repository.
# m-scan
