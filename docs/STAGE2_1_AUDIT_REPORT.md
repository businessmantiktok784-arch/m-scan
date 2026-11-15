# Stage 2.1 — Audit report

**Scope:** verify the actual source against the Stage 1 and Stage 2 reports,
correct the record, remove dead code, and define the Stage 3 reconstruction
contracts — without starting Stage 3.

**Method:** every file in `mining-scanner/` was inventoried and the claims in
`STAGE1_REPORT.md` and `STAGE2_REPORT.md` were checked against source, not
taken on trust. References for every deletion were re-checked with a full
search before removal.

**Environment:** Linux sandbox. No physical device, emulator, Xcode or
Blender binary — all hardware checks remain deferred (see Deferrals).

---

## 1. Verdict

**Stage 2.1 status: COMPLETE (software scope).** All findings were either
fixed, documented, or explicitly deferred; all test suites pass; type and
build checks are clean.

## 2. Classification of the existing codebase

| Area | Files | Classification |
|---|---|---|
| Capture core (state machine, time, recorder, manifest) | `src/capture/*` | **IMPLEMENTED** (software-verified; device behaviour deferred) |
| Storage (session tree, atomic writes, JSONL appender) | `src/storage/session-store.ts` | **IMPLEMENTED** (software-verified) |
| Database (WAL/FK, migrations v1–v2, repositories) | `src/database/*` | **IMPLEMENTED** (verified against `bun:sqlite`) |
| Capability probing | `src/services/capabilities.ts` | **IMPLEMENTED** (5 explicit states) |
| Screens (Projects / Live Scan / Review / Export) | `app/(tabs)/*` | **IMPLEMENTED** (real data, no placeholders) |
| Pure models | `src/models/*` | **IMPLEMENTED** |
| Engine seams | `src/engine/*` | **PARTIALLY_IMPLEMENTED** — capture is real; processing is interfaces + explicit unavailable stubs |
| Reconstruction pipeline | frames, calibration, tracking, registration, meshing | **NOT_IMPLEMENTED** — contracts only (this stage) |
| Export file writers | PLY/OBJ/… | **NOT_IMPLEMENTED** — `PLANNED_EXPORT_FORMATS` labels are honest |
| Blender add-on | `blender/addons/mining_scanner_tools` | **PARTIALLY_IMPLEMENTED** — metadata loader works; import/analysis operators honest stubs; in-Blender verification deferred |
| Template leftovers | `app/modal.tsx`, `constants/colors.ts` | **STUB** (template code) — **removed** (§4) |
| `app/+not-found.tsx`, `app/+native-intent.tsx` | framework files | kept (expo-router conventions) |

## 3. Problems found in the Stage 1/2 documentation vs source

1. **Operation registry stage errors (fixed).** `docs/data-exchange.md`
   assigned `pointcloud_import` and `frame_registration` to Stage 2. Nothing
   in Stage 2 implements them — Stage 2 delivers capture only. Both are
   corrected to Stage 3. `frame_extraction` and `camera_calibration` were
   added as explicit Stage 3 operations so the pipeline has complete, named
   steps. No identifier was removed or renamed → no data migration needed.
2. **Stale schema count (fixed).** `docs/data-exchange.md` said "the six
   files in `schemas/`"; there were already 11 after Stage 2, now 16.
3. **Misleading engine stub text (fixed).** `unavailableScannerEngine`'s
   status claimed capture "arrives in later stages"; Stage 2 capture is real.
   The text now states what works and what does not.
4. **Dead engine code (removed).** `ScanAssetStore` / `unavailableAssetStore`
   had zero references (real storage is `src/storage/session-store.ts`) and
   carried a stale "(Stage 2)" message. Removed; justified here rather than
   silently.
5. **Template leftovers (removed).** `app/modal.tsx` (example modal, only
   referenced by its own `Stack.Screen` entry, now removed too) and
   `constants/colors.ts` (unreferenced template theme; the app uses
   `src/theme`). Zero feature code referenced either.

## 4. Changes made in Stage 2.1

**Added**
- `src/engine/operations.ts` — machine-readable operation registry (single
  source of truth: id, stage, status, inputs/outputs, host, requirements)
  with `assertOperationImplemented()` as the loud guard for future entry
  points.
- `schemas/operations.registry.json` — JSON mirror of the registry; test-
  enforced to stay identical to the TypeScript source.
- `src/engine/reconstruction.ts` — Stage 3 seams (frame extractor, camera
  calibrator, tracker, registrar, mesh reconstructor, validator); the only
  implementation rejects every call.
- `src/models/reconstruction.ts` — pure zod contracts: frame extraction
  jobs/frames, camera calibration, tracking result + trajectory, registration
  operation, geometry validation, scale status/provenance.
- `schemas/frame-extraction.schema.json`, `camera-calibration.schema.json`,
  `tracking-result.schema.json`, `registration-operation.schema.json`,
  `geometry-validation.schema.json` — the referee documents for the above.
- `tests/mobile/reconstruction.test.ts` (27 tests) and
  `tests/python/test_stage2.py` (11 tests).

**Modified**
- `schemas/pointcloud-asset.schema.json` → **v1.1**: optional
  `source_session_ids`, `checksum_md5`, `provenance`, `scale_status`,
  `scale_provenance`, `validation`. Backward compatible (v1 documents remain
  valid); mirrored in `src/models/models.ts`.
- `src/engine/interfaces.ts` — dead store removed, engine text updated.
- `app/_layout.tsx` — template modal route entry removed.
- Docs: `data-exchange.md` (registry + schema inventory), `architecture.md`,
  `capture-pipeline.md` (frame-timestamp limitation consequence),
  `tracking-evaluation.md` (Stage 2.1 addendum: offline-desktop host,
  scale rules), `blender-extension.md`, `README.md`, `PLAN.md`.

**Removed**
- `app/modal.tsx`, `constants/colors.ts`,
  `ScanAssetStore`/`unavailableAssetStore` (dead code; §3).

## 5. Scale honesty (contract, enforced by tests)

`scale_status` is one of `UNKNOWN / RELATIVE / ESTIMATED / VALIDATED` with
mandatory provenance. The zod refinement rejects UNKNOWN paired with a real
basis, and any claimed scale paired with basis `none`. Monocular tracking
alone can never claim better than RELATIVE. No metre figure exists anywhere
in the codebase.

## 6. Test results (this stage)

| Suite | Result |
|---|---|
| `bun test tests/mobile` | **77/77 pass** (50 prior + 27 new) |
| `python3 -m unittest discover -s tests/python` | **23/23 pass** (12 prior + 11 new) |
| `runChecks` (typecheck + build) | clean |

New tests cover: schema/registry cross-consistency (TS ↔ JSON), the stage
corrections, scale-provenance honesty refinements, all reconstruction
contracts (valid + rejected shapes), pointcloud v1.1 backward compatibility,
unavailable-seam rejection behaviour, Blender add-on compilation, and the
no-IMPLEMENTED-claims honesty rule.

## 7. Deferrals (not run in this sandbox, unchanged from prior stages)

- On-device capture verification — `docs/hardware-verification.md` Part 1b
  (needs a physical device).
- iOS build/capture verification (needs macOS/Xcode).
- Blender install + in-application verification (needs Blender binary on the
  operator machine).
- Any reconstruction accuracy evaluation — impossible until Stage 3 produces
  real output.

**No physical-device, emulator or hardware-accuracy testing was performed or
claimed in Stage 2.1.**
