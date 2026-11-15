# Hardware verification runbook — Stage 1 (operator machine)

Everything in this file runs on the **operator's Windows machine**. Nothing
here has been executed in the build sandbox; record actual results only.
Classify every check **PASS / FAIL / BLOCKED / NOT TESTED** and paste evidence
(command output, screenshot, log excerpt) into `STAGE1_REPORT.md`.

Sample metadata files for the Blender tests are in
`blender/fixtures/` (valid, missing-fields, wrong-version, malformed).

---

## Part 1 — Android (physical device, real expo-sqlite)

### Prerequisites (Windows)

1. Node.js 20+ and [bun](https://bun.sh) on PATH.
2. Android Studio, with: Android SDK Platform 35, SDK Platform-Tools, and
   JDK 17 (Temurin 17 is fine). Expo SDK 58 requires JDK 17.
3. A physical Android device (Android 8+), USB cable.
4. On the device: Settings → About phone → tap **Build number** 7× →
   Developer options → enable **USB debugging**.

### Build & install

```bat
cd mining-scanner
bun install

:: confirm the device is visible
adb devices          :: (Android Studio's platform-tools must be on PATH)

:: compile the dev build, install it on the device, start Metro
bunx expo run:android --device
```

The first build takes several minutes (Gradle downloads dependencies). When
Metro is ready the app launches on the device automatically.

> **Offline note.** The dev build loads JavaScript from Metro over USB, so a
> dev build alone cannot prove offline behaviour. After the dev-build checks,
> also run the bundled release variant for the offline test:
>
> ```bat
> bunx expo run:android --device --variant release
> ```
>
> This bundles JavaScript into the APK; the app then runs with Metro stopped
> and the device in airplane mode.

### Evidence capture

```bat
:: runtime log (React Native JS + native crashes)
adb logcat -v time ReactNativeJS:V ReactNative:V AndroidRuntime:E > mining-scanner-logcat.txt

:: screenshots
adb exec-out screencap -p > 01-projects.png
```

### Checklist — mark each result and attach evidence

| # | Check | How | Result (PASS/FAIL/BLOCKED/NOT TESTED) | Evidence |
|---|---|---|---|---|
| A1 | App startup, no crash | Launch the app; watch `adb logcat` | | |
| A2 | Four tabs render and switch | Tap Projects / Live Scan / Review / Media & Export | | |
| A3 | Create three separate projects | New → name each (any names) → Create. Expect 3 cards, each with an `MS-` id and an "Initial session" chip in Review | | |
| A4 | Persistence after close & reopen | Swipe app away, reopen. All 3 projects still listed | | |
| A5 | Empty-name validation | New → leave name empty. Create button must be **disabled** (not just dimmed) | | |
| A6 | Long & special-character names | 80-char name accepted; 81 chars blocked by the field cap; unicode/emoji accepted | | |
| A7 | Offline project creation & viewing (release build) | `--variant release`, airplane mode ON, create a 4th project, browse tabs, reopen app | | |
| A8 | Loading and empty states | First launch shows spinner; with a cleared app (long-press → uninstall, reinstall) Projects shows the honest "No projects yet" card | | |
| A9 | Database error handling | There is no fault-injection UI, so on-device this is observable only via logcat on abnormal exit. Record what logcat shows; code-level error paths (Alerts) were verified by review | | |
| A10 | Honesty audit (Stage 1 baseline) | Review shows "3D viewer — not implemented yet"; Export shows PLANNED chips and creates no files | | |
| A11 | No errors in logcat during the whole session | Inspect captured log | | |

---

## Part 1b — Stage 2 capture (physical Android device first; iOS needs macOS/Xcode and is recorded separately)

Run the same build & evidence-capture steps as Part 1 (`expo run:android
--device`; a release build for the offline check). **A12–A14 use the
Expo Go-style dev build only if a dev build is what you have — capture must
be verified in the dev-build APK, not in the Expo Go client.**

| # | Check | How | Result (PASS/FAIL/BLOCKED/NOT TESTED) | Evidence |
|---|---|---|---|---|
| A12 | Capability probe is truthful | Live Scan on a phone with camera + IMU: camera AVAILABLE, accelerometer/gyroscope AVAILABLE. On a device lacking one, it must read UNAVAILABLE — never a guess | | |
| A13 | Permission flow | Deny camera permission → explanatory state with a retry. Set Deny & don't ask again in system settings → app shows a "grant in Settings" state, not a dead button | | |
| A14 | Real capture, 2 minutes | Select project → Start. REC badge with segment counter increments ~every 60 s; per-sensor sample counters increase continuously. Let it run ≥ 2 min | | |
| A15 | Pause / resume creates clean boundaries | Pause → segment + stream files close cleanly (no truncated JSONL line). Resume → new stream files appear; sample counters keep rising on top of old totals | | |
| A16 | Auto-pause on backgrounding | While capturing, press Home. On return: state = Paused, an interruption was counted, manifest contains an `app_backgrounded` warning | | |
| A17 | Stop produces complete session | Stop → state Stopped. Session dir contains session.json, manifest.json (final_state `stopped`), camera/ segments, sensors/ JSONL (valid JSON, one object per line), no `.tmp` leftovers | | |
| A18 | DB reflects reality | Review tab: the session shows real phase, active duration (monotonic), interruption count, segment/stream counts and total bytes that match the files on disk | | |
| A19 | Single-capture rule | (Requires two paths to start.) A second capture while one is active is refused by the DB guard — verify by inspecting logs/behaviour if reachable; otherwise mark NOT TESTED | | |
| A20 | Low-storage gate | (If safely freeable) free space below 200 MB → Start refuses with an explicit storage error. Otherwise NOT TESTED | | |
| A21 | Offline capture (release build) | Airplane mode ON, run a full capture, stop, restart app — all data intact, no network used (airplane mode throughout is the evidence) | | |
| A22 | Timestamps are dual-clock | Open a sensors/ JSONL file: each line has `epoch_ms` AND `monotonic_ms` + `monotonic_source`; delta_ms is plausible (≈ interval) and never negative | | |
| A23 | Audio is not recorded | Play a segment recorded while talking near the phone: no audio track (mute is a schema literal, verified on-device) | | |
| A24 | Manifest matches DB | manifest.json final_state/interruptions/warnings agree with the capture record shown in Review | | |
| A25 | No tracking claims anywhere | Live Scan limitation card states no poses/point clouds; export of recorded data lists real files only | | |

**iOS (B-series, requires macOS + Xcode on the operator side):** repeat
A12–A25 on an iPhone. Additional checks: camera permission prompt wording,
magnetometer availability (all iPhones have one), and backgrounding behaviour
(app switcher → Paused). Record results in STAGE2_REPORT.md the same way.

---

**Result of A9 will likely be NOT TESTED on-device** — that is an honest
limitation, not a pass.

---

## Part 2 — Blender 5.1 (Windows)

### Install

1. Install **Blender 5.1** from blender.org (or use the existing 5.1 install).
2. Zip the extension **contents** (the zip must contain `blender_manifest.toml`
   at its root):
   ```bat
   cd mining-scanner\blender\addons
   tar -a -c -f mining_scanner_tools-0.1.0.zip mining_scanner_tools
   ```
   (`tar -a -c` on Windows produces a zip from a folder.)
3. Blender → `Edit → Preferences → Get Extensions → ⌄ (top right) →
   Install from Disk…` → pick the zip. Enable the extension if not
   auto-enabled (Preferences → Add-ons → "Mining Scanner Tools").

### Checklist

| # | Check | How | Result | Evidence |
|---|---|---|---|---|
| B1 | Installation succeeds | Install from Disk; no error toast | | |
| B2 | Extension enableable | Toggle on in Preferences → Add-ons | | |
| B3 | Mine Scanner panels appear | 3D Viewport → `N` panel → "Mine Scanner" tab: Project, Project Info, Processing | | |
| B4 | Valid metadata loads | Load Project → `blender/fixtures/valid.miningscan.json`. Project Info fills in | | |
| B5 | Invalid JSON refused | Load `malformed.miningscan.json` → WARNING, no panel change, no crash | | |
| B6 | Missing fields refused | Load `invalid-missing-fields.miningscan.json` → WARNING naming the first missing field | | |
| B7 | Unsupported schema version refused | Load `invalid-schema-version.miningscan.json` → WARNING "unsupported schema_version" | | |
| B8 | Missing file handled | Point the file browser at a non-existent path / cancel → clean CANCELLED, no crash | | |
| B9 | Import Scan / Analyse Mesh stay unavailable | Click both: WARNING + CANCELLED, "not implemented" text | | |
| B10 | Enable/disable cycle clean | Toggle the extension off and on 3×; `Window → Toggle System Console` shows no registration errors or tracebacks | | |
| B11 | No registration errors in console | Same console check during install and all of the above | | |

---

## Part 3 — Asset-index reconciliation (review only, no action required)

**Known limitation.** The `assets` table indexes files that live on disk in
the project directory; Stage 1 writes no assets, so nothing can go stale
yet — but later stages must not let the index and the disk disagree
silently.

**Proposed approach (safe, non-destructive, NOT implemented in Stage 1):**

1. **Read-only staleness marking.** When an asset list is rendered (Stage 3+),
   check `file_path` existence with expo-file-system. Missing files render a
   "FILE MISSING" chip on the row. Nothing is deleted automatically.
2. **Explicit, confirmed repair.** A per-row "Remove stale entry" action
   deletes **only the index row**, after a confirmation dialog, and never
   touches any file.
3. **No background cleanup jobs, no automatic data migration.** Reconciliation
   is always user-visible and user-triggered, preserving the "fail honestly,
   never silently repair" rule.
4. **Write-side pairing (Stage 3+).** Asset deletion always removes file and
   index row in one operation, so new staleness cannot be introduced.

This proposal needs approval before implementation; it is recorded here and
in `docs/data-exchange.md`.

---

## Reporting back

Append results to `STAGE1_REPORT.md` (section "Hardware verification —
operator results") with device model + Android version, Blender version,
attached logs/screenshots, and the final PASS/FAIL tally. Do not mark any
check PASS without evidence.
