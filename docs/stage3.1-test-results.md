# Stage 3.1 — test results

Run 2026-11-06 in the Rork Linux sandbox (no device, no Blender, no Xcode).

## Executed here — all green

| Suite | Command | Result |
|---|---|---|
| Mobile (bun) | `cd mining-scanner && bun test tests/mobile` | **140 pass / 0 fail** (546 assertions, 5 files) |
| Python | `python3 -m unittest discover -s tests/python` | **57 tests, OK** |
| Type/structure checks | `runChecks` appPath `mining-scanner` | **passed, no errors** |

Coverage highlights (new in Stage 3.1):

- PLY validator: ascii + binary-LE fixtures, colours/normals/faces, big-endian
  rejection, vertex-not-first rejection, truncation → `incomplete`, 1-byte
  chunk header handling, cancellation, bytesExamined accounting.
- XYZ validator: parse errors, non-finite counting, colour-ambiguity warning.
- LAS validator: header/VLR checks, LAZ rejection, truncation → `incomplete`.
- Import lifecycle against real SQLite (bun:sqlite): begin → succeed
  (atomic assets insert), fail/cancel paths, stale-import reconciliation,
  failed imports never leaving an assets row.
- Contracts: pointcloud-asset v1.3 widening, import records, tool identity.
- Blender parser + sidecar reader against the same fixtures; add-on honesty
  (PLY-only operator, stub kept, manifest version).

## NOT executed here — operator acceptance required

| Check | Why | Where |
|---|---|---|
| On-device import end-to-end (picker → copy → validate → asset list) | No device/emulator in sandbox | Operator phone (Android/iOS build) |
| expo-document-picker behaviour on real Android/iOS (SAF/iCloud paths) | Sandbox cannot exercise system pickers | Operator phone |
| Large-file validation timing/memory on phone hardware (e.g. 500 MB PLY) | No phone hardware | Operator phone |
| Blender 5.1 add-on install + import operator | No Blender binary in sandbox | Operator machine |
| Real-world external files (vendor scanner exports) | Fixtures are synthetic with documented exact values; they prove parser logic, not real-world format variance | Operator machine |

Until those run, the correct claim is: **import is implemented and
unit/integration tested off-device; its behaviour on physical devices and
against real-world files is NOT YET VERIFIED.**
