# Video input validation (Stage 3.2)

Every recording is validated **before any frame is decoded**: a job with one
invalid segment fails without extracting anything from any segment.

## What runs

`src/video/video-validate.ts` orchestrates a streamed MP4 box-walk
(`src/video/mp4-probe.ts`) over a chunked random-access view of the file —
no full-file load, works within the 8 GB device budget for any recording
size. The walk reads structure only (box headers, track headers, sample
tables); image data is never touched.

## Facts the probe reads (from the file, never assumed)

| Fact | Source box |
|---|---|
| duration, timescale | `mvhd` / `mdhd` |
| track id, width/height, display matrix (rotation) | `tkhd` |
| edit-list media start + playable segment duration | `elst` |
| codec tag/name | `stsd` sample entry |
| constant vs variable sample durations | `stts` |
| sync (keyframe) sample count | `stss` |
| sample count | `stsz` |

Derived fields: `start_time_s` (edit-list `media_time / track timescale`)
and `playback_duration_s` (edit-list `segment_duration / movie timescale`,
falling back to the media duration when no usable edit list exists).

## Verdicts

`valid` · `valid_with_warnings` · `invalid` · `unsupported_variant` ·
`incomplete` · `not_verified` (only for formats the walker cannot judge —
treated as a failure for extraction). Zero-byte files are `invalid`
(`zero_byte_file`); a recording whose `moov` index box is missing is
`incomplete` — likely cut short or still open.

## Warnings that shape provenance

- `nonzero_media_start` — the edit list starts media at > 0 (every normal
  ffmpeg/h264 file carries a ≈0.067 s delay; a stream-copied cut can start
  at ≈2.57 s). The sampling grid uses the real start; it is never flattened
  to zero.
- `interframe_compression` — few keyframes relative to samples (h264 is
  long-GOP); each extracted frame is a decoded approximation at its seek
  position.
- `variable_frame_rate` — grid positions are requested positions, not
  observed frame times.
- `audio_stream_present` — recorded; audio is never decoded here.
- `rotation_metadata` — a display matrix rotation is recorded; pixels are
  used as the platform renders them.

## Measured fixtures

12 synthetic MP4s with documented exact values
(`tests/fixtures/videos/expected.json`) cover each rule: the recorder's
exact output shape (h264, 60 frames, 2.0 s), audio-carrying, VFR,
nonzero-start (real edit list ≈2.5667 s), rotated (display matrix), HEVC and
MPEG4-Visual codecs, AVI container, truncated (40 % cut), corrupted `moov`,
zero-byte, and audio-only. The expected file documents what the structure
actually is — aspirational values were replaced with measured ones.

## What validation does NOT claim

It cannot verify pixel content, colour fidelity or decoder behaviour — only
container/track structure. A `valid` verdict means "this container declares
a decodable video track"; the per-frame verification (exists, non-empty,
checksummed) is the next gate, and visual correctness is judged by a human
in review.
