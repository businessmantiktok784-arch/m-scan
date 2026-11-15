# Camera models — conventions and the on-device solver

Binding conventions for every camera-geometry record in this repository
(calibration, tracking, reconstruction). These are fixed; producers and
consumers must not improvise alternatives.

## Intrinsics K

Row-major 3×3, pixels:

```
K = | fx   0   cx |
    |  0  fy   cy |
    |  0   0    1 |
```

- `fx, fy` — focal lengths in **pixels** (x and y axis respectively; the
  solver allows fx ≠ fy).
- `cx, cy` — principal point, pixel coordinates, origin at the top-left
  corner of the image, x right, y down.
- Image dimensions are recorded with the intrinsics; a K without its
  width/height context is incomplete.

## Distortion

OpenCV ordering on normalized coordinates:

```
[k1, k2, p1, p2, k3]
```

i.e. radial `k1, k2, k3` (with `k3` explicitly present and exactly 0 when
not estimated — no variable-length ambiguity) and tangential `p1, p2`.
The record's `model` field names the coefficient set; the only model this
solver emits is `opencv_radial_tangential_k1_k2_p1_p2_k3`. Point
projection applies distortion to normalized coordinates before scaling by
`fx, fy` — see `distortNormalized` in `src/calibration/camera-model.ts`
(exact rational radial form, tangential term included).

Coordinate frame: **x right, y down, z forward from the camera**
(OpenCV pinhole convention). Camera poses derived here (per-view target
poses) use the same frame via Rodrigues `rvec` + translation `tvec`.

## The solver (pure TypeScript Zhang)

`src/calibration/zhang.ts` implements Zhang's 2000 method end to end:

1. **Per-view homography** — world-board-plane → image correspondences
   solved by DLT (`estimateHomography`, returns H normalised `H[8]=1`).
2. **Closed-form intrinsics** — the standard two-constraint-per-homography
   v-vector formulation over all views; the symmetric-matrix
   smallest-eigenvector problem is solved with a two-sided symmetric
   Jacobi rotation (the v-vectors pair the first two *columns*
   componentwise, per Zhang's appendix B).
3. **Distortion initialisation** — linear solve of the radial/tangential
   coefficients from the per-view reprojection residuals
   (`initDistortion`).
4. **Joint Levenberg–Marquardt refinement** — intrinsics (5), distortion
   (5) and 6 DOF per view, minimising total corner reprojection error.
   The Jacobian is stored column-wise per parameter, so the normal
   equations `JᵀJ` and `Jᵀr` accumulate over residuals without
   conflating residual and parameter indices.
5. **Diagnostics** — RMS and per-image reprojection errors, convergence
   flag, target-pose-orientation clustering (see
   [calibration-quality.md](calibration-quality.md)).

Degenerate inputs (all target planes parallel / insufficient pose
variation) return failure, not zeros: the caller reports
`degenerate_target_layout`.

## Working scale and rescaling

Frames may be decoded at a reduced working scale (`max_working_dimension_px`)
to bound memory. All accepted views must share **one** factor
(`working_scale_mismatch` otherwise). Intrinsics recovered at working
scale are rescaled to full-resolution pixels by **multiplying** `fx, fy,
cx, cy` by the factor; distortion coefficients are dimensionless and
unchanged; the factor is written to `calibration-log.json`
(`working_downscale_factor`). Silent rescaling is impossible — the number
is in the log and the full-resolution dims are in the record.

## COLMAP compatibility

The exact conversion contract to/from COLMAP camera models (which fields
map, which conversions are refused and why) is in
[colmap-camera-compatibility.md](colmap-camera-compatibility.md). Short
version: `OPENCV` ⇄ this model is exact; `SIMPLE_PINHOLE`, `PINHOLE`,
`SIMPLE_RADIAL`, `RADIAL` are accepted one-way into the app's model when
their coefficient sets are subsets; anything with `k3 ≠ 0` from other
models, or an `unspecified` model, is refused — never approximated.
