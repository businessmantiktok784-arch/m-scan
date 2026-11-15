# Stage 3.2 — Frame extraction from recorded video

Status: **IMPLEMENTED (software scope)** — `frame_extraction` is marked
IMPLEMENTED in the operation registry (v1.5). Verification on a physical
device has NOT been done in this environment (see
[stage3.2-test-results.md](stage3.2-test-results.md)).

Stage 3.2 turns the Stage 2 segmented camera recordings into reviewable
frames — the input later stages need for calibration, tracking and
reconstruction. Every frame carries provenance of *where* it was sampled
from and *how* its timestamp was (or was not) established. Nothing is ever
fabricated: a failed, cancelled or interrupted job registers no asset.

## The honest decoder situation, up front

FFmpeg is **not integrated** on device — native modules cannot be installed
in this environment and ffmpeg-kit itself was retired upstream. Frames are
decoded by the phone's own media framework (`expo-video-thumbnails`:
MediaMetadataRetriever on Android, AVAssetImageGenerator on iOS) and
converted with `expo-image-manipulator`. Consequences, stated everywhere the
data is produced:

- decoding is seek-based (`extraction_method: "seek_decode"`);
- the platform API does not report the decoded frame's presentation
  timestamp, so `pts_ms` and `time_base` stay **null**;
- `capture_time_mapping` is `"unavailable"` — media time is never claimed to
  be wall-clock capture time.

A full `FrameDecoder` seam exists so a genuine FFmpeg decoder can be plugged
in later without touching pipeline logic (see
[ffmpeg-integration.md](ffmpeg-integration.md)).

## Pipeline (one implementation, three injected seams)

`runExtraction` in `src/frame/extraction-core.ts` is pure orchestration. File
access (`ExtractionIo`), decoding (`FrameDecoder`) and the database
(`RepoDb`) are injected, so the identical pipeline runs on device and in
bun tests against a real FFmpeg CLI.

1. **Preflight** — the per-job output directory must not already exist
   (`output_exists`; a pre-existing directory is never deleted or
   overwritten), and free storage must cover 200 MB headroom plus a
   worst-case estimate (`max_frames × sources × 8 MiB` per frame,
   `insufficient_storage`).
2. **Validate EVERY source before any decode** — a streamed MP4 box-walk
   (see [video-input-validation.md](video-input-validation.md)). One invalid
   segment fails the whole job before a single frame is decoded
   (`video_unreadable`, `segment_missing`, `no_video_stream`, …).
3. **Register the job** — `processing_operations` + `frame_extractions`
   rows (status `running`) are written, with the full job record in
   `meta_json`, before any output bytes exist. A crash is reconciled to
   `interrupted` on next launch.
4. **Extract** — per segment, a sampling grid of explicit seek positions in
   source media time (see below). Each decoded image is **verified** before
   registration: file exists, non-zero bytes, MD5 checksum computed. A frame
   that fails any check is counted in `frames_failed` and recorded in the
   job errors — never registered as a frame.
5. **Finalize** — `extraction.json` (job record) and `frames.jsonl`
   (one JSON line per frame) written atomically, then in **one transaction**:
   the `assets` row (kind `frame_set`, asset_id = job_id) plus the
   `extraction_status → 'done'` flips. Until that transaction commits,
   nothing about the job is registered as an asset.

## Sampling modes

Both modes compute an explicit list of seek positions (`computeSampleGrid`),
capped by `max_frames` (default 1000) with an explicit warning when the cap
truncates — silent truncation is impossible.

- `time_interval` — first frame at the track's media start (from the edit
  list), then every `interval_s`.
- `frame_rate` — every `1 / target_fps` step. The grid positions are what
  provenance records; the nominal rate is never presented as the actual
  frame timing of a (possibly variable-rate) source.

The grid starts at the **edit-list media start**, not at zero: every normal
ffmpeg/h264 recording carries a small initial delay (e.g. 1024/15360 ≈
0.0667 s), and a nonzero start (e.g. a stream-copied cut at ≈2.5667 s) is
reported as `start_time_s` and used as the grid origin — never flattened to
zero. The playable window is the edit list's segment duration
(`playback_duration_s`), not the raw media duration.

## Output layout (per job, never overwritten)

```
projects/<MS-xxxx>/sessions/<SES-xxxx>/frames/<JOB-xxxx>/
├── frames/       frame_000001.png, frame_000002.png, … (numbering is
│                 job-global — segments share this directory)
├── metadata/     extraction.json (job record), frames.jsonl (frame records)
└── logs/         extraction-log.json (decoder identity, settings, timings,
                  warnings, errors)
```

`frames.jsonl` is the portable record; the SQLite `frames` table mirrors it
(see [frame-storage.md](frame-storage.md)).

## Failure modes (registry v1.5)

`video_unreadable`, `segment_missing`, `decode_error`, `no_video_stream`,
`empty_extraction`, `output_exists`, `insufficient_storage`,
`registration_failed`. Cancellation is a distinct outcome; failure and
cancel both remove only directories the pipeline itself created.

## UI

The Media & Export tab has an **Extract frames** card: session picker →
segment multi-select → mode + format (PNG / JPEG with explicit quality) →
stage + progress + cancel. Registered frame sets appear as expandable asset
rows showing the real stored frames (thumbnail, index, sample time, size)
with the honest line: *pts: not reported by the decoder — sample position
only*.

## Out of scope

Calibration, tracking, reconstruction and everything downstream — still
NOT_IMPLEMENTED in the registry. Frame extraction produces inputs; it
consumes only Stage 2 recordings.
