# Stage 3.1 — External point-cloud import

Status: **IMPLEMENTED (software scope)** — `pointcloud_import` is the only
Stage 3 operation marked IMPLEMENTED in the operation registry. Device and
Blender verification are deferred to the operator machine (see
[stage3.1-test-results.md](stage3.1-test-results.md)).

Stage 3.1 lets an operator bring an externally produced point cloud
(drone survey, terrestrial scanner export, third-party processing) into a
project. The import never fabricates anything: coordinates are stored exactly
as they arrived, units are recorded as unknown unless the file documents them,
and a failed import never registers as an asset.

## What it does

1. **Pick** — the system document picker (no path guessing; the operator
   chooses the file explicitly). `.laz` is rejected immediately with an
   honest "unsupported on device" message.
2. **Preflight** — extension → format mapping, 2 GB byte-size cap
   (`file_too_large`), free-space gate (file size + 200 MB headroom,
   `insufficient_storage`).
3. **Register** — a `processing_operations` row (`running`) and a
   `pointcloud_imports` row (`importing`) are written BEFORE any bytes move,
   so a crash can be reconciled (see [pointcloud-storage.md](pointcloud-storage.md)).
4. **Copy** — the source file is copied unmodified into the project's asset
   directory. Originals are never touched.
5. **Validate** — streamed, chunked (1 MiB), cancellable validation of the
   preserved copy (see [pointcloud-validation.md](pointcloud-validation.md)).
6. **Finalize** — on `valid` / `valid_with_warnings` only: `asset.json`,
   `validation.json` and `import-log.json` are written atomically, then the
   `assets` row and the `succeeded` flip happen in ONE transaction. On any
   other verdict (or cancel/error) the temporary directory is deleted and
   nothing is registered.

## Provenance and honesty guarantees

- `coordinate_units` is always `"unit_unknown"` for imports. No supported
  format carries unit metadata this importer can verify (LAS scale factors
  depend on the CRS, which is not self-describing).
- `coordinate_convention` is `"source_documented"`: coordinates are stored
  as-is; the app asserts no axis mapping onto its own convention.
- `scale_status` is always `"UNKNOWN"` with basis `"none"` and an explicit
  detail string: imported coordinates must never be treated as metric survey
  data until an independent scale basis is documented.
- `original_filename` preserves the name the file arrived with.
- `content` records only file-documented facts: coordinate properties found
  in the header, presence of colours/normals, and a CRS string if (and only
  if) the file declared one.
- Tool identity in the operation row comes from the real app version
  (`Constants.expoConfig?.version`); an unknown version is recorded as
  `"unknown"`, never invented.

## Verdict → outcome mapping

| Validation verdict | Outcome |
|---|---|
| `valid`, `valid_with_warnings` | Asset registered (validation `pass` / `warn`) |
| `invalid` | Import failed, directory cleaned, nothing registered |
| `unsupported` (incl. LAZ, big-endian PLY) | Import failed with `unsupported_variant` |
| `incomplete` (truncated file) | Import failed with `incomplete` |
| Operator cancel | Distinct `cancelled` outcome; op row `cancelled` |
| App killed mid-import | Reconciled to `interrupted` on next launch |

## UI

The Media & Export tab carries an import card (stage label, progress bar,
cancel button) and expandable point-cloud asset rows showing the real
metadata: format, byte size, point count, units, scale status, CRS, verdict
and original filename. Export remains PLANNED and is labelled as such.

## Out of scope (Stage 3.2+)

Tracking, registration, reconstruction, meshing, analysis — all still
NOT_IMPLEMENTED in the registry. Import only brings data in; it does not
process it.
