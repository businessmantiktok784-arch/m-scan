# Stage 3 readiness — mesh reconstruction & tunnel geometry

What Stage 3 can build on, the corrected dependency order, the verification
gate, and the resource constraints. Written by the Stage 3 planning
correction; supersedes the Stage 2.1 version of this document.

Detailed per-operation contracts: `docs/STAGE3_DEPENDENCY_MAP.md`.
Processing library choices: `docs/STAGE3_LIBRARY_EVALUATION.md`.

## 1. What exists and is ready

- **Real input data.** Stage 2 capture produces segmented muted camera video
  + accelerometer/gyroscope/magnetometer JSONL streams with dual-clock
  timestamps, checksums and manifests.
- **Complete, corrected operation registry.** Every Stage 3 operation is
  named, typed by inputs/outputs, declares dependencies, failure modes and
  mandatory provenance, and is marked NOT_IMPLEMENTED
  (`schemas/operations.registry.json`). `frame_registration` is DEPRECATED,
  split into `visual_tracking`, `trajectory_generation`,
  `pointcloud_reconstruction`, `pointcloud_registration` and
  `pointcloud_fusion` — no data was ever emitted under the old name, so no
  migration is needed.
- **Complete data contracts.** Extracted frames (`FRM-`/`JOB-`),
  calibration (`CAL-`), tracking results (`TRK-`), trajectories (`TRJ-`),
  registration/fusion/reconstruction operation records (`OP-`), geometry
  validation (`VAL-`), and pointcloud-asset v1.2 with full traceability.
- **Enforced scale discipline.** `scale_status ∈ {UNKNOWN, RELATIVE,
  ESTIMATED, VALIDATED}` with provenance schemas that reject: UNKNOWN with a
  claimed basis, operator_assumed anything better than ESTIMATED, and
  VALIDATED without independent metric evidence. A camera calibration alone
  is explicitly not a scale basis.
- **Loud absence.** Reconstruction seams reject every call;
  `assertOperationImplemented()` guards future entry points.

## 2. Final dependency order (Stage 3.0 finalization)

1. **3.1 `pointcloud_import`** — genuine external PLY/LAS/LAZ into `PC-`
   assets. Early milestone: exercises asset + Blender integration without
   waiting for video reconstruction.
2. **3.2 `frame_extraction`** — video segments → frames with PTS
   timestamp provenance.
3. **3.3 `camera_calibration`** — estimated from real data or explicitly
   labelled `factory_assumed`.
4. **3.4 `visual_tracking` AND/OR COLMAP-native feature matching and pose
   estimation** — two declared alternative paths (see
   `docs/STAGE3_DEPENDENCY_MAP.md`); they are alternatives, not a required
   sequence.
5. **3.5 `trajectory_generation` where required by the selected path** —
   mandatory on the OpenCV-assisted path; not required on the COLMAP-native
   path.
6. **3.5 `pointcloud_reconstruction`** — the only operation that turns
   capture into genuine geometry; the record states which path produced it.
7. **3.6 `pointcloud_registration`** — align ≥2 compatible genuine point
   clouds.
8. **3.6b `pointcloud_fusion`** — fuse sources with valid registration
   provenance.
9. **3.7 `mesh_reconstruction`** — valid genuine cloud → `MSH-`.
10. **3.7b `geometry_validation`** — computed VAL- checks on any genuine
    geometry asset, wherever required to reject invalid or unreliable
    output.
11. **3.8 `tunnel_axis_extraction`** — genuine geometry → axis polyline.

Geometry validation applies at every stage where an output must be checked
before it is trusted. Cross-section and convergence analysis remain Stage 4.

**First implementation direction (Stage 3.1 onwards):** start with
`pointcloud_import`, then `frame_extraction`, then a genuine COLMAP-based
video-to-point-cloud workflow (Path B) — COLMAP performs its own feature
extraction, matching, bundle adjustment and reconstruction, so no OpenCV
typed trajectory is needed first. OpenCV stays in the stack for calibration
and the alternative Path A tracking workflow. Do **not** start with mesh
reconstruction.

## 3. Device verification versus software development — final policy

**Stage 3 software development may proceed without physical-device
verification.** A physical device is **not** a prerequisite for writing,
testing or advancing Stage 3 code.

Physical-device capture verification remains a **deferred acceptance
requirement**: before phone-derived results can be trusted as validated
operational mining data, the relevant camera, sensor, timing, recording,
interruption and storage behaviours must be verified on real supported
devices (`docs/hardware-verification.md`).

Consequently:

- Do not require a physical device as a prerequisite for Stage 3 software
  development.
- Do not claim that device-dependent behaviour has been verified when it
  has not.
- Software tests are not proof of real-world camera or sensor performance.
- Phone-derived measurements are never presented as professionally
  validated.

Stage 3 software may be developed and tested using:

- genuine existing recordings (Stage 2 output files as data);
- documented public datasets with appropriate licensing;
- genuine external point-cloud files (import path);
- test fixtures containing real, properly sourced geometry;
- synthetic test data **only** when explicitly labelled synthetic in the
  test/fixture itself, used solely for software testing, never presented as
  real mining output.

## 4. 8 GB workstation discipline (all Stage 3 operations)

- Chunked point-cloud processing; no "load everything into RAM".
- Configurable frame extraction rates and point limits.
- Streaming file processing where practical; incremental processing.
- Temporary-file cleanup; processing cancellation; recovery after
  interruption.
- Clear storage requirements documented per operation.
- Any quality-reducing adjustment (resolution, point caps, mesh resolution)
  is **recorded in the operation record's `settings`**, never applied
  silently. When a job exceeds the workstation's practical capability, that
  is documented, not hidden.

The library evaluation (`docs/STAGE3_LIBRARY_EVALUATION.md`) proposes a
minimal stack — **five functional groups, six named tools/packages**:
FFmpeg; OpenCV; COLMAP/pycolmap; Open3D; laspy + lazrs — with 8 GB
feasibility notes per candidate. None of it is verified until
`docs/STAGE3_COMPATIBILITY_MATRIX.md` is run on the target machine.

## 5. Blender 5.1 integration plan (documentation stage; see
`docs/blender-extension.md`)

- Imported / reconstructed / fused point clouds and mesh assets open in
  Blender via PLY/OBJ; LAS/LAZ via a small scripted importer or PLY
  conversion at import time.
- Panels will eventually show asset metadata, operation provenance and
  scale status, and operators for import/axis visualisation — each operator
  flips from WARNING+CANCELLED to working only when its registry operation
  is IMPLEMENTED. The current metadata-loading functionality is preserved.

## 6. Gates before Stage 3 *output* is trusted

1. Library choices confirmed at implementation time; exact versions recorded
   in operation provenance.
2. No accuracy claims without measurement: residuals may be reported
   (computed); "accuracy in cm" may not, until a documented experiment on
   real data with ground truth says otherwise.
3. Scale stays RELATIVE/UNKNOWN until a genuine metric basis is fused in;
   operator-assumed scale is ESTIMATED at best and must be shown as such in
   any UI.
4. Every asset traceable to source ids, method, tool version, scale basis
   and validation status.

## 7. Deliberately out of Stage 3 scope

- Cross-section and convergence analysis (Stage 4).
- Geographic referencing (banned without an explicit stored transform).
- Breaking changes to capture identifiers, DB migrations or schemas.
- Cloud services, paid APIs, ML-framework-heavy pipelines.

## 8. Open questions for Stage 3 implementation planning

- How large can a single fused cloud grow before chunk boundaries (per
  capture segment) must become user-visible?
- LAS/LAZ CRS metadata — **resolved (Stage 3.0): record the limitation and
  warn; never silently reproject or invent a CRS.** Missing or uncertain
  coordinate metadata is carried on the asset record and surfaced in the
  UI.
- Axis polyline asset format and id prefix (Stage 3.8 decision).
