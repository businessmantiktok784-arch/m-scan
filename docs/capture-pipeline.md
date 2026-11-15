# Capture pipeline — Stage 2

How Stage 2 records real data: what is captured, where it is stored, how it
is timestamped, and what is deliberately not done. Nothing in this pipeline
fabricates a frame, a sample or a measurement.

## What Stage 2 captures

| Signal | Source | Output | Notes |
|---|---|---|---|
| Camera video | Device back camera via expo-camera (`CameraView.recordAsync`) | MP4 segments, ≤ 60 s each, **muted** | Audio is never recorded (no microphone permission, no mic data). |
| Accelerometer | expo-sensors (`Accelerometer`) | JSONL stream, requested 50 Hz | Units: **g** (1 g = 9.80665 m/s²), device frame. |
| Gyroscope | expo-sensors (`Gyroscope`) | JSONL stream, requested 50 Hz | Units: **rad/s**, device frame. |
| Magnetometer | expo-sensors (`Magnetometer`) | JSONL stream, requested 10 Hz | Units: **µT**, device frame. Optional; recorded only if the probe says AVAILABLE. |
| Depth / LiDAR | — | — | **NOT IMPLEMENTED.** No reliable Expo probe exists; presence is never assumed. |

The requested sensor interval is what the OS is asked for. The *achieved*
interval is measured per sample (`delta_ms` in each JSONL line) and is never
assumed equal to the request.

## Timestamp synchronization rules

Every recorded event carries **both** clocks (see `src/capture/time.ts`):

- `epoch_ms` — wall clock (`Date.now()`), ms since Unix epoch UTC. Subject to
  OS and user clock changes. Used for **provenance only** (when did this
  happen in the world).
- `monotonic_ms` — device monotonic clock (`performance.now()` origin), ms
  since an arbitrary point. Never jumps backwards within a boot. Used for
  **all durations and within-session alignment**.

Rules:

1. **Durations** (active capture time, segment length, sample deltas) are
   computed from `monotonic_ms` only — never from `epoch_ms`.
2. **Cross-stream alignment** (camera segments ↔ sensor streams) uses the
   `monotonic_ms` captured when each recording/subscription starts and stops.
3. The two clocks are **never assumed synchronized** with each other, and
   clock resets (reboot, user time change) affect only `epoch_ms`.
4. Sessions never span a reboot: app interruption is caught via `AppState`
   and marks the session **paused**, with a warning in the manifest.
5. `monotonic_source` names the monotonic implementation. A future native
   module could provide a different source; consumers must check the field.

## Storage layout

Relative to the app's document directory (`Paths.document`):

```
projects/
  {project_id}/
    sessions/
      {session_id}/
        session.json     scan-session record (zod-validated on write)
        manifest.json    capture manifest (atomic write, updated after every phase change)
        camera/          segment-0001.mp4, segment-0002.mp4, …
        sensors/         accelerometer-001.jsonl, gyroscope-001.jsonl, …
        logs/            session-log.txt
```

Rules:

- **Never overwrite.** `ensureSessionDirectories` throws if the session
  directory already exists; a failed session leaves its files in place and is
  marked `failed` — it is not retried into the same directory.
- **Atomic writes.** JSON files are written to a `.tmp` sibling and renamed
  into place. A crash leaves either the old file or the new one.
- **Metadata only in the DB.** The `capture_sessions` table (migration v2)
  stores the lifecycle phase, timestamps, active duration, interruption count
  and last error. The `assets` table indexes every camera segment and sensor
  stream (path, byte size, checksum, metadata). No media bytes in SQLite.
- **Checksums.** Each finalized file's MD5 is computed by the filesystem
  after the write handle is closed.
- **Free-space gate.** A capture cannot start unless ≥ 200 MB is free
  (`MIN_FREE_BYTES`). Space is checked at prepare time; the check result is
  recorded, and an inability to check is treated as unknown, not as "fine".
- **Single active capture.** At most one capture session may be in an active
  phase (`preparing/ready/capturing/paused/stopping`), enforced by an SQL
  check inside the transaction that creates the session.

## Sensor JSONL format

One JSON object per line, one file per sensor per stint (pause/resume opens a
new file so a pause is always a clean file boundary):

```json
{"kind":"accelerometer","t":{"epoch_ms":1735689600123,"monotonic_ms":45230.5,"monotonic_source":"performance.now"},"axes":{"x":0.01,"y":-0.02,"z":-1.00},"delta_ms":20}
```

- `axes` are finite floats in the documented unit for the kind.
- `delta_ms` is the measured interval to the previous accepted sample of the
  same stream (`null` for the first sample of a stint).
- Samples are zod-validated before they are written; a malformed reading is
  dropped and counted, never silently coerced into a number.
- Writes are batched (flush at 20 samples or 2 s) through a file handle in
  append mode — constant memory, no large in-memory frame collections.

## Camera segment lifecycle

1. `recordAsync({ maxDuration })` starts a segment (≤ 60 s) into the OS cache.
2. On segment end (duration reached, operator stop, or pause), the file is
   moved synchronously from the cache into the session's `camera/` directory.
3. The filesystem's MD5 and byte size are read, and an `assets` row is added.
4. The manifest is rewritten atomically (updated last, after the data exists).

`duration_s`, `width_px` and `height_px` are recorded **only when the OS
reports them** (`null` otherwise). Durations are never estimated from file
size or segment budget.

## Manifest

`manifest.json` per session (schema: `schemas/capture-manifest.schema.json`)
records the config, final state, dual timestamps, cumulative active duration,
every interruption (reason + what the session did next), the recording and
stream ids, and a warnings array — written even when empty. A session that
ended abnormally is never marked `stopped`; the DB and manifest agree on this
via the same state machine (`src/capture/session-machine.ts`).

## Known limitations (honest list)

- **No raw frame streaming.** Expo's managed camera API cannot deliver raw
  frames at SLAM-relevant rates. Stage 2 records compressed segments only; a
  future native module is required for frame-level access (see
  `docs/tracking-evaluation.md`).
- **Clock domains.** Camera segment timing comes from OS callbacks; the exact
  exposure timestamps of individual frames are not available through Expo.
  Alignment precision is therefore bounded by segment start/stop moments.
  Stage 2.1 consequence, written into the reconstruction contracts
  (`schemas/frame-extraction.schema.json`): extracted frames carry **video
  presentation timestamps** (`pts_ms`), and per-frame wall-clock capture time
  stays `null` unless independently established. Nothing may interpolate an
  exposure time from frame rate and present it as measured.
- **No asset-index auto-repair.** If a file is deleted outside the app, the
  index is marked stale and shown as "FILE MISSING"; nothing is auto-deleted
  (see `docs/hardware-verification.md`, Part 3).
