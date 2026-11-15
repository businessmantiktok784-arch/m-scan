# Tracking / registration evaluation — Stage 2 conclusion

The master plan places "frame registration / SLAM behind the engine seam" in
the capture-and-registration stage. This document records the evaluation of
candidate approaches against the project's constraints, and the decision:

**Visual tracking is NOT IMPLEMENTED in Stage 2.** The app records genuine
camera video and motion-sensor samples — the *inputs* a future tracking
stage would consume — and produces no poses, trajectories, calibration or
reconstructed geometry. `trackingStatusSchema` enforces this: every field is
the literal `"NOT_IMPLEMENTED"`, and any future implementation requires a
deliberate schema change.

## Constraints (from the master prompt)

1. Offline only — no cloud, no paid APIs.
2. Expo managed workflow for the app itself; no custom native modules yet.
3. Modest hardware: mid-range phones, 8 GB dev machines.
4. Honesty: no accuracy claims, no fabricated outputs, ever.

## Candidates evaluated

| Candidate | Verdict | Why |
|---|---|---|
| **ARKit / ARCore visual-inertial odometry** | Rejected for Stage 2 | Requires native modules (AR via Expo can only approximate); poses would come from a black box, undermining the honesty rule (we could not document how they were derived); ARKit also needs Apple hardware verification we cannot run here. Remains a candidate for a later native stage, with its provenance documented. |
| **JS/TS visual SLAM in the React Native JS thread** (ORB-SLAM-style port) | Rejected | JS thread cannot sustain real-time feature tracking; porting/maintaining a SLAM pipeline in TS is high-risk, and any accuracy claim would be unverifiable on our budget. |
| **Cloud / server reconstruction** | Rejected outright | Violates the offline-only constraint. |
| **Offline offline post-hoc registration from recorded segments** (e.g. run a desktop pipeline later on exported data) | Deferred, plausible | The Stage 2 recordings (segmented muted video + timestamped IMU JSONL) are exactly the input such a pipeline needs. The dual-clock timestamp rules in `docs/capture-pipeline.md` exist to keep this door open. Nothing is promised. |
| **Raw frame streaming from the camera** | Not possible in Stage 2 | Expo's managed `CameraView` does not expose raw frames. `expo-camera` supports recording compressed segments only. A native module (or `expo-camera` frame callbacks if upstream adds them) is a **documented requirement** for any frame-level tracking stage. |

## What Stage 2 delivers toward a future tracking stage

- Synchronized-recording discipline: every camera segment and sensor sample
  carries `epoch_ms` + `monotonic_ms` from the same clock pair.
- Clean session directories with checksums and manifests, ready to be
  consumed by an offline registration pipeline.
- An explicit machine-readable record (`schemas/tracking-status.schema.json`)
  that downstream consumers can check instead of trusting marketing.

## Re-opening this decision

Any future tracking work must: (1) change `trackingStatusSchema` explicitly,
(2) document the chosen method and its provenance, (3) validate accuracy
claims on real captured data with recorded evidence, and (4) pass the
device-verification checklist first. Until then the tracking status stays
`NOT_IMPLEMENTED` — in schemas, in code, and in the UI.

## Stage 2.1 addendum — contracts fixed, decision unchanged

The Stage 2.1 audit added the Stage 3 data contracts (zod in
`src/models/reconstruction.ts`, JSON Schemas in `schemas/`:
frame-extraction, camera-calibration, tracking-result,
registration-operation, geometry-validation) and the operation registry
(`src/engine/operations.ts`, all reconstruction operations
NOT_IMPLEMENTED). These contracts encode the evaluation's conclusion:

- The registration/tracking host is **offline desktop** (Blender/Python on
  the operator's workstation): Expo cannot stream raw frames, JS cannot
  sustain real-time SLAM, and cloud reconstruction is banned. The registry's
  `host` field records this per operation.
- Trajectories carry per-pose `inlier` flags and the result carries
  `scale_status`; monocular tracking alone can never claim better than
  RELATIVE scale.
- Scale provenance is enforced: UNKNOWN pairs with basis `none`; any claimed
  scale needs a documented real-world basis.

The decision itself is unchanged: nothing tracks, registers or reconstructs
until a deliberate, documented implementation exists.

## Stage 3 planning correction — responsibilities separated

The planning correction split the deprecated `frame_registration` bundle
into distinct operations, which sharpens this document's conclusions:

- **`visual_tracking`** owns feature detection, matching, camera-motion
  estimation and tracking-loss recording — output: `TRK-` result, at most
  RELATIVE scale.
- **`trajectory_generation`** owns the ordered `TRJ-` camera trajectory,
  with explicit coordinate frame and PTS-based timestamp provenance.
- **`pointcloud_registration`** consumes only genuine point clouds —
  camera poses are structurally not registration inputs.
- **`pointcloud_reconstruction`** (new) owns turning frames + calibration +
  trajectory into genuine geometry. Frames and trajectories are not point
  clouds; the evaluation table above remains the reason this runs offline on
  the desktop (pycolmap/Open3D, see `docs/STAGE3_LIBRARY_EVALUATION.md`).

Trajectory scale rules are enforced in the contracts: monocular motion is
never metric, `operator_assumed` scale is ESTIMATED at best, and VALIDATED
requires independent metric evidence.
