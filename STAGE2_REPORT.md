# STAGE 2 REPORT — Capture & registration

Scope: implement **real, offline capture** on the mobile app — genuine
camera video and genuine motion-sensor samples, honest capability probing, a
reliable capture-session lifecycle, local file storage with timestamps and
provenance — with no SLAM, point clouds, meshing or mining analysis. Tracking
was evaluated and is deliberately **NOT IMPLEMENTED**
(`docs/tracking-evaluation.md`). Stage 3 was not started.

## What was built

### Capture core (all new)

| File | Role |
|---|---|
| `src/models/capture.ts` | Stage 2 zod contracts: dual-clock timestamp pairs, capture config (muted, segmented), camera recordings, sensor streams/samples, capture manifest, tracking status (all `NOT_IMPLEMENTED`). Pure TS, testable off-device. |
| `src/capture/session-machine.ts` | Pure, exhaustive lifecycle state machine (idle→preparing→ready→capturing↔paused→stopping→stopped, plus failed/aborted). `stopped` is reachable only via a real stop. |
| `src/capture/time.ts` | `captureTimestamp()` pairs wall clock + monotonic clock at one instant; durations derive from the monotonic clock only. |
| `src/capture/manifest.ts` | Manifest validation, read-only index reconciliation (marks missing files; never auto-deletes), interruption warnings. |
| `src/capture/recorder.ts` | `CaptureRecorder`: free-space gate → DB begin → session dirs → segmented muted recording via `CameraView.recordAsync` (≤ 60 s chunks) → batched, zod-validated sensor JSONL (flush at 20 samples / 2 s) → checksums + asset rows → manifest rewritten atomically after every phase change. Auto-pauses on app backgrounding (interruption recorded). |
| `src/storage/session-store.ts` | Session directory tree (`projects/{project}/sessions/{session}/…`), refuse-existing-session rule, atomic JSON writes (tmp + rename), streaming JSONL appender (constant memory), filesystem MD5, 200 MB free-space gate. |

### Probing & persistence

- `src/services/capabilities.ts` — rewritten: real probes via
  `CameraView.isAvailableAsync`, `getCameraPermissionsAsync` (granted / ask-again /
  permanently-denied) and `isAvailableAsync` on all three expo-sensors.
  Five explicit states (`AVAILABLE / UNAVAILABLE / PERMISSION_DENIED /
  UNKNOWN / NOT_IMPLEMENTED`); depth stays NOT_IMPLEMENTED — no reliable Expo
  probe, never assumed.
- `src/database/migrations.ts` — migration **v2**: `capture_sessions`
  satellite table (phase, config JSON, dual-clock start/end, active
  duration, interruption count, last error) + two indexes. Stage 1 tables
  and rows untouched.
- `src/database/capture-repository.ts` — lifecycle SQL with the
  **single-active-capture guard** (SQL check inside the begin transaction),
  phase updates that keep `scan_sessions.status` in sync, asset-index rows
  for every finalized file, per-project summaries for the dashboard.
- `src/models/models.ts` — `sensorCapabilitySchema` extended to **v1.1**
  (optional per-hardware capability states; v1 records still validate).

### Screens (Expo Router, 4 tabs preserved)

- **Live Scan** (`app/(tabs)/scan.tsx`) — rewritten: real `CameraView`
  preview (back camera, muted, 720p), permission flow including the
  permanently-denied state, project chips, phase-gated
  Start/Pause/Resume/Stop, 1 Hz measured counters (elapsed from monotonic
  math, segment count, per-sensor sample counts), explicit Stage 2
  limitations card. No simulated viewfinders.
- **Projects** (`app/(tabs)/index.tsx`) — real session counts, latest
  capture status and stored bytes per project; distinguishes "no capture
  recorded yet" from captured state.
- **Review** (`app/(tabs)/review.tsx`) — per-session capture provenance:
  phase, active duration (monotonic basis), interruption count, video
  segment / sensor stream counts, bytes on disk, per-stream sample counts,
  last error. 3D viewer remains an honest placeholder.
- **Media & Export** (`app/(tabs)/export.tsx`) — real stored-asset list
  (live view of the asset index: id, kind, bytes, sample counts, stint);
  export/import pipelines stay PLANNED and no file is written by this screen.

### Contracts, docs, tests

- **5 new JSON Schemas** (draft 2020-12): `capture-config`,
  `camera-recording`, `sensor-stream`, `capture-manifest`,
  `tracking-status` (all fields `NOT_IMPLEMENTED` by literal). **1 revised**:
  `sensor-capability` → **v1.1** (optional capability-state fields; v1
  fields kept).
- **New docs**: `docs/capture-pipeline.md` (units, storage layout, timestamp
  synchronization rules, JSONL format, segment lifecycle, honest limitation
  list), `docs/tracking-evaluation.md` (candidate evaluation; conclusion
  NOT_IMPLEMENTED + criteria for reopening).
- **Updated docs**: `docs/architecture.md` (Stage 2 components, data flow,
  what is still missing), `docs/hardware-verification.md` (new Part 1b:
  A12–A25 device checklist for capture, plus iOS notes).
- `README.md` updated (status, run commands, test counts, dependency list).

## Test results (executed in the sandbox)

- `bun test tests/mobile` — **50/50 pass**, 0 fail
  (new `tests/mobile/capture.test.ts`: timestamps, config defaults & limits,
  recording/stream/sample contracts, state machine transitions incl.
  terminality and illegal transitions, manifest validation + read-only
  reconciliation, v1.1 capability states, and migration v2 against real
  `bun:sqlite` — including the single-active-capture guard and FK ordering).
- `python3 -m unittest discover -s tests/python` — **12/12 pass**
  (updated for the 11-schema set and the v1.1 title revision).
- `runChecks` (typecheck + lint + structure) — **passes clean**.

### Bugs found and fixed during Stage 2 verification

1. **Module-load crash**: `captureConfigSchema` required `schema_version` at
   the top level, so `parse({})` (and thus importing `capture.ts`) threw.
   Fixed: `schema_version` defaults to 1; config schemas are now strict
   (unknown keys rejected rather than stripped).
2. **Nested defaults bug**: zod's `.default({})` bypasses inner defaults —
   `camera`/`sensors` would have stored as empty objects. Fixed with
   fully-parsed default objects.
3. **FK-order bug in `captureRepository.begin()`**: inserted
   `capture_sessions` before its parent `scan_sessions` row — would have
   failed on device with foreign keys ON. Fixed (parent first, same
   transaction); regression test added.

## Not tested here (honest gaps)

The sandbox has **no physical device, no Android emulator, no Xcode, and no
Blender binary**. The following are recorded as **NOT TESTED / BLOCKED** and
belong on the operator machine per `docs/hardware-verification.md`:

- Real camera recording, sensor subscriptions, pause/resume boundaries,
  backgrounding auto-pause, checksums and manifests on-device (A14–A18).
- Permission flows on real Android/iOS (A13, iOS notes).
- Offline release-build capture (A21).
- Low-storage gate behaviour with genuinely low storage (A20).
- Blender side: unchanged in Stage 2; Stage 1 checks (B1–B11) remain.
- Web preview: deliberately unsupported (SQLite/camera are native; the app
  shows an honest error state there by design).

## Deliberate limitations (also stated in the UI)

- No raw frame streaming (Expo's managed camera cannot; native module would
  be required — documented in `docs/tracking-evaluation.md`).
- No audio recording, ever (schema literal `mute: true`).
- Camera segments' exact per-frame exposure timestamps are unavailable
  through Expo; alignment is bounded by segment start/stop moments.
- Asset-index reconciliation remains a documented, approved-pending proposal
  (read-only "FILE MISSING" marking) — not implemented.
- Tracking/registration: NOT IMPLEMENTED (see `docs/tracking-evaluation.md`).

## Stage gate

Stage 2 is complete to this scope. **Stopping here** — Stage 3 (mesh
reconstruction & tunnel geometry) will not start without explicit approval.
