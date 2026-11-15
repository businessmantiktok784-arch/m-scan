# Calibration provenance — where parameters may come from, and what they may claim

A `CAL-` record carries exactly one `source`/`calibration_method` pair and
a `validation_status`. These fields are a promise about **how the numbers
were obtained**; the zod schema (and the JSON schema mirror) enforces
which combinations exist. This document is the readable contract.

## The three declared sources

**Method A — estimated from capture** (implemented, Stage 3.3):
`source: "estimated_from_capture"`,
`calibration_method: "known_target_checkerboard"`. The images were real
extracted frames of a printed checkerboard; the parameters come from the
solver in this repository. The record carries:

- `engine` — `tool: "mining-scanner calibration core (pure TypeScript
  Zhang)"`, `tool_version` = the **real app version** of the host, and a
  `note` stating OpenCV is NOT available in this environment and the
  result is not independently validated.
- `metrics` — frame arithmetic, RMS, per-image errors, convergence,
  coverage note (see [calibration-quality.md](calibration-quality.md)).
- `target_config` — the declared board (corner counts, square size +
  unit, identification string as entered by the operator).
- `source_frame_ids`, `source_video_asset_ids` — exact inputs.
- `frame_evaluations` — per-image suitability with reasons.

**Method B — factory parameters**: `source: "factory_assumed"`,
`calibration_method: "factory_assumed"`, with a mandatory
`factory_provenance` block (device/model, where the values were
published, their units). Factory values are **never** labelled as
measured: the schema forces `validation_status: "not_evaluated"` and the
registry declares the failure mode `factory_values_unavailable` for when
no published parameters exist. No factory-provenance path is wired into
the mobile UI yet; the contract exists so that when it is, the record
cannot lie about its origin.

**Method C — operator-imported parameters**: `source: "operator_provided"`,
`calibration_method: "imported"`, with a mandatory `import_provenance`
block (originating tool/model, checksum of the imported file). Same rule:
imported numbers keep `validation_status: "not_evaluated"` until they are
independently checked.

## Validation status — the ladder that cannot be climbed silently

`"not_evaluated"` → `"passed_configured_checks"` /
`"did_not_pass_configured_checks"` → `"independently_validated"`.

- Computed records may only carry the middle two: the **schema refine
  rejects** `independently_validated` on any record whose source is
  `estimated_from_capture` — a solver agreeing with itself is not
  independent validation. The only path to `independently_validated` is a
  targeted measurement campaign against external ground truth, which is
  **not implemented**.
- `"not_evaluated"` is the factory/import state: nobody has checked
  these numbers against anything.

## Scale and coordinate claims

- `scale_status: "UNKNOWN"`, `scale_provenance.basis: "none"` on **every**
  calibration record, with the standing detail text: calibration fixes
  intrinsics in pixels; the target's square size unit is the operator's
  declared unit and never propagates to a scene-scale claim. The schema
  rejects any other basis on a calibration record (test enforced).
- `coordinate_convention` states the fixed convention verbatim (OpenCV
  pinhole, x right / y down / z forward, row-major K, distortion
  `[k1,k2,p1,p2,k3]`).

## Lifecycle and audit trail

- The run is registered **before** any image is decoded
  (`processing_operations` + `camera_calibrations`, status `running`,
  settings + target draft in `meta_json`). Failures, cancellation and
  crash reconciliation (`interrupted`) are all recorded states — an audit
  sees attempted runs, not only successes.
- Environment gates (`output_exists`, `insufficient_storage`) fire before
  registration; content failures (`insufficient_images`,
  `all_frames_rejected`, …) register then `markFailed` with the machine
  reason — the deliberate distinction: an environment problem prevented
  the run; a content problem is a run that happened and failed.
- Success flips the run and writes the `assets` row in **one
  transaction**; the run row keeps the full record in `meta_json` and its
  own lifecycle status (`done`), separate from the record's
  `calibration_status` (`computed` / `computed_with_warnings`).
- `operation_id` equals `calibration_id`: one registry operation per run,
  joinable in `processing_operations` with tool identity, timings and the
  output asset id.
