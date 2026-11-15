# STAGE 3.2 IMPLEMENTATION REPORT — Frame extraction

**Verdict: PARTIALLY COMPLETE** — the operation is implemented, tested and
registered, but with a platform decoder, not FFmpeg; and nothing has been
verified on a physical device.

## What was built

Frame extraction from Stage 2 segmented recordings:
validate → register job → sample grid → decode → verify → register frames
+ one `frame_set` asset. Timestamp provenance is honest end-to-end
(`pts_ms` null on the platform decoder; `capture_time_mapping` always
`"unavailable"`; sample positions from the real edit-list structure).
Registry v1.5 (`frame_extraction` → IMPLEMENTED, 8 failure modes),
frame-extraction schema v2 (`$defs` + `oneOf`), migration v4
(`frame_extractions`, `frames`), a full Media & Export UI card with frame
review, and seven documents.

## Classification

| Area | Status |
|---|---|
| MP4 probe + video validation (12 real fixtures) | DONE (off-device) |
| Sampling modes `time_interval` / `frame_rate`, `max_frames` cap | DONE (off-device) |
| Extraction pipeline (pure core + 3 injected seams) | DONE (off-device) |
| Platform decoder (`expo-video-thumbnails` + `expo-image-manipulator`) | DONE (code); device behaviour NOT TESTED |
| FFmpeg decoder on device | **NOT AVAILABLE** (ffmpeg-kit retired; native modules not installable here) — `FrameDecoder` seam kept, host FFmpeg CLI proves the pipeline in tests |
| Registration integrity (one txn; failed/cancelled never registered) | DONE (off-device) |
| Crash reconciliation | DONE (off-device) |
| UI (extract card + frame review with honest PTS labels) | DONE (code); device UI NOT TESTED |
| Tests | 170 bun (30 Stage 3.2, incl. real FFmpeg CLI + real SQLite) / 57 Python green; `runChecks` clean |
| Device verification | **NOT RUN** — no device/emulator in this environment |

## Bugs found and fixed during real-fixture testing

1. tkhd track-id offset (12/20, not 20/32) — wrong track could have been read.
2. Display-matrix rotation read the wrong matrix element (b at mOff+4).
3. Edit list parsed before mdhd; elst conversions now happen after the walk
   with raw values carried through; empty edits (media_time −1) skipped.
4. Per-segment frame numbering silently overwrote files across segments →
   job-global `frame_000001.png` counters.
5. `output_exists` guard deleted a pre-existing directory on failure → now
   only pipeline-created directories are removed (`outputCreated` flag).
6. `getExtraction` could not read jobs pre-finalize → `beginExtraction`
   stores the full job in `meta_json`.
7. Playback window now uses the edit-list segment duration
   (`playback_duration_s`), not the raw media duration.
8. Fixture generator produced aspirational structures (output-seek copies
   that were empty; `-display_rotation` on lavfi inputs is a no-op) —
   regenerated with real input-seek cuts and remuxed rotation; expected.json
   documents the measured values (nonzero start ≈2.5667 s).

## Honesty constraints honoured

- No fabricated frames, timestamps, versions or success states; PTS only
  from a decoder that reports it; decoder identity recorded from the real
  implementation (`ffmpeg_version: null` on device).
- Failed extractions never register as assets; originals never modified;
  per-job outputs never overwritten; cancellation is a distinct outcome.

## Blockers (unchanged)

- On-device end-to-end (record → extract → review) needs a physical device.
- FFmpeg on device is unavailable as described in
  `docs/ffmpeg-integration.md`; the offline-desktop FFmpeg decoder remains a
  future path through the existing seam.

## Files

- Core: `src/frame/{models,sampling,extraction-core,extraction-service}.ts`,
  `src/video/{mp4-probe,video-validate}.ts`
- Data: `src/database/{frame-repository,migrations,repo-db,capture-repository}.ts`
- Contracts: `schemas/frame-extraction.schema.json` (v2),
  `schemas/operations.registry.json` (v1.5), `src/engine/operations.ts`
- UI: `app/(tabs)/export.tsx`
- Tests: `tests/mobile/frame-extraction.test.ts`,
  `tests/mobile/helpers/extraction-host.ts`,
  `tests/fixtures/videos/` (12 fixtures + generator + expected.json)
- Docs: this report + `docs/stage3.2-frame-extraction.md`,
  `video-input-validation.md`, `frame-timestamp-provenance.md`,
  `frame-storage.md`, `ffmpeg-integration.md`, `stage3.2-test-results.md`;
  README, PLAN, data-exchange updated.
