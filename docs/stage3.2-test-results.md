# Stage 3.2 test results

Environment: Linux sandbox (no Android/iOS device or emulator). What could
and could not be verified is separated honestly.

## Bun suite — 170 tests, 0 failures (`bun test tests/mobile`)

Of these, **30 are the Stage 3.2 frame-extraction suite**
(`tests/mobile/frame-extraction.test.ts`), which runs the REAL pipeline —
real `bun:sqlite`, real node fs, and a decoder that shells out to a **real
FFmpeg 7.1 CLI** — over **12 real generated MP4 fixtures** whose exact
structure is documented in `tests/fixtures/videos/expected.json`.

### Video validation against real fixtures (12)

- `valid_h264.mp4` — the recorder's exact output shape validates `valid`,
  with the honest 0.0667 s nonzero media start (ffmpeg's h264 initial
  delay) and a genuine `interframe_compression` warning (1 keyframe of 60
  samples) → `valid_with_warnings`.
- `valid_h264_with_audio.mp4` — audio is a warning, never an error.
- `vfr.mp4` — variable frame rate warns and states the provenance
  consequence.
- `nonzero_start.mp4` — real edit list (media_time 39424/15360 ≈ 2.5667 s
  from a stream-copied cut at 2.5 s) reported as `start_time_s`; the grid
  starts there, never at 0.
- `rotated.mp4` — display-matrix rotation (remuxed with
  `-display_rotation 270`, matrix reads +90°) recorded as a warning.
- `unsupported_hevc.mp4`, `unsupported_mpeg4.mp4` — real MP4s, unsupported
  codecs → `unsupported_variant`.
- `unsupported_container.avi` — named-container rejection.
- `truncated.mp4` — 40 % cut file is never valid/valid_with_warnings.
- `corrupted_moov.mp4` — parse failure → `invalid` (`video_unreadable`),
  never silent.
- `zero_byte.mp4` → `invalid` / `zero_byte_file`.
- `audio_only.mp4` → no video stream → `invalid`.

### Sampling grid (7)

interval and fps grids from media start; edit-list start honoured;
`max_frames` cap truncates with an explicit warning; rate-deviation edge
warning; zero duration → empty grid; zero-padded file names (lexicographic
order == index order).

### Extraction lifecycle — real ffmpeg + real SQLite (7)

- **Success, multi-segment**: verified frames in `frames` +
  `frames.jsonl`, ONE `frame_set` assets row, `done` flips in one
  transaction; job-global file numbering across segments (per-segment
  numbering would have silently overwritten files — a bug found and fixed
  by these tests).
- **PTS-reporting decoder**: records PTS + `pts_decode` while
  `capture_time_mapping` stays `"unavailable"`.
- **Validate-before-decode**: one unsupported segment aborts before ANY
  decode.
- **Cancel between frames**: nothing registered, pipeline-created directory
  removed.
- **All frames fail** → `empty_extraction`, no asset.
- **`output_exists` guard**: a pre-existing per-job directory is never
  overwritten — and never deleted either.
- **`insufficient_storage`**, **`segment_missing`**, **crash
  reconciliation** (`running → interrupted`, no asset appears).

### Registry + settings contract (2)

`frame_extraction` IMPLEMENTED (exactly two Stage 3 ops are, with the
3.2 failure modes); zod settings rules (jpeg requires explicit quality; png
rejects it).

## Python suite — 57 tests, 0 failures

Schema conventions (draft 2020-12, `$id`, versioned titles; `frame-extraction`
v2's `$defs` + `oneOf` multi-record layout accepted), operation registry
mirror + honesty (`frame_extraction` claims IMPLEMENTED with its failure
modes), and the Stage 3.1 Blender add-on modules (`ply_parser`,
`asset_meta`) now exist and pass their suite.

## Static checks

`runChecks` (TypeScript strict + lint + structure) passes for the
`mining-scanner` app.

## NOT verified here — needs a device

- Real decode on Android/iOS: `expo-video-thumbnails` behaviour (seek
  accuracy, orientation rendering, format support per OS) is the platform's;
  no emulator exists in this sandbox.
- Thumbnail display in the frame review list on device.
- Performance (long segments, `max_frames` 1000) and storage gating on real
  hardware.

Per the Stage 3.0 policy, device verification is a deferred acceptance
requirement before phone-derived results can be trusted as validated mining
data — it is not a prerequisite for the software itself, which is tested
end-to-end against real fixtures and a real FFmpeg CLI off-device.
