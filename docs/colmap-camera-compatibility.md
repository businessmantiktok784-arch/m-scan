# COLMAP camera compatibility — exact conversions only

Stage 3 planning declared two reconstruction paths: `opencv_assisted`
(consumes `CAL-` + a trajectory) and `colmap_native` (COLMAP estimates
everything internally). When calibration data crosses into or out of
COLMAP, the conversion in `src/calibration/camera-model.ts`
(`opencvToColmap` / `colmapToOpencv`) applies. Rule: **convert exactly or
refuse** — approximating a camera model silently would poison
reconstruction provenance.

## App model → COLMAP

The app's model (`opencv_radial_tangential_k1_k2_p1_p2_k3`, parameters
`fx, fy, cx, cy, k1, k2, p1, p2, k3`) maps to COLMAP models:

| COLMAP model | Conversion | Condition |
|---|---|---|
| `OPENCV` | exact, all 8 params `[fx,fy,cx,cy,k1,k2,p1,p2]` | requires the app record's `k3 == 0` (COLMAP OPENCV has no k3) |
| `SIMPLE_PINHOLE` | exact downcast `[f, cx, cy]` with `f = (fx+fy)/2` | only when all distortion coefficients are exactly 0 |
| `PINHOLE` | exact downcast `[fx,fy,cx,cy]` | only when all distortion coefficients are exactly 0 |
| `SIMPLE_RADIAL` | exact downcast `[f, cx, cy, k1]` with `f = (fx+fy)/2` | only when `k2 == p1 == p2 == k3 == 0` |
| `RADIAL` | exact downcast `[f, cx, cy, k1, k2]` with `f = (fx+fy)/2` | only when `p1 == p2 == k3 == 0` |

Meaning of "exact": the parameter set maps 1:1 and the implied projection
function is identical. When `fx ≠ fy` and the target model has a single
`f`, the conversion averages **and the caller sees the collapsed focal**
— downstream records state the COLMAP model they received, so nothing is
hidden. If any condition fails, the conversion returns a refusal with a
reason (`k3 ≠ 0 cannot be represented in COLMAP OPENCV`; a nonzero
distortion cannot be dropped into a pinhole model) — it never zeroes
coefficients to force a fit.

## COLMAP → app model

`colmapToOpencv` accepts `SIMPLE_PINHOLE`, `PINHOLE`, `SIMPLE_RADIAL`,
`RADIAL` and `OPENCV` and produces the app's 5-coefficient form:

- `SIMPLE_PINHOLE`/`SIMPLE_RADIAL`/`RADIAL` supply a single `f`, which
  becomes `fx = fy = f` (still exact: the single-f models define fx=fy=f).
- `SIMPLE_PINHOLE`/`PINHOLE` imply zero distortion — the app record gets
  `[0,0,0,0,0]` explicitly (never an absent field).
- `SIMPLE_RADIAL`/`RADIAL` pad missing coefficients with exact zeros.
- `OPENCV` maps 8 params across and forces `k3 = 0` (documented in the
  record; the information difference is stated, not hidden).

## Refusals (hard, by design)

- A COLMAP camera with model `"unspecified"` — refused; there is no
  projection function to represent.
- A COLMAP model outside the five supported ones (e.g. `FULL_OPENCV`,
  `RATIONAL`, fisheye models) — refused; their extra coefficients have no
  honest mapping onto `[k1,k2,p1,p2,k3]`.
- An app record with `k3 ≠ 0` into `OPENCV` — refused (see table).

## Image dimensions

Both directions carry `width`/`height` alongside the parameters; a
camera whose recorded dimensions contradict the frames it will be applied
to fails validation (`validateIntrinsics`) rather than being applied with
a warning nobody reads.

## What this doc does not promise

COLMAP itself is **not available on device** (native binaries; see
`docs/STAGE3_LIBRARY_EVALUATION.md`). These converters make the app's
records *interoperable* with a desktop COLMAP workflow when that stage
arrives; they are tested against known-value round trips in the bun
suite.
