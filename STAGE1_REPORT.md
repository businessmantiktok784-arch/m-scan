# Stage 1 Report — Underground Mining Scanner

Date: 2026-11-05 · Platform: Expo/React Native (TypeScript) + Blender extension
Verification environment: Linux sandbox (Node 24 / bun 1.4 / Python 3.13).

**No physical Android device, Android emulator, iOS simulator or Blender
binary exists in this environment.** Hardware-dependent checks below are
marked NOT TESTED or BLOCKED — never inferred. Every result is one of
PASS / FAIL / BLOCKED / NOT TESTED.

---

## A. Mobile application

| Check | Result | Evidence |
|---|---|---|
| Install & launch Expo dev build on a physical Android device | **NOT TESTED** | No device or emulator in sandbox. Operator: run the exact commands in `docs/hardware-verification.md` Part 1 (`bunx expo run:android --device`)
| All four tabs render (Projects / Live Scan / Review / Media & Export) | **NOT TESTED** on device. Web preview confirms first render of the Projects screen and tab bar only (screenshot in chat history); SQLite does not open on web by design | Static review: all four screen files exist and are registered in `app/(tabs)/_layout.tsx` |
| Create multiple projects; SQLite persistence across app restart | **NOT TESTED** (needs device). SQL and migration logic verified off-device instead — see section B | — |
| Project creation with empty name | **PASS** (code + schema level, off-device) | Create button is disabled when the trimmed name is empty (`disabled={!name.trim() \|\| busy}`, fixed this pass — it previously only dimmed); schema rejects `""` (test `rejects an empty name`) |
| Project creation with long names | **PASS** (off-device) | Input capped at `maxLength={80}` (added this pass); schema accepts 80, rejects 81 (test `accepts an 80-character name and rejects 81`) |
| Project creation with special-character names | **PASS** (off-device) | Unicode/special-char test passes (`accepts special characters and unicode names`) |
| Duplicate project identifiers | **PASS** (off-device SQL level) | `project_id` is PRIMARY KEY; duplicate insert rejected by SQLite (test `duplicate project identifiers are rejected by the primary key`). IDs are `crypto.randomUUID()`-derived — collision practically impossible |
| Database error handling | **PASS** (code review) | Screens wrap repository calls in try/catch → `Alert.alert("Database error", …)`; errors never crash the app |
| Offline usability | **PASS** (by construction; **NOT TESTED** on device) | All storage is local SQLite; no network code exists anywhere in `src/` |
| Loading / empty / error states | **PASS** (code review) | Spinner while loading; honest "No projects yet" empty state; Alert on error. **Device confirmation NOT TESTED** |
| No screen claims scanning/processing is implemented | **PASS** (code review) | Live Scan shows "SCANNING ENGINE NOT IMPLEMENTED — STAGE 1" and UNKNOWN capability verdicts; Review shows "3D viewer — not implemented yet"; Export labels every format PLANNED. Grep found no simulation/claim language |

## B. Database and data integrity

| Check | Result | Evidence |
|---|---|---|
| Migrations run correctly on a fresh installation | **PASS** off-device (bun:sqlite, same engine family), **NOT TESTED** on device | `bun test tests/mobile` — `applies all migrations and records every version` verifies all 3 tables + 2 indexes + `_migrations` rows 1..5 |
| Migration idempotency (reopen applies nothing) | **PASS** (off-device) | test `re-running applies nothing new` |
| Interrupted-upgrade recovery | **PASS** (off-device) | test `resumes cleanly after a simulated interrupted upgrade`; each migration is transactional |
| Existing data intact after reopen | **NOT TESTED** (needs device restart cycle). Schema has no destructive statements; migrations are append-only CREATE IF NOT EXISTS | — |
| Foreign keys projects ↔ sessions | **PASS** (off-device) | test `foreign keys block sessions for unknown projects`; FK enforcement enabled via `PRAGMA foreign_keys = ON` on every open |
| Invalid records / malformed metadata | **PASS** (off-device) | Every write is zod-parsed before SQL; every project and session row read back is zod-parsed (session validation added this pass — `listSessions` previously skipped it). Corrupt statuses now fail loudly (silent "repair to active" removed this pass) |
| Deletion and recovery behaviour | **PASS** (off-device) | test `a project with session history cannot be silently deleted` — FK blocks non-cascading delete; no deletion UI exists in Stage 1 |
| Assets stored outside SQLite | Documented limitation (by design) | `assets` is an index; files live on disk under the project directory. A deleted file leaves a stale index row — no file-existence reconciliation exists in Stage 1. Recorded in `docs/data-exchange.md` |

## C. Blender 5.1 extension

| Check | Result | Evidence |
|---|---|---|
| Install & enable via documented procedure | **NOT TESTED** — BLOCKED on operator hardware | No Blender binary in sandbox. Operator: follow `docs/blender-extension.md` on Windows with Blender 5.1 |
| Panels appear (Mine Scanner tab) | **NOT TESTED** (needs Blender). Static guarantee: property registration happens inside `register()` only, after the PropertyGroup class exists | Code review + `test_addon_python_compiles` |
| Loading valid project metadata | **PASS** (parser level, off-device) | `python3 -m unittest discover -s tests/python` — 12 tests OK, incl. `test_valid_project_is_accepted` |
| Missing files / malformed JSON / missing fields / wrong schema version | **PASS** (parser level, off-device) | Parser raises `ProjectMetadataError` for each case; operators surface it as a Blender WARNING. Automated: `test_missing_fields_are_refused`, `test_bad_timestamp_is_refused`, `test_wrong_schema_version_is_refused`, `test_empty_name_is_refused`, `test_bad_project_id_is_refused`. (Missing-file path in `operators.py` is code-reviewed; the file-open branch itself needs Blender — NOT TESTED) |
| Import Scan / Analyse Mesh stay unavailable | **PASS** (code review) | Both operators return `{"CANCELLED"}` with a WARNING naming the planned formats; labels say "not implemented" |
| Enable/disable without registration errors | **NOT TESTED** (needs Blender) | register/unregister reviewed; legacy bl_info present for the extension system |

## D. Shared contracts

| Check | Result | Notes |
|---|---|---|
| Six JSON Schemas vs TypeScript (zod) models | **PASS** (manual field-by-field comparison) | Field names, required/optional (JSON `required` ⇔ zod non-`.default()`), enum values, ID regexes (`MS-`/`SES-`/`PC-`/`MSH-`/`OP-` + 8 hex), literal coordinate convention strings, and ISO-8601 timestamps (zod `datetime({offset:true})` ⇔ schema `$defs.timestamp`) all match |
| Blender parser field names/units | **PASS** | `core/project_meta.py` validates exactly the v1 `project-metadata` contract; project metadata carries no coordinates, so no unit fields exist at this level (units bind at asset level: `metre`, enforced by zod `z.literal` and JSON `const`) |
| Coordinate conventions | **PASS** | Identical literal string in zod, JSON Schema, and docs: `right-handed +X east +Y north +Z up, local origin` |
| Timestamps / identifiers / statuses | **PASS** | ISO 8601 UTC-or-offset everywhere; prefixes as above; status enums identical (`active`/`archived`; `planned`/`collecting`/`collected`/`aborted`; `queued`/`running`/`done`/`failed`/`cancelled`) |
| Mismatches found | **None** | No data contract was changed |

## Bugs found and fixed during this verification pass

1. **Missing Blender `core/` module — root cause found and fixed**: `core/__init__.py` and `core/project_meta.py` disappeared from the synced tree twice. Root cause: `mining-scanner/.gitignore` contained a bare `core` entry that silently excluded the directory from every sync. The ignore rule is removed, `__pycache__/`/`*.pyc` ignores added, stale bytecode untracked, and the module recreated. Verified un-ignored (`git check-ignore` exit 1) and by the suite returning to 12/12.
2. **Web-preview crash** (`window is not defined` from `expo-sqlite/web/worker.bundle`): expo-sqlite was imported at module top level. Now lazily `require`d on native only; web raises an honest "requires a native build" error instead of crashing the bundle.
3. **Create button not disabled** on empty name: dimmed only, still dispatched an invalid create. Now `disabled`.
4. **Missing input caps**: name/site/notes inputs now carry `maxLength` 80/120/2000 matching the schema limits.
5. **Silent data repair on read**: `rowToProject` coerced any unknown status to `"active"`. Now validates as-is and fails loudly on corrupt rows.
6. **Unvalidated session reads**: `listSessions` now zod-parses every row, matching the project read path.
7. **Migration logic was untestable off-device**: SQL and the transactional runner moved to pure `src/database/migrations.ts` with a thin expo-sqlite adapter; now verified against bun:sqlite (6 new tests).

## Exact commands and results (this environment)

```
cd mining-scanner
bun test tests/mobile                      # 22 pass, 0 fail (13 model + 6 migration + 3 name-edge)
python3 -m unittest discover -s tests/python   # 12 tests OK
runChecks (mining-scanner)                 # 0 tsc errors, 0 lint errors, 0 structure errors
```

Runtime logs from the Rork preview showed the `window is not defined` crash (bug 2 above); no other runtime errors were observed.

## Device / Blender versions used

- Physical Android device: **none available** — NOT TESTED.
- iOS device/simulator: **none available** — NOT TESTED (and requires macOS + Xcode for builds).
- Blender: **no binary available** — NOT TESTED. Verification must use Blender 5.1 on the Windows operator machine per `docs/blender-extension.md`.

## Hardware verification — operator runbook (PREPARED, awaiting results)

A complete, exact-command runbook for the Windows machine now exists at
**`docs/hardware-verification.md`**, covering: the Android dev build plus a
bundled release variant for the true offline test (`bunx expo run:android
--device`, `--variant release`), the A1–A11 device checklist (startup, four
tabs, three projects, persistence across restart, empty-name validation,
offline create, loading/empty states, logcat + screenshot capture), the
B1–B11 Blender 5.1 checklist (install, panels, valid / malformed /
missing-field / wrong-version fixtures, enable-disable cycle, console
registration check). Ready-made metadata fixtures live in `blender/fixtures/`.

**No results from these runbooks exist yet** — every hardware check stays
NOT TESTED until the operator records evidence with device model, Android
version and Blender version.

## Asset-index staleness — review and reconciliation proposal

The `assets` table indexes files that live on disk; a deleted file leaves a
stale index row, and Stage 1 has no reconciliation. A safe, non-destructive
approach is proposed and NOT implemented, pending approval: read-only
"FILE MISSING" marking at render time via expo-file-system; an explicit,
user-confirmed "Remove stale entry" action that deletes **only the index
row**, never a file; no background cleanup and no automatic data migration;
and write-side file+row pairing for future deletions so new staleness cannot
be introduced. Full text: `docs/hardware-verification.md` Part 3.

## Remaining blockers before Stage 2

1. On-device run of the Expo dev build: tab navigation, project creation, persistence across restart, offline behaviour — runbook ready (`docs/hardware-verification.md` Part 1).
2. Blender 5.1 install/enable, panel registration, enable-disable cycle, file-open error branches — runbook ready (Part 2).
3. No automated UI/e2e tests exist for the four screens.
4. Asset-index reconciliation is a documented proposal only; needs approval before any Stage 3 implementation.

## Stage 1 readiness recommendation

**Stage 1 is code-complete and statically verified (22 + 12 automated tests green, checks clean, contracts consistent), but hardware verification is NOT complete.** Do not proceed to Stage 2 until the on-device checklist (section A) and the Blender checklist (section C) pass on the operator's Windows machine and a physical Android device.
